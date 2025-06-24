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
import { 
  TransactionReferenceCodec 
} from "@xmtp/content-type-transaction-reference";

// New architecture imports
import { FileStateStorage } from "./core/storage/StateStorage";
import { SessionManager } from "./core/session/SessionManager";
import { FlowRouter, FlowRegistry } from "./core/flows/FlowRouter";
import { OnboardingFlow } from "./flows/onboarding/OnboardingFlow";
import { QAFlow } from "./flows/qa/QAFlow";
import { ManagementFlow } from "./flows/management/ManagementFlow";
import { CoinLaunchFlow } from "./flows/coin-launch/CoinLaunchFlow";
import { EnhancedMessageCoordinator } from "./core/messaging/EnhancedMessageCoordinator";

// Initialize codecs globally
const attachmentCodec = new AttachmentCodec();
const remoteAttachmentCodec = new RemoteAttachmentCodec();
const transactionReferenceCodec = new TransactionReferenceCodec();

// Storage configuration
let volumePath = process.env.RAILWAY_VOLUME_MOUNT_PATH ?? ".data/xmtp";

/**
 * New main application function using the refactored architecture
 */
async function main() {
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

  console.log("📦 Creating XMTP client...");
  const client = await Client.create(signer, {
    env: XMTP_ENV as XmtpEnv,
    codecs: [
      new WalletSendCallsCodec(),
      remoteAttachmentCodec,
      attachmentCodec,
      transactionReferenceCodec,
    ],
    dbPath: path.join(volumePath, `${address}-${XMTP_ENV}`),
    dbEncryptionKey: encryptionKey,
  });

  // Log agent details
  logAgentDetails(address, client.inboxId, XMTP_ENV);

  // Initialize new architecture components
  console.log("🏗️ Initializing new architecture...");
  
  // 1. State storage and session management
  const stateStorage = new FileStateStorage(path.join(volumePath, "user-states.json"));
  const sessionManager = new SessionManager(stateStorage);
  
  // 2. Initialize flows
  const flows: FlowRegistry = {
    onboarding: new OnboardingFlow(),
    qa: new QAFlow(),
    management: new ManagementFlow(),
    coin_launch: new CoinLaunchFlow()
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

  console.log("✅ Architecture initialized successfully!");
  
  console.log("✓ Syncing conversations...");
  await client.conversations.sync();
  
  console.log("📡 Starting message stream...");

  // Start listening for messages
  const stream = client.conversations.streamAllMessages();
  
  for await (const message of await stream) {
    if (message) {
      try {
        console.log(`📨 New message from ${message.senderInboxId.slice(0, 8)}...`);
        
        // Process message through the enhanced coordinator
        await messageCoordinator.processMessage(message);
        
      } catch (error) {
        console.error("❌ Error processing message:", error);
        
        // Try to send an error response
        try {
          const conversation = await client.conversations.getConversationById(message.conversationId);
          if (conversation) {
            await conversation.send("sorry, something went wrong. please try again.");
          }
        } catch (sendError) {
          console.error("❌ Could not send error response:", sendError);
        }
      }
    }
  }
}

// Error handling and startup
main().catch((error) => {
  console.error("💥 Fatal error:", error);
  process.exit(1);
}); 