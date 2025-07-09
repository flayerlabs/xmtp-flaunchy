import * as fs from "fs";
import * as path from "path";
import { createSigner, getEncryptionKeyFromHex } from "../helpers/client";
import { logAgentDetails, validateEnvironment } from "../helpers/utils";
import { WalletSendCallsCodec } from "@xmtp/content-type-wallet-send-calls";
import { Client, type XmtpEnv } from "@xmtp/node-sdk";
import OpenAI from "openai";
import { flaunchy } from "../characters/flaunchy";
import {
  RemoteAttachmentCodec,
  AttachmentCodec,
} from "@xmtp/content-type-remote-attachment";
import { TransactionReferenceCodec } from "@xmtp/content-type-transaction-reference";

// New architecture imports
import { FileStateStorage } from "./core/storage/StateStorage";
import { SessionManager } from "./core/session/SessionManager";
import { FlowRouter, FlowRegistry } from "./core/flows/FlowRouter";
import { OnboardingFlow } from "./flows/onboarding/OnboardingFlow";
import { QAFlow } from "./flows/qa/QAFlow";
import { ManagementFlow } from "./flows/management/ManagementFlow";
import { CoinLaunchFlow } from "./flows/coin-launch/CoinLaunchFlow";
import { GroupLaunchFlow } from "./flows/group-launch/GroupLaunchFlow";
import { EnhancedMessageCoordinator } from "./core/messaging/EnhancedMessageCoordinator";
import { InstallationManager } from "./core/installation/InstallationManager";
import { XMTPStatusMonitor } from "./services/XMTPStatusMonitor";

// Storage configuration
let volumePath = process.env.RAILWAY_VOLUME_MOUNT_PATH ?? ".data/xmtp";

/**
 * Creates all application resources and components
 */
async function createApplication() {
  console.log("🚀 Starting Flaunchy with new architecture...");

  // Validate and load environment variables
  const { WALLET_KEY, ENCRYPTION_KEY, XMTP_ENV, OPENAI_API_KEY } =
    validateEnvironment([
      "WALLET_KEY",
      "ENCRYPTION_KEY",
      "XMTP_ENV",
      "OPENAI_API_KEY",
    ]);

  // Initialize OpenAI
  const openai = new OpenAI({
    apiKey: OPENAI_API_KEY,
  });

  // Create signer and XMTP client
  const signer = createSigner(WALLET_KEY);
  const encryptionKey = getEncryptionKeyFromHex(ENCRYPTION_KEY);

  // Get address for database path
  const identifier = await signer.getIdentifier();
  const address = identifier.identifier;

  // Ensure storage directory for XMTP database exists
  if (!fs.existsSync(volumePath)) {
    fs.mkdirSync(volumePath, { recursive: true });
  }

  // Create XMTP client with installation limit handling
  let client;
  try {
    // First try to build from existing installation (avoids creating new ones)
    console.log("🔄 Attempting to reuse existing XMTP installation...");
    client = await InstallationManager.buildExistingClient(signer, {
      env: XMTP_ENV as XmtpEnv,
      dbPath: path.join(volumePath, `${address}-${XMTP_ENV}`),
      dbEncryptionKey: encryptionKey,
      retryAttempts: 2,
    });
  } catch (buildError: any) {
    console.log(
      "⚠️ Could not reuse existing installation, creating new one..."
    );
    console.log("Build error:", buildError.message);

    // Fallback to creating new installation with limit handling
    client = await InstallationManager.createClient(signer, {
      env: XMTP_ENV as XmtpEnv,
      dbPath: path.join(volumePath, `${address}-${XMTP_ENV}`),
      dbEncryptionKey: encryptionKey,
      retryAttempts: 3,
      onInstallationLimitExceeded: async (error) => {
        console.error("🚫 XMTP Installation Limit Exceeded:");
        console.error(error.message);
        console.error("\nSuggested actions:");
        error.suggestedActions?.forEach((action) => console.error(action));

        // For production apps, you might want to:
        // 1. Notify administrators
        // 2. Try to clean up old installations
        // 3. Use a fallback strategy

        return false; // Don't retry by default
      },
    });
  }

  // Log agent details
  logAgentDetails(address, client.inboxId, XMTP_ENV);

  // Initialize new architecture components
  console.log("🏗️ Initializing new architecture...");

  // 1. State storage and session management
  const stateStorage = new FileStateStorage(
    path.join(volumePath, "user-states.json")
  );
  const sessionManager = new SessionManager(stateStorage);

  // 2. Initialize flows
  const flows: FlowRegistry = {
    onboarding: new OnboardingFlow(),
    qa: new QAFlow(),
    management: new ManagementFlow(),
    coin_launch: new CoinLaunchFlow(),
    group_launch: new GroupLaunchFlow(),
  };

  // 3. Create flow router
  const flowRouter = new FlowRouter(flows, openai);

  // 4. Create enhanced message coordinator
  const messageCoordinator = new EnhancedMessageCoordinator(
    client,
    openai,
    flaunchy,
    flowRouter,
    sessionManager,
    1000 // 1 second wait time for message coordination
  );

  // 5. Create status monitor
  const statusMonitor = new XMTPStatusMonitor(volumePath);

  console.log("✅ Architecture initialized successfully!");

  console.log("✓ Syncing conversations...");
  await client.conversations.sync();

  console.log("📡 Starting message stream...");

  // Start listening for messages
  const stream = await client.conversations.streamAllMessages();
  let isStreamActive = true;

  // Process messages in the background
  const messageProcessingPromise = (async () => {
    try {
      for await (const message of stream) {
        if (!isStreamActive) {
          console.log("📡 Message stream stopped");
          break;
        }

        if (message) {
          try {
            console.log(
              `📨 New message from ${message.senderInboxId.slice(0, 8)}...`
            );

            // Process message through the enhanced coordinator
            await messageCoordinator.processMessage(message);
          } catch (error) {
            console.error("❌ Error processing message:", error);

            // Try to send an error response
            try {
              const conversation =
                await client.conversations.getConversationById(
                  message.conversationId
                );
              if (conversation) {
                await conversation.send(
                  "sorry, something went wrong. please try again."
                );
              }
            } catch (sendError) {
              console.error("❌ Could not send error response:", sendError);
            }
          }
        }
      }
    } catch (error) {
      console.error("❌ Error in message stream:", error);
    }
  })();

  // Cleanup function
  const cleanup = async () => {
    console.log("🧹 Cleaning up application resources...");

    try {
      // Stop message stream
      isStreamActive = false;
      if (stream) {
        try {
          await stream.return();
        } catch (error) {
          console.warn("⚠️ Error closing message stream:", error);
        }
      }

      // Wait for message processing to complete
      await messageProcessingPromise;

      console.log("✅ Application cleanup completed");
    } catch (error) {
      console.error("❌ Error during application cleanup:", error);
    }
  };

  return {
    client,
    statusMonitor,
    messageStream: stream,
    cleanup,
  };
}

/**
 * Main function that starts the application with monitoring
 */
async function main() {
  console.log("🚀 Starting Flaunchy with XMTP status monitoring...");

  try {
    // Create status monitor
    const statusMonitor = new XMTPStatusMonitor(volumePath);

    // Start application with monitoring
    await statusMonitor.startWithMonitoring(createApplication);

    console.log("✅ Application started successfully with monitoring!");
  } catch (error) {
    console.error("💥 Fatal error:", error);
    process.exit(1);
  }
}

// Error handling and startup
main().catch((error) => {
  console.error("💥 Fatal error:", error);
  process.exit(1);
});

// Graceful shutdown handling
process.on("SIGINT", async () => {
  console.log("\n🛑 Received SIGINT, shutting down gracefully...");
  process.exit(0);
});

process.on("SIGTERM", async () => {
  console.log("\n🛑 Received SIGTERM, shutting down gracefully...");
  process.exit(0);
});
