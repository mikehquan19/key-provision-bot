import { ModalSubmitInteraction } from "discord.js";
import { GoogleAuth } from "google-auth-library";
import "dotenv/config";
import { KeyProvision, ModalSubmit } from "@/interface.ts";
import { getKeyProvisionCollection } from "@/utils.ts";
import { randomBytes } from "node:crypto";
import CryptoJS from "crypto-js";

/**
 * Encrypt the provisioned API key using AES-256 algorithm
 */
function encryptAPIKey(apiKey: string): string {
  const encryptionKey = process.env.ENCRYPTION_KEY;
  if (!encryptionKey) {
    throw new Error("Undefined ENCRYPTION_KEY");
  }

  const dbKey = CryptoJS.AES.encrypt(apiKey, encryptionKey);
  return dbKey.toString();
}

type APIConfig = {
  baseUrl: string;
  projectId: string;
  service: string;
  accessToken: string;
};

/**
 * Get config for API calling, including URL, project's ID, service, token.
 */
async function getAPIConfig(): Promise<APIConfig> {
  const baseUrl = `https://apikeys.googleapis.com/v2`;

  const projectId = process.env.NEBULA_API_PROJECT_ID;
  if (!projectId) {
    throw new Error("Undefined NEBULA_API_PROJECT_ID");
  }
  const service = process.env.NEBULA_API_SERVICE;
  if (!service) {
    throw new Error("Undefined NEBULA_API_SERVICE");
  }

  let accessToken: string;
  const auth = new GoogleAuth({
    scopes: "https://www.googleapis.com/auth/cloud-platform",
  });
  try {
    // The token is cached, so we can call function multiple times and still get same token
    const client = await auth.getClient();
    const response = await client.getAccessToken();
    if (!response.token) {
      throw new Error("Undefined access token");
    }
    accessToken = response.token;
  } catch (error) {
    throw new Error("Error getting access token", { cause: error });
  }

  return {
    baseUrl,
    projectId,
    service,
    accessToken,
  } as APIConfig;
}

/**
 * Create new key in Google Cloud
 *
 * Refer to https://docs.cloud.google.com/api-keys/docs/create-manage-api-keys on how to create Google Cloud API key through REST
 */
async function prodCreateKey(
  username: string,
  project: string,
): Promise<string> {
  const { baseUrl, projectId, service, accessToken } = await getAPIConfig();

  // Define the display name and restrict the key to only use Nebula API
  const body = {
    displayName: `${username}/${project}`,
    restrictions: {
      api_targets: [
        {
          service: service,
        },
      ],
    },
  };
  let response = await fetch(
    `${baseUrl}/projects/${projectId}/locations/global/keys`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        Authorization: `Bearer ${accessToken}`,
        "x-goog-user-project": projectId,
      },
      body: JSON.stringify(body),
    },
  );
  if (!response.ok) {
    throw new Error(`HTTP error ${response.status} creating key!`);
  }
  const data = await response.json();
  const operation: string = data.name;

  // Poll the operations until user gets the key
  let keyDetails: any = {};
  let attempt = 0;
  while (!("done" in keyDetails && keyDetails.done === true)) {
    if (attempt > 0) {
      // Start waiting from the second attempt
      await new Promise((r) => setTimeout(r, 5000));
    }

    response = await fetch(`${baseUrl}/${operation}`, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "x-goog-user-project": projectId,
      },
    });
    if (!response.ok) {
      throw new Error(`HTTP error ${response.status} polling key!`);
    }
    keyDetails = await response.json();
    attempt++;
  }

  return keyDetails.response.keyString;
}

/**
 * Test version of `createKey`, used in dev environment to avoid hitting GCloud.
 * This just generates random key.
 */
async function devCreateKey(): Promise<string> {
  const GCLOUD_KEY_BYTES = 36;
  return randomBytes(GCLOUD_KEY_BYTES).toString("hex");
}

/**
 * Create new key in Google Cloud, encrypt the created key, and store key's info into Mongo DB
 */
async function createAndPersistKey(
  userId: string,
  username: string,
  project: string,
  description: string,
  apiPurpose: readonly string[],
): Promise<string> {
  const createdKey =
    process.env.USE_GCLOUD === "true"
      ? await prodCreateKey(username, project)
      : await devCreateKey();

  // Save the provision record to the database
  const collection = await getKeyProvisionCollection();
  const doc = {
    userId: userId,
    username: username,
    project: project,
    description: description,
    encryptedKey: encryptAPIKey(createdKey),
    apiPurpose: apiPurpose,
  } as KeyProvision;

  const insertedDoc = await collection.insertOne(doc);

  if (!insertedDoc.acknowledged) {
    throw new Error("Error inserting provision to DB");
  }

  return createdKey;
}

/** Inflight map from a user to a provisioning to control concurrency */
const inflightProvisions = new Map<string, Promise<string>>();

/**
 * See singleflight pattern, which is technically a Go concept but the idea is tranferrable
 * to other languages.
 */
async function provisionKey(
  userId: string,
  username: string,
  projectName: string,
  projectDescription: string,
  apiPurpose: readonly string[],
): Promise<string> {
  const existingProvision = inflightProvisions.get(userId);
  if (existingProvision) {
    console.log(`[PROVISION] Joined in-flight request for user ${username}...`);
    return existingProvision;
  }

  // Start the new provision requests on the user (new promise)
  const newProvision = (async () => {
    const createdKey = await createAndPersistKey(
      userId,
      username,
      projectName,
      projectDescription,
      apiPurpose,
    );
    console.log(`[PROVISION] New key created for user ${username}`);
    return createdKey;
  })();
  console.log(`[PROVISION] Started provisioning for user ${username}...`);
  inflightProvisions.set(userId, newProvision);

  try {
    const provisionedKey = await newProvision;
    console.log(
      `[PROVISION] Completed provisioning for user ${username} successfully!`,
    );
    return provisionedKey;
  } catch (error: any) {
    console.error(`[ERROR] Failed provisioning for user ${username}`, error);
    throw error;
  } finally {
    // After the provisioning actions is done, remove it from the map
    inflightProvisions.delete(userId);
  }
}

/**
 * Responding to user submissions the form
 */
const provisionKeyModalSubmit: ModalSubmit = {
  customId: "requestKeyForm",
  execute: async (interaction: ModalSubmitInteraction) => {
    const user = interaction.user;
    const fields = interaction.fields;
    const projectName = fields.getTextInputValue("projName");
    await interaction.reply(
      `Hello <@${user.id}>! We received your request. We'll DM you later.`,
    );

    const key = await provisionKey(
      user.id,
      user.username,
      projectName,
      fields.getTextInputValue("projDescription"),
      fields.getCheckboxGroup("apiPurpose"),
    );
    await user.send(
      `Your new key is ||${key}||. Happy coding! If you have any question, please DM Mike.`,
    );
  },
};

export default provisionKeyModalSubmit;
