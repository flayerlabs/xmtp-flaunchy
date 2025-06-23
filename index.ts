import * as fs from "fs";
import * as path from "path";
import { createSigner, getEncryptionKeyFromHex } from "./helpers/client";
import { logAgentDetails, validateEnvironment } from "./helpers/utils";
import { WalletSendCallsCodec } from "@xmtp/content-type-wallet-send-calls";
import { Client, type XmtpEnv, type DecodedMessage } from "@xmtp/node-sdk";
import OpenAI from "openai";
import { flaunchy } from "./characters/flaunchy";
import { processMessage } from "./utils/llm";
import { MessageHistory } from "./utils/messageHistory";
import {
  RemoteAttachmentCodec,
  ContentTypeRemoteAttachment,
  type RemoteAttachment,
  type Attachment,
  AttachmentCodec,
} from "@xmtp/content-type-remote-attachment";

// Initialize codecs globally for use in client and potentially other parts of the application
const attachmentCodec = new AttachmentCodec();
const remoteAttachmentCodec = new RemoteAttachmentCodec();

// Storage configuration for XMTP client data
let volumePath = process.env.RAILWAY_VOLUME_MOUNT_PATH ?? ".data/xmtp";

/**
 * MessageCoordinator handles the coordination of related messages in XMTP conversations,
 * specifically for cases where a text message and an image attachment are sent separately
 * but should be processed together.
 *
 * Problem:
 * XMTP clients often send text and attachments as two distinct messages in quick succession.
 * This can lead to the text message being processed before the attachment arrives, resulting
 * in incomplete context for the AI (e.g., a command like "Flaunch this image" without the image).
 *
 * Solution:
 * This class implements a temporary queue for incoming messages per conversation.
 * - If a text message arrives, it's held for a short duration (waitTimeMs) to see if an attachment follows.
 * - If an attachment arrives, it checks if a recent text message is in the queue for the same conversation.
 * - If both are present, they are processed together.
 * - If the timer expires or one message type arrives without the other, it's processed individually.
 *
 * This ensures that related messages are grouped, providing complete context for subsequent processing,
 * such as sending image details to an AI or handling commands that refer to an image.
 */
class MessageCoordinator {
  private messageQueue: Map<
    string, // conversationId
    {
      textMessage?: DecodedMessage; // Stores the text message if it arrives first
      attachmentMessage?: DecodedMessage; // Stores the attachment message if it arrives first
      timer?: NodeJS.Timeout; // Timer to handle message timeouts
    }
  >;
  private waitTimeMs: number; // How long to wait for the counterpart message
  private client: Client<any>; // XMTP client instance for attachment decoding

  constructor(client: Client<any>, waitTimeMs = 1000) {
    this.messageQueue = new Map();
    this.waitTimeMs = waitTimeMs;
    this.client = client; // Store client for use in RemoteAttachmentCodec.load
  }

  /**
   * Processes an incoming message, coordinating it with related messages if any.
   * @param message - The incoming XMTP DecodedMessage.
   * @param processor - A callback function that will receive an array of one or two messages (text and/or attachment) to be processed together.
   * @returns A promise that resolves to true if the processor was called, false otherwise.
   */
  async processMessage(
    message: DecodedMessage,
    processor: (messages: DecodedMessage[]) => Promise<boolean>
  ): Promise<boolean> {
    const isAttachment = message.contentType?.sameAs(
      ContentTypeRemoteAttachment
    );
    const conversationId = message.conversationId;

    let entry = this.messageQueue.get(conversationId);
    if (!entry) {
      entry = {};
      this.messageQueue.set(conversationId, entry);
    }

    // Clear any existing timer for this conversation to prevent premature processing
    if (entry.timer) {
      clearTimeout(entry.timer);
      entry.timer = undefined;
    }

    if (isAttachment) {
      // Store the attachment message
      entry.attachmentMessage = message;

      // Attempt to decrypt the attachment data immediately.
      // This makes the raw decrypted data available if needed by the llm.ts processor,
      // potentially avoiding a re-decryption if IPFS upload is handled there.
      try {
        const remoteAttachmentContent = message.content as RemoteAttachment;
        console.log("Processing remote attachment in MessageCoordinator:", {
          filename: remoteAttachmentContent.filename,
          url: remoteAttachmentContent.url,
        });

        const decryptedAttachment = (await RemoteAttachmentCodec.load(
          remoteAttachmentContent,
          this.client
        )) as Attachment;

        // Store the decrypted data directly on the message content for later use.
        // The `llm.ts/fetchAndDecryptAttachment` can use this to avoid re-decrypting.
        entry.attachmentMessage.content = {
          ...remoteAttachmentContent, // Keep original remote attachment fields
          // No decryptedUrl (blob URL) here, only raw data and mimetype
          decryptedData: decryptedAttachment.data,
          decryptedMimeType: decryptedAttachment.mimeType,
        };
      } catch (error) {
        console.error(
          "Error decrypting attachment in MessageCoordinator:",
          error
        );
        // If decryption fails, proceed with the original remote attachment content.
        // The llm.ts/fetchAndDecryptAttachment will have to handle full fetch & decrypt.
      }

      // If a text message was already waiting, process both together now.
      if (entry.textMessage) {
        const result = await processor([
          entry.textMessage,
          entry.attachmentMessage, // This will be the modified message with decryptedUrl if successful
        ]);
        this.messageQueue.delete(conversationId); // Clean up the queue
        return result;
      }

      // If no text message is waiting, set a timer.
      // If the timer expires, process the attachment alone.
      entry.timer = setTimeout(async () => {
        if (entry?.attachmentMessage) {
          await processor([entry.attachmentMessage]);
          this.messageQueue.delete(conversationId);
        }
      }, this.waitTimeMs);

      return false; // Processor not called yet, waiting for timer or text message
    } else {
      // Store the text message
      entry.textMessage = message;

      // If an attachment was already waiting, process both together now.
      if (entry.attachmentMessage) {
        const result = await processor([
          entry.textMessage,
          entry.attachmentMessage, // This will be the modified attachment message if decryption was successful
        ]);
        this.messageQueue.delete(conversationId); // Clean up the queue
        return result;
      }

      // If no attachment is waiting, set a timer.
      // If the timer expires, process the text message alone.
      entry.timer = setTimeout(async () => {
        if (entry?.textMessage) {
          await processor([entry.textMessage]);
          this.messageQueue.delete(conversationId);
        }
      }, this.waitTimeMs);

      return false; // Processor not called yet, waiting for timer or attachment
    }
  }
}

/**
 * Main application function.
 * Initializes the XMTP client, sets up OpenAI, message history, and the message coordinator.
 * Listens for incoming messages, processes them using the coordinator, and handles responses.
 */
async function main() {
  // Validate and load environment variables
  const { WALLET_KEY, ENCRYPTION_KEY, XMTP_ENV, OPENAI_API_KEY } =
    validateEnvironment([
      "WALLET_KEY",
      "ENCRYPTION_KEY",
      "XMTP_ENV",
      "OPENAI_API_KEY",
    ]);

  // Initialize services and configurations
  const signer = createSigner(WALLET_KEY);
  const encryptionKey = getEncryptionKeyFromHex(ENCRYPTION_KEY);
  const openai = new OpenAI({ apiKey: OPENAI_API_KEY });
  const messageHistory = new MessageHistory(20); // Store last 20 messages per sender

  const identifier = await signer.getIdentifier();
  const address = identifier.identifier;

  // Ensure storage directory for XMTP database exists
  if (!fs.existsSync(volumePath)) {
    fs.mkdirSync(volumePath, { recursive: true });
  }

  // Create and configure the XMTP client
  // It's important to register all necessary codecs (RemoteAttachmentCodec, AttachmentCodec)
  // for proper handling of different content types, especially encrypted attachments.
  const client = await Client.create(signer, {
    env: XMTP_ENV as XmtpEnv,
    codecs: [
      new WalletSendCallsCodec(),
      remoteAttachmentCodec, // For handling remote (URL-based) attachments
      attachmentCodec, // For handling direct/native attachments
    ],
    dbPath: path.join(volumePath, `${address}-${XMTP_ENV}`),
    dbEncryptionKey: encryptionKey,
  });

  // Initialize the MessageCoordinator with the client instance and a wait time (e.g., 1 second)
  const messageCoordinator = new MessageCoordinator(client, 1000);

  logAgentDetails(address, client.inboxId, XMTP_ENV);

  console.log("✓ Syncing conversations...");
  await client.conversations.sync();

  console.log("✓ Loading message history...");
  await messageHistory.loadHistoricalMessages(client);

  console.log("Waiting for messages...");
  const stream = client.conversations.streamAllMessages();

  // Main message loop: iterate over incoming messages from all conversations
  for await (const message of await stream) {
    if (message) {
      // Filter out self-messages and read receipts for cleaner logging and processing
      if (
        message.senderInboxId !== client.inboxId &&
        message.contentType?.typeId !== "readReceipt"
      ) {
        console.log("\n=== New Message Received ===");
        console.log({
          msg: {
            content: message.content,
            contentTypeId: message.contentType?.typeId,
          },
        });
      }

      // Process only non-readReceipt messages
      if (message.contentType?.typeId !== "readReceipt") {
        // Skip transaction receipt messages that come as '...'
        if (typeof message.content === 'string' && message.content.trim() === '...') {
          console.log(`[MessageCoordinator] Skipping transaction receipt message from ${message.senderInboxId}`);
          continue;
        }
        
        // Pass the message to the coordinator. The coordinator will decide when and how to call the processor.
        await messageCoordinator.processMessage(message, async (messages) => {
          // The processor callback receives an array of messages (1 or 2).
          // The last message in the array is the most recent one (either text or attachment).
          // If an attachment was processed, `messages[messages.length-1].content` might contain `decryptedUrl`.
          const response = await processMessage({
            // This is `processMessage` from `utils/llm.ts`
            client,
            openai,
            character: flaunchy,
            message: messages[messages.length - 1], // Primary message for LLM context
            signer,
            messageHistory,
            relatedMessages:
              messages.length > 1 ? messages.slice(0, -1) : undefined, // Older message if paired
          });

          // If the LLM processing generated a response, add all involved messages to history
          if (response) {
            messages.forEach((msg) =>
              messageHistory.addMessage(msg.senderInboxId, msg, true)
            );
          }

          return response;
        });

        // Log completion only for messages not sent by the agent itself
        if (message.senderInboxId !== client.inboxId) {
          console.log("=== Message Processing Complete ===\n");
          console.log("Waiting for messages...");
        }
      }
    }
  }
}

// Start the main application logic and catch any fatal errors
main().catch((error: unknown) => {
  console.error(
    "Fatal error:",
    error instanceof Error ? error.message : String(error)
  );
});
