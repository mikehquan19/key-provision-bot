import {
  LabelBuilder,
  ModalBuilder,
  SlashCommandBuilder,
  TextInputBuilder,
  TextInputStyle,
} from "discord.js";
import "dotenv/config";
import type { Command } from "@/interface.ts";
import { getKeyProvisionCollection } from "@/utils.ts";
import CryptoJS from "crypto-js";

/**
 * Build the form asking for project's usage of the API
 * @returns {ModalBuilder}
 */
function buildRequestKeyForm(): ModalBuilder {
  const nameInput = new TextInputBuilder()
    .setCustomId("projName")
    .setStyle(TextInputStyle.Short)
    .setPlaceholder("Mars, Milky Way, WHL0137-LS, etc.")
    .setRequired(true);

  const nameLabel = new LabelBuilder()
    .setLabel("What is your project's name?")
    .setDescription("Anything! It's used for naming your API key.")
    .setTextInputComponent(nameInput);

  const descriptionInput = new TextInputBuilder()
    .setCustomId("projDescription")
    .setStyle(TextInputStyle.Paragraph)
    .setRequired(false);

  const checkboxGroupLabel = new LabelBuilder()
    .setLabel("What are you using this API for?")
    .setCheckboxGroupComponent((checkboxes) =>
      checkboxes.setCustomId("apiPurpose").addOptions([
        {
          label: "Personal Project",
          value: "personal",
          description: "Building something for myself or portfolio",
          default: false,
        },
        {
          label: "Hackathon Project",
          value: "hackathon",
          description: "Building for a competition or hackathon event",
          default: false,
        },
        {
          label: "Class Assignment",
          value: "classwork",
          description: "School/university project or coursework",
          default: false,
        },
        {
          label: "Learning/Educational",
          value: "learning",
          description: "Just learning how APIs work",
          default: false,
        },
        {
          label: "Testing the API",
          value: "testing",
          description: "For API developers/members testing functionality",
          default: false,
        },
      ]),
    );

  const descriptionLabel = new LabelBuilder()
    .setLabel("Give us a short description")
    .setDescription(
      "Tell us more! We would love to hear more details on how you are using our API. (Optional)",
    )
    .setTextInputComponent(descriptionInput);

  const requestKeyForm = new ModalBuilder()
    .setCustomId("requestKeyForm")
    .setTitle("Request API Key Form");

  requestKeyForm.addLabelComponents(
    nameLabel,
    checkboxGroupLabel,
    descriptionLabel,
  );

  return requestKeyForm;
}

/**
 * Decrypt the key stored in DB into the actual API key
 */
function decryptAPIKey(dbKey: string): string {
  const encryptionKey = process.env.ENCRYPTION_KEY;
  if (!encryptionKey) {
    throw new Error("Undefined ENCRYPTION_KEY");
  }

  const apiKey = CryptoJS.AES.decrypt(dbKey, encryptionKey).toString(
    CryptoJS.enc.Utf8,
  );
  return apiKey;
}

/**
 * Check if this user has a provisioned key and returns the key.
 * Otherwise, returns an empty string.
 */
async function checkExistingKey(userId: string): Promise<string | null> {
  const collection = await getKeyProvisionCollection();

  const doc = await collection.findOne({ userId: userId });
  if (!doc) {
    return null;
  }
  return decryptAPIKey(doc.encryptedKey);
}

/**
 * Responding to user's command requesting the key
 */
const requestKeyCommand: Command = {
  cooldown: 120,
  data: new SlashCommandBuilder()
    .setName("request-key")
    .setDescription("Request the Nebula API key"),
  async execute(interaction) {
    const user = interaction.user;
    const existingKey = await checkExistingKey(user.id);
    if (existingKey) {
      console.log(`[PROVISION] Existing key found for user ${user.username}`);
      await user.send(
        `You have been provisioned a key. Your key is ||${existingKey}||. If you have any question, please DM Mike.`,
      );
      return;
    }
    await interaction.showModal(buildRequestKeyForm());
  },
};

export default requestKeyCommand;
