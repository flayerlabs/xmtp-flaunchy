import * as fs from "fs";
import * as path from "path";
import { createSigner, getEncryptionKeyFromHex } from "../helpers/client";
import { logAgentDetails, validateEnvironment } from "../helpers/utils";
import { WalletSendCallsCodec } from "@xmtp/content-type-wallet-send-calls";
import { Client, type XmtpEnv } from "@xmtp/node-sdk";
import OpenAI from "openai";
import { flaunchy } from "../characters/flaunchy";

// New group-centric architecture imports
import { SessionManager } from "./core/session/SessionManager";
import { FlowRouter, FlowRegistry } from "./core/flows/FlowRouter";
import { FileGroupStateStorage } from "./core/storage/GroupStateStorage";
import { FilePerUserStateStorage } from "./core/storage/PerUserStateStorage";

import { QAFlow } from "./flows/qa/QAFlow";
import { ManagementFlow } from "./flows/management/ManagementFlow";
import { CoinLaunchFlow } from "./flows/coin-launch/CoinLaunchFlow";

import { EnhancedMessageCoordinator } from "./core/messaging/EnhancedMessageCoordinator";
import { InstallationManager } from "./core/installation/InstallationManager";
import { XMTPStatusMonitor } from "./services/XMTPStatusMonitor";
import { NewGroupDetectionService } from "./services/NewGroupDetectionService";

// Storage configuration
let volumePath = process.env.RAILWAY_VOLUME_MOUNT_PATH ?? ".data/xmtp";

// Stream failure handling configuration
const MAX_STREAM_RETRIES = 5;
const STREAM_RETRY_INTERVAL = 5000; // 5 seconds
let streamRetries = MAX_STREAM_RETRIES;
let isStreamActive = true;

/**
 * Handles the XMTP message stream with proper failure handling and restart logic
 */
async function handleMessageStream(
  client: Client,
  messageCoordinator: EnhancedMessageCoordinator
): Promise<void> {
  console.log("🔄 Starting message stream with failure handling...");

  const retry = () => {
    console.log(
      `🔄 Retrying stream in ${
        STREAM_RETRY_INTERVAL / 1000
      }s, ${streamRetries} retries left`
    );
    if (streamRetries > 0 && isStreamActive) {
      streamRetries--;
      setTimeout(() => {
        handleMessageStream(client, messageCoordinator);
      }, STREAM_RETRY_INTERVAL);
    } else {
      console.error("💥 Max stream retries reached, ending process");
      process.exit(1);
    }
  };

  const onFail = (error?: Error) => {
    console.error("❌ XMTP stream failed:", error?.message || "Unknown error");
    if (isStreamActive) {
      retry();
    }
  };

  try {
    console.log("✓ Syncing conversations...");
    const syncStartTime = Date.now();
    await client.conversations.sync();
    const syncDuration = Date.now() - syncStartTime;
    console.log(`✓ Conversation sync completed in ${syncDuration}ms`);

    console.log("📡 Starting message stream...");
    const streamStartTime = Date.now();

    // Create stream with onFail callback
    const stream = await client.conversations.streamAllMessages(
      undefined, // onMessage callback (we'll handle in the loop)
      undefined, // filter
      undefined, // options
      onFail // onFail callback for stream failures
    );

    const streamSetupDuration = Date.now() - streamStartTime;
    console.log(
      `📡 Message stream setup completed in ${streamSetupDuration}ms`
    );

    // Add connection health check and force readiness
    console.log("🔍 Checking XMTP connection health...");
    try {
      const healthCheckStart = Date.now();
      await client.conversations.list({ limit: 1 });
      const healthCheckDuration = Date.now() - healthCheckStart;
      console.log(
        `✅ XMTP connection health check passed in ${healthCheckDuration}ms`
      );
    } catch (healthError) {
      console.warn("⚠️ XMTP health check failed, but continuing:", healthError);
    }

    // Allow stream to fully initialize
    console.log("⏳ Allowing stream to fully initialize...");
    await new Promise((resolve) => setTimeout(resolve, 1000));
    console.log("✅ Stream initialization complete, ready for messages");

    // Reset retry count on successful stream start
    streamRetries = MAX_STREAM_RETRIES;
    let firstMessageReceived = false;
    const messageStreamStartTime = Date.now();

    console.log("🔄 Starting to listen for messages...");

    // Process messages from the stream
    for await (const message of stream) {
      if (!firstMessageReceived) {
        const timeToFirstMessage = Date.now() - messageStreamStartTime;
        console.log(
          `🎉 First message received after ${timeToFirstMessage}ms from stream start`
        );
        firstMessageReceived = true;
      }

      if (!isStreamActive) {
        console.log("📡 Message stream stopped");
        break;
      }

      if (message) {
        try {
          // console.log(
          //   `📨 New message from ${message.senderInboxId.slice(0, 8)}...`
          // );

          // Process message through the enhanced coordinator
          await messageCoordinator.processMessage(message);
        } catch (error) {
          console.error("❌ Error processing message:", error);

          // Try to send an error response
          try {
            const conversation = await client.conversations.getConversationById(
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
    console.error("❌ Error in message stream handling:", error);
    // The onFail callback will handle the retry
    if (isStreamActive) {
      onFail(error as Error);
    }
  }
}

/**
 * Creates all application resources and components
 */
async function createApplication() {
  console.log("🚀 Starting Flaunchy with new architecture...");

  // Check if running on Railway and add startup delay if needed
  const isRailway = process.env.RAILWAY_ENVIRONMENT !== undefined;
  if (isRailway) {
    console.log("🚄 Railway environment detected");
    console.log("⏳ Allowing Railway container network to stabilize...");
    await new Promise((resolve) => setTimeout(resolve, 2000)); // 2 second delay for Railway
    console.log("✅ Railway network stabilization complete");
  }

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

  // 1. State storage setup
  const groupStatesPath = path.join(volumePath, "group-states.json");
  const perUserStatesPath = path.join(volumePath, "per-user-states.json");

  // 2. Initialize storage components
  const groupStateStorage = new FileGroupStateStorage(groupStatesPath);
  const perUserStateStorage = new FilePerUserStateStorage(perUserStatesPath);

  // 3. Create session manager with both group and per-user storage
  const sessionManager = new SessionManager(
    groupStateStorage,
    perUserStateStorage
  );

  console.log(`🔧 Architecture mode: Group-Centric + Per-User Tracking`);

  // 4. Initialize flows
  const flows: FlowRegistry = {
    qa: new QAFlow(),
    management: new ManagementFlow(),
    coin_launch: new CoinLaunchFlow(),
  };

  // 5. Create flow router
  const flowRouter = new FlowRouter(flows, openai);

  // 6. Create enhanced message coordinator
  const messageCoordinator = new EnhancedMessageCoordinator(
    client,
    openai,
    flaunchy,
    flowRouter,
    sessionManager,
    3000 // 3 second wait time for message coordination
  );

  // 7. Create status monitor
  const statusMonitor = new XMTPStatusMonitor(volumePath);

  // 8. Create and start new group detection service
  const newGroupDetectionService = new NewGroupDetectionService(
    client,
    sessionManager,
    openai,
    flaunchy,
    10000 // 10 seconds interval
  );

  console.log("✅ Architecture initialized successfully!");

  // Start the new group detection service
  await newGroupDetectionService.start();

  // Start the message stream with failure handling
  const streamPromise = handleMessageStream(client, messageCoordinator);

  // Cleanup function
  const cleanup = async () => {
    console.log("🧹 Cleaning up application resources...");

    try {
      // Stop new group detection service
      newGroupDetectionService.stop();

      // Stop message stream
      isStreamActive = false;
      streamRetries = 0; // Prevent retries during cleanup

      // Wait a bit for the stream to stop gracefully
      await new Promise((resolve) => setTimeout(resolve, 1000));

      console.log("✅ Application cleanup completed");
    } catch (error) {
      console.error("❌ Error during application cleanup:", error);
    }
  };

  return {
    client,
    statusMonitor,
    newGroupDetectionService,
    streamPromise,
    cleanup,
  };
}

/**
 * Main function that starts the application with monitoring
 */
async function main() {
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
  isStreamActive = false;
  streamRetries = 0;
  process.exit(0);
});

process.on("SIGTERM", async () => {
  console.log("\n🛑 Received SIGTERM, shutting down gracefully...");
  isStreamActive = false;
  streamRetries = 0;
  process.exit(0);
});
