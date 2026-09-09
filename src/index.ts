import { getCommands, getModalSubmits, getMongoClient } from "@/utils.ts";
import type { DiscordClient } from "@/interface.ts";
import "dotenv/config";
import {
  ActivityType,
  Client,
  Collection,
  Events,
  GatewayIntentBits,
  MessageFlags,
  PresenceUpdateStatus,
} from "discord.js";

async function main() {
  // Setup initial connection with the database
  await getMongoClient();

  // Init the Discord client from the token
  const discordClient = new Client({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.DirectMessages],
  }) as DiscordClient;

  discordClient.commands = new Collection();
  for (const command of await getCommands()) {
    discordClient.commands.set(command.data.name, command);
  }

  discordClient.modalSubmits = new Collection();
  for (const modal of await getModalSubmits()) {
    discordClient.modalSubmits.set(modal.customId, modal);
  }

  discordClient.cooldowns = new Collection();

  discordClient.once(Events.ClientReady, (readyClient) => {
    // Upon startup, set the bot to be online
    if (discordClient.user) {
      discordClient.user!.setPresence({
        activities: [
          { name: "Provisioning API key...", type: ActivityType.Custom },
        ],
        status: PresenceUpdateStatus.Online,
      });
    } else {
      console.error("[STARTUP] Bot wasn't set online upon startup...");
    }
    console.log(`[STARTUP] Logged in as ${readyClient.user.tag}`);
  });

  // Executing the slash commands
  discordClient.on(Events.InteractionCreate, async (interaction) => {
    if (!interaction.isChatInputCommand()) return;

    // User can only requests key in #api-key-request
    const channelId = process.env.CHANNEL_ID;
    if (!channelId) {
      throw new Error("Undefined CHANNEL_ID");
    }
    if (!interaction.inGuild() || interaction.channelId !== channelId) {
      await interaction.reply({
        content: `This command can only be used in <#${channelId}>`,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    const discordClient = interaction.client as DiscordClient;
    const commandName = interaction.commandName;
    const command = discordClient.commands.get(commandName);
    const commandCooldowns = discordClient.cooldowns;

    if (!command) {
      console.error(`[ERROR] Command ${commandName} not found!`);
      return;
    }

    try {
      console.log(
        `[REQUEST] User ${interaction.user.username}/(${interaction.user.id}) requests /${commandName}`,
      );

      // Cooldown logic
      let timestamps = commandCooldowns.get(command.data.name);

      if (!timestamps) {
        timestamps = new Collection<string, number>();
        commandCooldowns.set(command.data.name, timestamps);
      }

      const now = Date.now();
      const userId = interaction.user.id;
      const expirationTime = timestamps.get(userId);

      if (expirationTime && now < expirationTime) {
        const expiredTimestamp = Math.round(expirationTime / 1000);

        return interaction.reply({
          content: `Please wait, you are on a cooldown for \`${command.data.name}\`. You can use it again <t:${expiredTimestamp}:R>.`,
          flags: MessageFlags.Ephemeral,
        });
      }

      const cooldownAmount = (command.cooldown ?? 30) * 1000;
      timestamps.set(userId, now + cooldownAmount);

      const bot = interaction.client.user;
      // If the bot is offline, user can't command it except for admin waking it up
      if (commandName !== "wake" && bot.presence.status !== "online") {
        const user = interaction.user;
        await interaction.reply({
          content: `Hello <@${user.id}>! I'm currently offline, please comeback later.`,
          flags: MessageFlags.Ephemeral,
        });
        return;
      }
      await command.execute(interaction);
    } catch (error) {
      console.error(`[ERROR] Error while executing /${commandName}:`, error);
      await interaction.reply({
        content: "Error while executing this command!",
        flags: MessageFlags.Ephemeral,
      });
    }
  });

  // Executing the modal submit interactions
  discordClient.on(Events.InteractionCreate, async (interaction) => {
    if (!interaction.isModalSubmit()) return;

    const interactionClient = interaction.client as DiscordClient;
    const customId = interaction.customId;
    const modalSubmit = interactionClient.modalSubmits.get(customId);
    if (!modalSubmit) {
      console.error(`[ERROR] Modal ${customId} not found!`);
      return;
    }

    try {
      // Modal only pops up after slash command's execution which will not be executed when bot is offline,
      // no need to check for bot's status.
      console.log(
        `[REQUEST] User ${interaction.user.username}/(${interaction.user.id}) submits ${customId}`,
      );
      await modalSubmit.execute(interaction);
    } catch (error) {
      console.error(`[ERROR] Error while executing modal ${customId}:`, error);
      await interaction.reply({
        content: "Error while executing this modal submit!",
        flags: MessageFlags.Ephemeral,
      });
    }
  });

  const discordToken = process.env.DISCORD_TOKEN;
  if (!discordToken) {
    throw new Error("Undefined DISCORD_TOKEN");
  }
  discordClient.login(discordToken);
}

try {
  await main();
} catch (err) {
  console.error(`[ERROR] Error starting up the bot: ${err}`);
  process.exit(1);
}
