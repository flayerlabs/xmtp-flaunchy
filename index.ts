import * as fs from "fs";
import * as path from "path";
import { createSigner, getEncryptionKeyFromHex } from "@helpers/client";
import { logAgentDetails, validateEnvironment } from "@helpers/utils";
import { WalletSendCallsCodec } from "@xmtp/content-type-wallet-send-calls";
import { Client, type XmtpEnv } from "@xmtp/node-sdk";
import OpenAI from "openai";
import { flaunchy } from "./characters/flaunchy";
import { processMessage } from "./utils/llm";

// Storage configuration
const STORAGE_DIR = process.env.RAILWAY_VOLUME_MOUNT_PATH || ".data";

// Ensure storage directory exists
if (!fs.existsSync(STORAGE_DIR)) {
  fs.mkdirSync(STORAGE_DIR, { recursive: true });
}

async function main() {
  const { WALLET_KEY, ENCRYPTION_KEY, XMTP_ENV, OPENAI_API_KEY } =
    validateEnvironment([
      "WALLET_KEY",
      "ENCRYPTION_KEY",
      "XMTP_ENV",
      "OPENAI_API_KEY",
    ]);

  const signer = createSigner(WALLET_KEY);
  const encryptionKey = getEncryptionKeyFromHex(ENCRYPTION_KEY);
  const openai = new OpenAI({ apiKey: OPENAI_API_KEY });

  // Get wallet address for storage path
  const identifier = await signer.getIdentifier();
  const address = identifier.identifier;

  // Configure client with persistent storage
  const client = await Client.create(signer, encryptionKey, {
    env: XMTP_ENV as XmtpEnv,
    codecs: [new WalletSendCallsCodec()],
    dbPath: path.join(STORAGE_DIR, `xmtp-${XMTP_ENV}-${address}`),
  });

  logAgentDetails(address, client.inboxId, XMTP_ENV);

  console.log("✓ Syncing conversations...");
  await client.conversations.sync();

  console.log("Waiting for messages...");
  const stream = client.conversations.streamAllMessages();

  for await (const message of await stream) {
    if (message) {
      await processMessage({
        client,
        openai,
        character: flaunchy,
        message,
        signer,
      });
      console.log("Waiting for messages...");
    }
  }
}

main().catch((error: unknown) => {
  console.error(
    "Fatal error:",
    error instanceof Error ? error.message : String(error),
  );
});
