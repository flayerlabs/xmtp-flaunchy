import type { Client, DecodedMessage, Conversation } from "@xmtp/node-sdk";
import type OpenAI from "openai";
import { FlowRouter } from "../flows/FlowRouter";
import { SessionManager } from "../session/SessionManager";
import { FlowContext } from "../types/FlowContext";
import { UserState, UserGroup, GroupState } from "../types/UserState";
import { Character, TransactionReferenceMessage } from "../../../types";
import {
  ContentTypeRemoteAttachment,
  type RemoteAttachment,
  RemoteAttachmentCodec,
  type Attachment,
} from "@xmtp/content-type-remote-attachment";
import {
  ContentTypeTransactionReference,
  type TransactionReference,
} from "@xmtp/content-type-transaction-reference";
import { ContentTypeReply, type Reply } from "@xmtp/content-type-reply";
import {
  ContentTypeReaction,
  type Reaction,
} from "@xmtp/content-type-reaction";
import { ContentTypeText } from "@xmtp/content-type-text";

import {
  decodeEventLog,
  decodeAbiParameters,
  type Log,
  createPublicClient,
  http,
  isAddress,
  Hex,
} from "viem";
import { base, baseSepolia, mainnet } from "viem/chains";
import { uploadImageToIPFS } from "../../../utils/ipfs";
import { getDefaultChain } from "../../flows/utils/ChainSelection";
import { GroupStorageService } from "../../services/GroupStorageService";
import { ENSResolverService } from "../../services/ENSResolverService";

// ABI for PoolCreated event
const poolCreatedAbi = [
  {
    anonymous: false,
    inputs: [
      {
        indexed: true,
        internalType: "bytes32",
        name: "_poolId",
        type: "bytes32",
      },
      {
        indexed: false,
        internalType: "address",
        name: "_memecoin",
        type: "address",
      },
      {
        indexed: false,
        internalType: "address",
        name: "_memecoinTreasury",
        type: "address",
      },
      {
        indexed: false,
        internalType: "uint256",
        name: "_tokenId",
        type: "uint256",
      },
      {
        indexed: false,
        internalType: "bool",
        name: "_currencyFlipped",
        type: "bool",
      },
      {
        indexed: false,
        internalType: "uint256",
        name: "_flaunchFee",
        type: "uint256",
      },
      {
        indexed: false,
        internalType: "tuple",
        name: "_params",
        type: "tuple",
        components: [
          {
            internalType: "string",
            name: "name",
            type: "string",
          },
          {
            internalType: "string",
            name: "symbol",
            type: "string",
          },
          {
            internalType: "string",
            name: "tokenUri",
            type: "string",
          },
          {
            internalType: "uint256",
            name: "initialTokenFairLaunch",
            type: "uint256",
          },
          {
            internalType: "uint256",
            name: "fairLaunchDuration",
            type: "uint256",
          },
          {
            internalType: "uint256",
            name: "premineAmount",
            type: "uint256",
          },
          {
            internalType: "address",
            name: "creator",
            type: "address",
          },
          {
            internalType: "uint24",
            name: "creatorFeeAllocation",
            type: "uint24",
          },
          {
            internalType: "uint256",
            name: "flaunchAt",
            type: "uint256",
          },
          {
            internalType: "bytes",
            name: "initialPriceParams",
            type: "bytes",
          },
          {
            internalType: "bytes",
            name: "feeCalculatorParams",
            type: "bytes",
          },
        ],
      },
    ],
    name: "PoolCreated",
    type: "event",
  },
] as const;

// Note: TreasuryManagerFactory does not emit a ManagerDeployed event
// It returns the manager address directly from the deployAndInitializeManager function

function getMemecoinAddress(logData: Log[]) {
  // Find the log with the PoolCreated event
  try {
    const poolCreatedLog = logData.find((log) => {
      return (
        log.topics[0] ===
        "0x54976b48704e67457d6a85a2db51d6e760bbeddf6151f9206512108adce80b42"
      );
    });
    if (!poolCreatedLog) {
      console.error("No PoolCreated event found in log data");
      return undefined;
    }

    console.log("Found PoolCreated log:", {
      address: poolCreatedLog.address,
      topics: poolCreatedLog.topics,
      data: poolCreatedLog.data,
    });

    // Decode the log data using the actual topics from the log
    const decoded = decodeEventLog({
      abi: poolCreatedAbi,
      data: poolCreatedLog.data as `0x${string}`,
      topics: poolCreatedLog.topics as [`0x${string}`, ...`0x${string}`[]],
      eventName: "PoolCreated",
    });

    console.log("Decoded PoolCreated event:", {
      poolId: decoded.args._poolId,
      memecoin: decoded.args._memecoin,
      memecoinTreasury: decoded.args._memecoinTreasury,
      tokenId: decoded.args._tokenId,
      currencyFlipped: decoded.args._currencyFlipped,
      flaunchFee: decoded.args._flaunchFee?.toString(),
      params: {
        name: decoded.args._params.name,
        symbol: decoded.args._params.symbol,
        creator: decoded.args._params.creator,
      },
    });

    return decoded.args._memecoin as string;
  } catch (error) {
    console.error("Error decoding PoolCreated log:", error);
    return undefined;
  }
}

// Note: getManagerAddress function removed because TreasuryManagerFactory
// does not emit a ManagerDeployed event. The manager address is returned
// directly from the deployAndInitializeManager function call.

export class EnhancedMessageCoordinator {
  private messageQueue: Map<
    string, // conversationId
    {
      textMessage?: DecodedMessage;
      attachmentMessage?: DecodedMessage;
      timer?: NodeJS.Timeout;
    }
  >;

  private waitTimeMs: number;

  // Track active conversation threads where the agent is engaged
  private activeThreads: Map<
    string,
    {
      // conversationId -> thread state
      lastAgentMessageTime: Date;
      participatingUsers: Set<string>; // users who have responded to agent in this thread
      threadStartTime: Date;
    }
  > = new Map();

  // Thread timeout - if no activity for 30 minutes, consider thread inactive
  // This ensures bot doesn't continue responding to users who've moved on
  private readonly THREAD_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

  private groupStorageService: GroupStorageService;
  private ensResolverService: ENSResolverService;

  constructor(
    private client: Client<any>,
    private openai: OpenAI,
    private character: Character,
    private flowRouter: FlowRouter,
    private sessionManager: SessionManager,
    waitTimeMs = 1000
  ) {
    this.messageQueue = new Map();
    this.waitTimeMs = waitTimeMs;
    this.groupStorageService = new GroupStorageService(this.sessionManager);
    this.ensResolverService = new ENSResolverService();
  }

  async processMessage(message: DecodedMessage): Promise<boolean> {
    // Skip messages from the bot itself
    if (message.senderInboxId === this.client.inboxId) {
      return false;
    }

    const contentTypeId = message.contentType?.typeId;

    // Skip read receipts, avoid logging to prevent spam
    if (contentTypeId === "readReceipt") {
      return false;
    }

    // Skip wallet send calls but handle transaction receipts
    if (contentTypeId === "wallet-send-calls") {
      console.log("⏭️ SKIPPING WALLET SEND CALLS", {
        contentType: contentTypeId,
        senderInboxId: message.senderInboxId,
        timestamp: new Date().toISOString(),
      });
      return false;
    }

    // Handle transaction references for success messages
    if (message.contentType?.sameAs(ContentTypeTransactionReference)) {
      console.log("🧾 PROCESSING TRANSACTION REFERENCE", {
        contentType: "transaction-reference",
        senderInboxId: message.senderInboxId,
        timestamp: new Date().toISOString(),
      });
      return await this.handleTransactionReference(message);
    }

    // Skip transaction receipt messages that come as text with '...' content
    if (
      typeof message.content === "string" &&
      message.content.trim() === "..."
    ) {
      console.log("[MessageCoordinator] ⏭️ Skipping transaction receipt");
      return false;
    }

    const isAttachment = message.contentType?.sameAs(
      ContentTypeRemoteAttachment
    );
    const conversationId = message.conversationId;

    // Log incoming message
    console.log("📨 INCOMING MESSAGE", {
      conversationId: conversationId,
      senderInboxId: message.senderInboxId,
      contentType: message.contentType?.typeId || "text",
      isAttachment: isAttachment,
      content: isAttachment
        ? "[ATTACHMENT]"
        : typeof message.content === "string"
        ? message.content
        : "[NON-TEXT]",
      timestamp: new Date().toISOString(),
      messageId: message.id,
      contentLength:
        typeof message.content === "string" ? message.content.length : 0,
    });

    let entry = this.messageQueue.get(conversationId);
    if (!entry) {
      entry = {};
      this.messageQueue.set(conversationId, entry);
    }

    // Clear any existing timer
    if (entry.timer) {
      clearTimeout(entry.timer);
      entry.timer = undefined;
    }

    if (isAttachment) {
      entry.attachmentMessage = message;

      // If a text message was already waiting, process both together
      if (entry.textMessage) {
        const result = await this.processCoordinatedMessages([
          entry.textMessage,
          entry.attachmentMessage,
        ]);
        this.messageQueue.delete(conversationId);
        return result;
      }

      // Set timer to process attachment alone if no text arrives
      entry.timer = setTimeout(async () => {
        if (entry?.attachmentMessage) {
          // Check if attachment alone would be filtered out
          const attachmentMessage = entry.attachmentMessage;
          const conversation =
            await this.client.conversations.getConversationById(
              attachmentMessage.conversationId
            );

          if (conversation) {
            const members = await conversation.members();
            const isGroupChat = members.length > 2;

            // For group chats, check if attachment alone would be processed
            if (isGroupChat) {
              const messageText = this.extractCombinedMessageText(
                attachmentMessage,
                []
              );

              // If no text and it's a group chat, don't process alone - wait longer
              if (!messageText || messageText.trim().length === 0) {
                console.log(
                  "🔄 Attachment without text in group chat - extending wait time"
                );

                // Extend the timer for another 1 seconds to allow text to arrive
                const extendedTimer = setTimeout(async () => {
                  if (entry?.attachmentMessage) {
                    await this.processCoordinatedMessages([
                      entry.attachmentMessage,
                    ]);
                    this.messageQueue.delete(conversationId);
                  }
                }, 1000);
                entry.timer = extendedTimer;
                return;
              }
            }
          }

          await this.processCoordinatedMessages([entry.attachmentMessage]);
          this.messageQueue.delete(conversationId);
        }
      }, this.waitTimeMs);

      return false;
    } else {
      entry.textMessage = message;

      // If an attachment was already waiting, process both together
      if (entry.attachmentMessage) {
        const result = await this.processCoordinatedMessages([
          entry.textMessage,
          entry.attachmentMessage,
        ]);
        this.messageQueue.delete(conversationId);
        return result;
      }

      // Set timer to process text alone if no attachment arrives
      entry.timer = setTimeout(async () => {
        if (entry?.textMessage) {
          await this.processCoordinatedMessages([entry.textMessage]);
          this.messageQueue.delete(conversationId);
        }
      }, this.waitTimeMs);

      return false;
    }
  }

  private async processCoordinatedMessages(
    messages: DecodedMessage[]
  ): Promise<boolean> {
    try {
      // Get the primary message (most recent)
      const primaryMessage = messages[messages.length - 1];
      const relatedMessages = messages.slice(0, -1);

      const hasAttachment = messages.some((msg) =>
        msg.contentType?.sameAs(ContentTypeRemoteAttachment)
      );
      console.log(
        `[MessageCoordinator] 🔄 Processing ${messages.length} messages${
          hasAttachment ? " (with attachment)" : ""
        }`
      );

      // Get conversation
      const conversation = await this.client.conversations.getConversationById(
        primaryMessage.conversationId
      );
      if (!conversation) {
        console.error("Could not find conversation");
        return false;
      }

      // Check if this is a direct message (1-on-1 conversation)
      const members = await conversation.members();
      const isGroupChat = members.length > 2;

      if (!isGroupChat) {
        console.log(
          "[MessageCoordinator] 📱 Direct message detected - checking intent before processing"
        );

        // Get sender info for intent detection
        const senderInboxId = primaryMessage.senderInboxId;
        const inboxState = await this.client.preferences.inboxStateFromInboxIds(
          [senderInboxId]
        );
        const creatorAddress = inboxState[0]?.identifiers[0]?.identifier || "";

        // Get user state for intent detection (but don't update it)
        let userState = await this.sessionManager.getUserState(creatorAddress);

        // Create a minimal context for intent detection
        const messageText = this.extractCombinedMessageText(
          primaryMessage,
          relatedMessages
        );
        const tempContext = {
          messageText,
          userState,
          openai: this.openai,
          groupState: {}, // Empty group state for intent detection
        } as FlowContext;

        // Detect the intent to determine which flow this would go to
        const multiIntentResult = await this.flowRouter.detectMultipleIntents(
          tempContext
        );
        const wouldGoToFlow = this.flowRouter.getPrimaryFlow(
          multiIntentResult,
          tempContext.groupState
        );

        // Only block management and coin_launch flows in direct messages
        if (wouldGoToFlow === "management" || wouldGoToFlow === "coin_launch") {
          console.log(
            `[MessageCoordinator] 🚫 Direct message blocked - ${wouldGoToFlow} flow requires group chat`
          );

          // Send group requirement message for flows that need groups
          const directMessageResponse =
            "gmeow! i work in group chats where i can launch coins with fee splitting for all members.\n\n" +
            "to get started:\n" +
            "1. create a group chat with your friends\n" +
            "2. add me to the group\n" +
            "3. then i can help you launch coins with automatic fee splitting!\n\n" +
            "the magic happens when everyone's together in a group. stay based!";

          await conversation.send(directMessageResponse);

          console.log(
            "[MessageCoordinator] ✅ Sent group requirement message - not processing through flows"
          );
          return true;
        }

        // Allow QA flow (greetings, questions, help) to continue in direct messages
        console.log(
          `[MessageCoordinator] ✅ Direct message allowed - ${wouldGoToFlow} flow can work in DMs`
        );
        // Continue with normal processing for QA flow, but mark as direct message
      }

      // Get sender info
      const senderInboxId = primaryMessage.senderInboxId;
      const inboxState = await this.client.preferences.inboxStateFromInboxIds([
        senderInboxId,
      ]);
      const creatorAddress = inboxState[0]?.identifiers[0]?.identifier || "";

      // Get user state by Ethereum address (the actual on-chain identity)
      let userState = await this.sessionManager.getUserState(creatorAddress);

      // Get group state for processing decision
      const groupState = await this.sessionManager.getGroupState(
        creatorAddress,
        primaryMessage.conversationId
      );

      // Check if this is a reply to an image attachment during coin data collection
      const isReplyToImage = await this.isReplyToImageAttachment(
        primaryMessage,
        conversation,
        groupState
      );

      // Check if we should process this message
      const shouldProcess = await this.shouldProcessMessage(
        primaryMessage,
        conversation,
        groupState,
        relatedMessages,
        isReplyToImage
      );

      if (!shouldProcess) {
        console.log(
          "[MessageCoordinator] 🚫 Message filtered out - not directed at agent"
        );
        return false;
      }

      // Send a paw emoji reaction to let the user know the agent is processing their message
      const pawReaction: Reaction = {
        reference: primaryMessage.id,
        action: "added",
        content: "🐾",
        schema: "unicode",
      };
      await conversation.send(pawReaction, ContentTypeReaction);
      console.log("🐾 Sent paw reaction");

      // Create flow context (using relatedMessages as conversation history for now)
      const context = await this.createFlowContext({
        primaryMessage,
        relatedMessages,
        conversation,
        userState,
        senderInboxId,
        creatorAddress,
        conversationHistory: relatedMessages,
        isDirectMessage: !isGroupChat,
        isReplyToImage,
      });

      // Route to appropriate flow
      await this.flowRouter.routeMessage(context);

      return true;
    } catch (error) {
      console.error("Error processing coordinated messages:", error);
      return false;
    }
  }

  private async createFlowContext({
    primaryMessage,
    relatedMessages,
    conversation,
    userState,
    senderInboxId,
    creatorAddress,
    conversationHistory,
    isDirectMessage,
    isReplyToImage = false,
  }: {
    primaryMessage: DecodedMessage;
    relatedMessages: DecodedMessage[];
    conversation: Conversation<any>;
    userState: UserState;
    senderInboxId: string;
    creatorAddress: string;
    conversationHistory: DecodedMessage[];
    isDirectMessage: boolean;
    isReplyToImage?: boolean;
  }): Promise<FlowContext> {
    // Determine message text and attachment info
    const isAttachment = primaryMessage.contentType?.sameAs(
      ContentTypeRemoteAttachment
    );
    let messageText = "";
    let hasAttachment = false;
    let attachment: any = undefined;

    // Handle reply to image case
    if (
      isReplyToImage &&
      primaryMessage.contentType?.sameAs(ContentTypeReply)
    ) {
      const replyContent = primaryMessage.content as Reply;
      messageText =
        typeof replyContent.content === "string"
          ? replyContent.content.trim()
          : "";

      // Extract attachment from the replied-to message
      const messages = await conversation.messages({
        limit: 100,
        direction: 1,
      }); // Descending order
      const referenceId = replyContent.reference as string;
      const referencedMessage = messages.find(
        (msg: any) => msg.id === referenceId
      );

      if (
        referencedMessage &&
        referencedMessage.contentType?.sameAs(ContentTypeRemoteAttachment)
      ) {
        hasAttachment = true;
        attachment = referencedMessage.content;

        console.log(
          "🖼️ REPLY TO IMAGE: Extracted attachment from replied-to message",
          {
            referenceId: referenceId?.slice(0, 16) + "...",
            hasAttachment,
            messageText: messageText.substring(0, 50) + "...",
          }
        );
      }
    } else if (isAttachment) {
      hasAttachment = true;
      attachment = primaryMessage.content;

      // Look for text in related messages
      const textMessage = relatedMessages.find(
        (msg) => !msg.contentType?.sameAs(ContentTypeRemoteAttachment)
      );
      if (textMessage) {
        messageText = this.extractMessageText(textMessage).trim();
      }
    } else {
      // Primary message is text (or reply with text)
      messageText = this.extractMessageText(primaryMessage).trim();

      // Check for attachment in related messages
      const attachmentMessage = relatedMessages.find((msg) =>
        msg.contentType?.sameAs(ContentTypeRemoteAttachment)
      );
      if (attachmentMessage) {
        hasAttachment = true;
        attachment = attachmentMessage.content;
      }
    }

    // Get group ID from conversation
    const groupId = conversation.id;

    // Get group-specific state
    const groupState = await this.sessionManager.getGroupState(
      creatorAddress,
      groupId
    );

    return {
      // Core XMTP objects
      client: this.client,
      conversation,
      message: primaryMessage,
      signer: this.client.signer!,

      // AI and character
      openai: this.openai,
      character: this.character,

      // User state and identification
      userState,
      senderInboxId,
      creatorAddress,

      // Group context
      groupId,
      groupState,

      // Session management
      sessionManager: this.sessionManager,

      // Services
      ensResolver: this.ensResolverService,

      // Message context
      messageText,
      hasAttachment,
      attachment,
      relatedMessages,
      conversationHistory,
      isDirectMessage,

      // Helper functions
      sendResponse: async (message: string) => {
        // Check if we should use reply format due to intervening messages
        const shouldUseReply = await this.shouldUseReplyFormat(
          primaryMessage,
          conversation,
          this.client.inboxId
        );

        if (shouldUseReply) {
          // Send as a reply to the original message
          const reply: Reply = {
            reference: primaryMessage.id,
            content: message,
            contentType: ContentTypeText,
          };

          console.log("💬 Sending reply due to intervening messages", {
            referencingMessageId: primaryMessage.id.slice(0, 16) + "...",
            messagePreview: message.substring(0, 50) + "...",
          });

          await conversation.send(reply, ContentTypeReply);
        } else {
          // Send as normal text message
          await conversation.send(message);
        }

        // Update thread state when agent sends a message
        this.updateThreadWithAgentMessage(conversation.id);
      },

      updateState: async (updates: Partial<UserState>) => {
        await this.sessionManager.updateUserState(creatorAddress, updates);
      },

      // Group-specific state management
      updateGroupState: async (updates: Partial<GroupState>) => {
        await this.sessionManager.updateGroupState(
          creatorAddress,
          groupId,
          updates
        );
      },

      clearGroupState: async () => {
        await this.sessionManager.clearGroupState(creatorAddress, groupId);
      },

      // Utility functions
      resolveUsername: async (username: string) => {
        return this.resolveUsername(username);
      },

      processImageAttachment: async (attachment: any) => {
        return this.processImageAttachment(attachment);
      },
    };
  }

  private async resolveUsername(username: string): Promise<string | undefined> {
    try {
      // If already an Ethereum address, return it
      if (isAddress(username)) {
        return username;
      }

      // Handle ENS names
      if (username.includes(".eth")) {
        return await this.resolveENS(username);
      }

      // Handle Farcaster usernames
      if (username.startsWith("@")) {
        return await this.resolveFarcaster(username.substring(1)); // Remove @ prefix
      }

      // If no specific format detected, try as Farcaster username
      return await this.resolveFarcaster(username);
    } catch (error) {
      console.error("Error resolving username:", username, error);
      return undefined;
    }
  }

  private async resolveENS(ensName: string): Promise<string | undefined> {
    try {
      // Both ENS and Basenames are resolved on Ethereum mainnet
      const isBasename = ensName.endsWith(".base.eth");
      const rpcUrl = process.env.MAINNET_RPC_URL;

      console.log(
        `🔍 Resolving ${
          isBasename ? "Basename" : "ENS"
        }: ${ensName} on Ethereum mainnet`
      );

      // Create a public client for ENS/Basename resolution (always mainnet)
      const publicClient = createPublicClient({
        chain: mainnet,
        transport: rpcUrl ? http(rpcUrl) : http(),
      });

      const address = await publicClient.getEnsAddress({
        name: ensName,
      });

      if (address) {
        console.log(
          `✅ ${
            isBasename ? "Basename" : "ENS"
          } resolved: ${ensName} -> ${address}`
        );
        return address;
      }

      console.log(
        `❌ ${
          isBasename ? "Basename" : "ENS"
        } resolution failed for: ${ensName}`
      );
      return undefined;
    } catch (error) {
      console.error(`Error resolving ENS/Basename ${ensName}:`, error);
      return undefined;
    }
  }

  private async resolveFarcaster(
    username: string
  ): Promise<string | undefined> {
    try {
      const apiKey = process.env.NEYNAR_API_KEY;
      if (!apiKey) {
        console.error("NEYNAR_API_KEY not found in environment variables");
        return undefined;
      }

      // Call Neynar API to resolve Farcaster username
      const response = await fetch(
        `https://api.neynar.com/v2/farcaster/user/by_username?username=${username.toLowerCase()}`,
        {
          headers: {
            accept: "application/json",
            api_key: apiKey,
          },
        }
      );

      if (!response.ok) {
        console.error(
          `Neynar API error: ${response.status} ${response.statusText}`
        );
        return undefined;
      }

      const data = await response.json();

      // Extract the primary verified address or custody address
      const user = data.user;
      if (user) {
        // Prefer verified ETH addresses, fallback to custody address
        const address =
          user.verified_addresses?.eth_addresses?.[0] || user.custody_address;

        if (address) {
          console.log(`✅ Farcaster resolved: @${username} -> ${address}`);
          return address;
        }
      }

      console.log(`❌ Farcaster resolution failed for: @${username}`);
      return undefined;
    } catch (error) {
      console.error(`Error resolving Farcaster username @${username}:`, error);
      return undefined;
    }
  }

  private async processImageAttachment(
    attachment: RemoteAttachment
  ): Promise<string> {
    console.log("🖼️ Processing XMTP remote attachment:", {
      filename: attachment.filename,
      url:
        typeof attachment.url === "string"
          ? attachment.url.substring(0, 100) + "..."
          : attachment.url,
      scheme: attachment.scheme,
      hasContentDigest: !!(attachment as any).contentDigest,
      hasSalt: !!(attachment as any).salt,
      hasNonce: !!(attachment as any).nonce,
      hasSecret: !!(attachment as any).secret,
      hasDecryptedData: !!(attachment as any).decryptedData,
      hasDecryptedMimeType: !!(attachment as any).decryptedMimeType,
    });

    try {
      let decryptedAttachment: Attachment;

      // Check if we already have decrypted data from MessageCoordinator preprocessing
      if (
        (attachment as any).decryptedData &&
        (attachment as any).decryptedMimeType
      ) {
        console.log("🔄 Using pre-decrypted data from MessageCoordinator");
        decryptedAttachment = {
          filename: attachment.filename || "image",
          mimeType: (attachment as any).decryptedMimeType,
          data: (attachment as any).decryptedData,
        };
      } else {
        // Decrypt the attachment using XMTP RemoteAttachmentCodec
        console.log("🔓 Decrypting XMTP remote attachment...");
        decryptedAttachment = (await RemoteAttachmentCodec.load(
          attachment,
          this.client
        )) as Attachment;
      }

      console.log("✅ XMTP decryption successful:", {
        filename: decryptedAttachment.filename,
        mimeType: decryptedAttachment.mimeType,
        dataSize: decryptedAttachment.data.length,
        estimatedFileSizeKB: Math.round(decryptedAttachment.data.length / 1024),
      });

      // Validate the decrypted data
      if (!decryptedAttachment.data || decryptedAttachment.data.length === 0) {
        throw new Error("Decrypted attachment has no data");
      }

      // Validate it's a reasonable image size
      if (decryptedAttachment.data.length < 100) {
        throw new Error(
          `Image data too small (${decryptedAttachment.data.length} bytes), likely corrupted`
        );
      }

      if (decryptedAttachment.data.length > 10 * 1024 * 1024) {
        // 10MB limit
        throw new Error(
          `Image data too large (${Math.round(
            decryptedAttachment.data.length / 1024 / 1024
          )}MB), max 10MB allowed`
        );
      }

      // Convert to base64 for IPFS upload
      console.log(
        "📤 Converting decrypted image to base64 and uploading to IPFS..."
      );
      const base64Image = Buffer.from(decryptedAttachment.data).toString(
        "base64"
      );

      console.log(
        `[MessageCoordinator] 📊 Processing image (${(
          decryptedAttachment.data.length / 1024
        ).toFixed(1)}KB)`
      );

      // Upload to IPFS using our existing upload function
      const ipfsResponse = await uploadImageToIPFS({
        pinataConfig: { jwt: process.env.PINATA_JWT! },
        base64Image,
        name: decryptedAttachment.filename || "image",
      });

      // Validate the IPFS hash
      if (!ipfsResponse.IpfsHash || typeof ipfsResponse.IpfsHash !== "string") {
        throw new Error("Invalid IPFS response: missing or invalid IpfsHash");
      }

      // Validate IPFS hash format
      const hash = ipfsResponse.IpfsHash;
      const isValidFormat =
        hash.startsWith("Qm") || // CIDv0 format
        hash.startsWith("baf") || // CIDv1 format
        hash.startsWith("bae") || // CIDv1 format
        hash.startsWith("bai") || // CIDv1 format
        hash.startsWith("bab"); // CIDv1 format

      if (!isValidFormat) {
        throw new Error(
          `Invalid IPFS hash format: ${hash} - should start with Qm, baf, bae, bai, or bab`
        );
      }

      // Validate hash length
      if (hash.length < 20 || hash.length > 100) {
        throw new Error(`Invalid IPFS hash length: ${hash.length} characters`);
      }

      const ipfsUrl = `ipfs://${hash}`;
      console.log(
        "✅ Successfully processed XMTP attachment and uploaded to IPFS:",
        ipfsUrl
      );

      return ipfsUrl;
    } catch (error) {
      console.error("❌ XMTP attachment processing failed:", error);

      // Log detailed error information for debugging
      if (error instanceof Error) {
        console.error("Error details:", {
          name: error.name,
          message: error.message,
          stack: error.stack?.split("\n").slice(0, 3).join("\n"), // First 3 lines of stack
        });
      }

      // Log attachment details for debugging
      console.error("Attachment details for debugging:", {
        filename: attachment.filename,
        url:
          typeof attachment.url === "string"
            ? attachment.url.substring(0, 100) + "..."
            : attachment.url,
        scheme: attachment.scheme,
        attachmentKeys: Object.keys(attachment),
      });

      return "IMAGE_PROCESSING_FAILED";
    }
  }

  private async handleTransactionReference(
    message: DecodedMessage
  ): Promise<boolean> {
    try {
      const senderInboxId = message.senderInboxId;

      // Get creator address for user state lookup
      const inboxState = await this.client.preferences.inboxStateFromInboxIds([
        senderInboxId,
      ]);
      const creatorAddress = inboxState[0]?.identifiers[0]?.identifier || "";

      const userState = await this.sessionManager.getUserState(creatorAddress);
      const groupState = await this.sessionManager.getGroupState(
        creatorAddress,
        message.conversationId
      );

      // Check if user has a pending transaction
      if (!groupState.pendingTransaction) {
        console.log("No pending transaction found for transaction reference");
        return false;
      }

      const pendingTx = groupState.pendingTransaction;
      const conversation = await this.client.conversations.getConversationById(
        message.conversationId
      );

      if (!conversation) {
        console.error("Could not find conversation for transaction reference");
        return false;
      }

      // Parse the transaction reference content
      const messageContent = (message as TransactionReferenceMessage).content;

      // Debug logging to understand the structure
      console.log(
        `[MessageCoordinator] 🔍 Debug - message content:`,
        messageContent
      );

      if (!messageContent) {
        console.error("❌ Message content is undefined");
        return false;
      }

      const transactionRef = messageContent.transactionReference;
      let txHash: Hex | undefined = undefined;

      if (!transactionRef) {
        const oldMessageContent = messageContent as unknown as {
          reference: Hex; // txHash
        };
        if (oldMessageContent.reference) {
          txHash = oldMessageContent.reference;
        } else {
          console.error("❌ Transaction reference is undefined");
          return false;
        }
      } else {
        txHash = transactionRef.reference;
      }

      if (!txHash) {
        console.error("❌ Transaction hash is undefined");
        return false;
      }

      console.log(
        `[MessageCoordinator] 🔍 Processing ${pendingTx.type} transaction: ${txHash}`
      );

      // Use default chain from environment
      const defaultChain = getDefaultChain();
      const chain = defaultChain.viemChain;

      // Create a public client to fetch the transaction receipt
      const publicClient = createPublicClient({
        chain,
        transport: http(),
      });

      try {
        const receipt = await publicClient.waitForTransactionReceipt({
          hash: txHash,
          timeout: 60_000, // 60 second timeout
        });
        console.log("[MessageCoordinator] ✅ Transaction confirmed");

        // Extract contract address from the receipt logs
        const contractAddress = await this.extractContractAddressFromReceipt(
          receipt,
          pendingTx.type
        );

        if (!contractAddress) {
          console.error(
            "❌ CRITICAL: Failed to extract contract address from transaction receipt"
          );

          // Send error message to user
          const errorMessage =
            pendingTx.type === "group_creation"
              ? "❌ Transaction Error\n\nI couldn't verify your Group creation. The transaction completed, but I was unable to extract the Group address from the receipt.\n\nPlease check your wallet for the transaction details, or try creating another Group."
              : "❌ Transaction Error\n\nI couldn't verify your Coin creation. The transaction completed, but I was unable to extract the Coin address from the receipt.\n\nPlease check your wallet for the transaction details, or try launching another Coin.";

          await conversation.send(errorMessage);

          // Clear the pending transaction since we can't process it
          await this.sessionManager.updateGroupState(
            creatorAddress,
            message.conversationId,
            {
              pendingTransaction: undefined,
              managementProgress: undefined, // Clear management progress on system error
            }
          );

          return false;
        }

        // Validate that the extracted address is a valid Ethereum address
        if (!isAddress(contractAddress)) {
          console.error(
            "❌ CRITICAL: Extracted address is not a valid Ethereum address:",
            contractAddress
          );

          // Send error message to user
          const errorMessage =
            pendingTx.type === "group_creation"
              ? "❌ Transaction Error\n\nI extracted an invalid Group address from your transaction receipt. This is a security issue.\n\nPlease check your wallet for the correct address, or try creating another Group."
              : "❌ Transaction Error\n\nI extracted an invalid Coin address from your transaction receipt. This is a security issue.\n\nPlease check your wallet for the correct address, or try launching another Coin.";

          await conversation.send(errorMessage);

          // Clear the pending transaction since we can't process it
          await this.sessionManager.updateGroupState(
            creatorAddress,
            message.conversationId,
            {
              pendingTransaction: undefined,
              managementProgress: undefined, // Clear management progress on system error
            }
          );

          return false;
        }

        // Determine network
        const network = pendingTx.network;

        // Update user state based on transaction type
        if (pendingTx.type === "group_creation") {
          // For group creation, extract receiver data FIRST
          const currentProgress = groupState.onboardingProgress;

          // Use default chain from environment
          const defaultChain = getDefaultChain();
          const chainId = defaultChain.id;
          const chainName = defaultChain.name;

          // NEW: Extract receivers from transaction logs for chat group model
          let receivers: Array<{
            username: string;
            resolvedAddress: string;
            percentage: number;
          }> = [];

          // Try stored data first (for legacy onboarding/management flows)
          const storedReceivers =
            currentProgress?.splitData?.receivers ||
            groupState.managementProgress?.groupCreationData?.receivers ||
            [];

          if (storedReceivers.length > 0) {
            receivers = storedReceivers
              .map((r: any) => ({
                username: r.username,
                resolvedAddress: r.resolvedAddress || "", // Don't fallback to inbox ID
                percentage: r.percentage || 100 / storedReceivers.length,
              }))
              .filter(
                (r: any) =>
                  r.resolvedAddress && r.resolvedAddress.startsWith("0x")
              ); // Only include valid Ethereum addresses

            console.log(
              "📋 Using stored receivers (filtered for valid addresses):",
              receivers
            );
          } else {
            // NEW: For chat group model, extract receivers from transaction logs
            console.log(
              "📋 No stored receivers found, extracting from transaction logs..."
            );
            try {
              const extractedReceivers =
                await this.extractReceiversFromTransactionLogs(
                  receipt,
                  creatorAddress
                );
              if (extractedReceivers.length > 0) {
                receivers = extractedReceivers;
                console.log(
                  "✅ Successfully extracted receivers from transaction logs:",
                  receivers
                );
              }
            } catch (error) {
              console.error(
                "Failed to extract receivers from transaction logs:",
                error
              );
            }
          }

          // If still no receivers found, this is an error condition
          if (receivers.length === 0) {
            console.error(
              "❌ CRITICAL: No valid fee receivers found for group creation"
            );
            await conversation.send(
              "❌ Group Creation Error\n\nNo valid fee receivers were found for your group. This is a critical error.\n\nPlease try creating the group again with valid usernames or addresses."
            );

            // Clear the pending transaction since we can't process it
            await this.sessionManager.updateGroupState(
              creatorAddress,
              message.conversationId,
              {
                pendingTransaction: undefined,
                managementProgress: undefined,
              }
            );

            return false;
          }

          // Send confirmation message using ENS-resolved receiver data
          const receiverNames = await Promise.all(
            receivers.map(async (r) => {
              // Format receiver display name with ENS resolution
              if (
                r.username &&
                r.username !== r.resolvedAddress &&
                !r.username.startsWith("0x")
              ) {
                // Username is already resolved (e.g., @javery)
                return r.username.startsWith("@")
                  ? r.username
                  : `@${r.username}`;
              } else {
                // Use ENS resolution for the address
                return await this.ensResolverService.resolveSingleAddress(
                  r.resolvedAddress
                );
              }
            })
          );

          // Creator address already resolved above

          // Store the group for all receivers using the GroupStorageService
          // This will handle generating the group name and storing it for all participants
          const groupName =
            await this.groupStorageService.storeGroupForAllReceivers(
              senderInboxId,
              creatorAddress, // Pass the resolved creator address
              contractAddress,
              receivers.map((r) => ({
                username: r.username,
                resolvedAddress: r.resolvedAddress,
                percentage: r.percentage,
              })),
              chainId,
              chainName,
              txHash
            );

          // Generate a badass introduction message for the new group
          const { GroupCreationUtils } = await import(
            "../../flows/utils/GroupCreationUtils"
          );
          const introMessage =
            await GroupCreationUtils.generateGroupIntroduction(
              groupName,
              receivers.map((r) => ({
                username: r.username,
                resolvedAddress: r.resolvedAddress,
                percentage: r.percentage,
              })),
              this.openai,
              userState.status === "onboarding" // Include coin prompt for onboarding users
            );

          await conversation.send(introMessage);

          // For onboarding, the coin prompt is now included in the intro message
          // No need for separate messages

          // Update the creator's state (group was already added by GroupStorageService)
          await this.sessionManager.updateGroupState(
            creatorAddress,
            message.conversationId,
            {
              pendingTransaction: undefined,
              managementProgress: undefined, // Clear management progress when group creation completes
              onboardingProgress: currentProgress
                ? {
                    ...currentProgress,
                    step: "coin_creation",
                    splitData: currentProgress.splitData
                      ? {
                          ...currentProgress.splitData,
                          managerAddress: contractAddress,
                        }
                      : undefined,
                    groupData: {
                      managerAddress: contractAddress,
                      txHash: txHash,
                    },
                    // Preserve existing coin data if any, otherwise initialize empty
                    coinData: currentProgress.coinData || {
                      name: undefined,
                      ticker: undefined,
                      image: undefined,
                    },
                  }
                : undefined,
            }
          );
        } else {
          // Coin creation success
          const networkPath =
            network === "baseSepolia" ? "base-sepolia" : "base";
          await conversation.send(
            `coin created! CA: ${contractAddress}\n\nlink: https://flaunch.gg/${networkPath}/coin/${contractAddress}\n\nview in mini app:`
          );
          await conversation.send(
            `https://mini.flaunch.gg/${networkPath}/coin/${contractAddress}`
          );

          // Check if this was a first launch and store manager address
          if (pendingTx.launchParameters?.isFirstLaunch) {
            console.log(
              "🔍 First launch detected - extracting and storing manager address"
            );

            // Extract manager address from transaction receipt
            const managerAddress = await this.extractManagerAddressFromReceipt(
              receipt
            );

            if (managerAddress) {
              // Use conversation ID as the key for chat room manager mapping
              const chatRoomId = conversation.id;

              // Store the manager address for ALL chat room members
              const members = await conversation.members();
              const updatePromises = [];

              for (const member of members) {
                // Skip the bot
                if (member.inboxId !== this.client.inboxId) {
                  // Get member's address
                  const memberInboxState =
                    await this.client.preferences.inboxStateFromInboxIds([
                      member.inboxId,
                    ]);
                  if (
                    memberInboxState.length > 0 &&
                    memberInboxState[0].identifiers.length > 0
                  ) {
                    const memberAddress =
                      memberInboxState[0].identifiers[0].identifier;

                    // Get member's current state
                    const memberState = await this.sessionManager.getUserState(
                      memberAddress
                    );

                    // Update their chat room managers mapping
                    const updatedManagers = {
                      ...memberState.chatRoomManagers,
                      [chatRoomId]: managerAddress,
                    };

                    // Queue the update
                    updatePromises.push(
                      this.sessionManager.updateUserState(memberAddress, {
                        chatRoomManagers: updatedManagers,
                      })
                    );
                  }
                }
              }

              // Execute all updates
              await Promise.all(updatePromises);

              console.log(
                "✅ Stored manager address for all chat room members",
                {
                  chatRoomId,
                  managerAddress,
                  totalMembers: updatePromises.length,
                }
              );
            } else {
              console.error(
                "❌ Failed to extract manager address from first launch receipt"
              );
            }
          }

          // For coin creation in chat room model, use the manager address from chatRoomManagers
          // or extract from the transaction if it's a first launch
          let groupAddress = "unknown-group";
          const chatRoomId = conversation.id;

          // First try to get from chatRoomManagers
          if (userState.chatRoomManagers?.[chatRoomId]) {
            groupAddress = userState.chatRoomManagers[chatRoomId];
          } else if (pendingTx.launchParameters?.isFirstLaunch) {
            // For first launch, extract manager address from transaction
            const extractedManagerAddress =
              await this.extractManagerAddressFromReceipt(receipt);
            if (extractedManagerAddress) {
              groupAddress = extractedManagerAddress;
            }
          } else {
            // Fallback to existing group logic for legacy flows
            groupAddress =
              groupState.onboardingProgress?.groupData?.managerAddress ||
              groupState.onboardingProgress?.splitData?.managerAddress ||
              (userState.groups.length > 0
                ? userState.groups[userState.groups.length - 1].id
                : "unknown-group");
          }

          // Use default chain from environment
          const defaultChain = getDefaultChain();
          const chainId = defaultChain.id;
          const chainName = defaultChain.name;

          // Create the coin object (only if coinData exists)
          if (pendingTx.coinData && groupAddress !== "unknown-group") {
            const newCoin = {
              ticker: pendingTx.coinData.ticker,
              name: pendingTx.coinData.name,
              image: pendingTx.coinData.image,
              groupId: groupAddress.toLowerCase(), // Normalize to lowercase for consistent matching
              contractAddress,
              launched: true,
              fairLaunchDuration: 30 * 60, // 30 minutes
              fairLaunchPercent: 10,
              initialMarketCap: 1000,
              chainId,
              chainName,
              createdAt: new Date(),
            };

            // For chat room launches, ensure the group exists properly using GroupStorageService
            await this.ensureGroupExistsForChatRoomLaunch(
              conversation,
              groupAddress,
              chainId,
              chainName,
              creatorAddress
            );

            // Verify the group exists - if not, forcefully create it
            const creatorStateAfterGroupCreation =
              await this.sessionManager.getUserState(creatorAddress);
            let groupExists = creatorStateAfterGroupCreation.groups.find(
              (g) => g.id.toLowerCase() === groupAddress.toLowerCase()
            );

            if (!groupExists) {
              console.warn(
                `⚠️ Group ${groupAddress} not found in creator's state after initial creation - forcefully adding it`
              );

              // Forcefully add the group to the creator
              await this.forcefullyEnsureGroupForChatRoom(
                conversation,
                groupAddress,
                chainId,
                chainName,
                creatorAddress
              );

              // Verify again
              const updatedCreatorState =
                await this.sessionManager.getUserState(creatorAddress);
              groupExists = updatedCreatorState.groups.find(
                (g) => g.id.toLowerCase() === groupAddress.toLowerCase()
              );

              if (!groupExists) {
                console.error(
                  `❌ CRITICAL: Group ${groupAddress} still not found after forceful creation - this is a serious issue`
                );
                return false;
              }
            }

            console.log(
              `[CoinAddition] ✅ Group ${groupAddress} exists, adding coin "${newCoin.ticker}" to all members`
            );

            // Add coin to ALL group members (not just creator)
            await this.groupStorageService.addCoinToAllGroupMembers(
              groupAddress,
              newCoin,
              creatorAddress
            );

            console.log(
              `[CoinAddition] ✅ Successfully added coin "${newCoin.ticker}" to all group members`
            );
          } else if (groupAddress === "unknown-group") {
            console.error(
              "❌ Group unknown-group not found in creator's state"
            );
          }

          // Clear the creator's pending transaction and management progress
          await this.sessionManager.updateGroupState(
            creatorAddress,
            message.conversationId,
            {
              pendingTransaction: undefined,
              managementProgress: undefined, // Clear management progress when coin creation completes
            }
          );

          // Update user status to active after successful coin launch
          if (userState.status === "new" || userState.status === "onboarding") {
            await this.sessionManager.updateUserState(creatorAddress, {
              status: "active",
            });

            // Send completion message for new users
            if (userState.status === "new") {
              const completionMessage = `🎉 coin launched! you're now active and earning fees from trading.`;
              await conversation.send(completionMessage);
            } else {
              // Send onboarding completion message for onboarding users
              const completionMessage = `🎉 onboarding complete! you've got groups and coins set up.`;
              await conversation.send(completionMessage);
            }
          }
        }

        console.log(
          "Successfully processed transaction reference and sent success message",
          {
            type: pendingTx.type,
            contractAddress,
            network,
            txHash,
          }
        );

        return true;
      } catch (receiptError: any) {
        console.error(
          "❌ Failed to wait for transaction receipt:",
          receiptError
        );

        let errorMessage: string;
        if (
          receiptError?.name === "TimeoutError" ||
          receiptError?.message?.includes("timeout")
        ) {
          errorMessage =
            "⏰ Transaction Timeout\n\nYour transaction is taking longer than expected to confirm. This is normal during network congestion.\n\nPlease check your wallet in a few minutes, or send the transaction reference again once it's confirmed.";
        } else {
          errorMessage =
            "❌ Transaction Error\n\nI couldn't fetch your transaction receipt from the blockchain. This could be due to network issues.\n\nPlease wait a moment and try again, or check your wallet for transaction details.";
        }

        await conversation.send(errorMessage);

        // Don't clear pending transaction in case of network issues - user might retry
        return false;
      }
    } catch (error) {
      console.error(
        "❌ CRITICAL: Error handling transaction reference:",
        error
      );

      try {
        const conversation =
          await this.client.conversations.getConversationById(
            message.conversationId
          );
        if (conversation) {
          await conversation.send(
            "❌ System Error\n\nI encountered an error while processing your transaction reference. This could be due to an unexpected format or system issue.\n\nPlease check your wallet for transaction details and try again if needed."
          );
        }

        // Clear any pending transaction state
        const senderInboxId = message.senderInboxId;
        const inboxState = await this.client.preferences.inboxStateFromInboxIds(
          [senderInboxId]
        );
        const creatorAddress = inboxState[0]?.identifiers[0]?.identifier || "";

        await this.sessionManager.updateGroupState(
          creatorAddress,
          message.conversationId,
          {
            pendingTransaction: undefined,
            managementProgress: undefined, // Clear management progress on system error
          }
        );
      } catch (notificationError) {
        console.error(
          "Failed to send error notification to user:",
          notificationError
        );
      }

      return false;
    }
  }

  private async extractReceiversFromTransactionLogs(
    receipt: any,
    senderAddress: string
  ): Promise<
    Array<{ username: string; resolvedAddress: string; percentage: number }>
  > {
    try {
      if (!receipt || !receipt.logs || !Array.isArray(receipt.logs)) {
        throw new Error("Invalid receipt or logs");
      }

      // Look for the FeeSplitManagerInitialized event (topic: 0x1622d3ee94b11b30b943c365a33e530faf52f5ccbc53d8aae6a25ec82a61caff)
      const feeSplitInitializedTopic =
        "0x1622d3ee94b11b30b943c365a33e530faf52f5ccbc53d8aae6a25ec82a61caff";

      for (const log of receipt.logs) {
        if (
          log.topics &&
          log.topics[0] === feeSplitInitializedTopic &&
          log.data
        ) {
          console.log(
            "🔍 Decoding FeeSplitManagerInitialized event data:",
            log.data
          );

          // Decode the log data directly - it contains: owner, params struct
          const decoded = decodeAbiParameters(
            [
              { name: "owner", type: "address" },
              {
                name: "params",
                type: "tuple",
                components: [
                  { name: "creatorShare", type: "uint256" },
                  {
                    name: "recipientShares",
                    type: "tuple[]",
                    components: [
                      { name: "recipient", type: "address" },
                      { name: "share", type: "uint256" },
                    ],
                  },
                ],
              },
            ],
            log.data
          );

          console.log("✅ Successfully decoded log data:", {
            owner: decoded[0],
            creatorShare: decoded[1].creatorShare.toString(),
            recipientShares: decoded[1].recipientShares.map((rs: any) => ({
              recipient: rs.recipient,
              share: rs.share.toString(),
            })),
          });

          const recipientShares = decoded[1].recipientShares as Array<{
            recipient: string;
            share: bigint;
          }>;
          const totalShare = 10000000n; // 100% in contract format

          return recipientShares.map((rs) => ({
            username: rs.recipient, // Use address as username since we don't have the original username
            resolvedAddress: rs.recipient,
            percentage: Number((rs.share * 100n) / totalShare), // Convert to percentage
          }));
        }
      }

      throw new Error("FeeSplitManagerInitialized event not found in logs");
    } catch (error) {
      console.error(
        "Failed to extract receivers from transaction logs:",
        error
      );
      throw error;
    }
  }

  private async extractManagerAddressFromReceipt(
    receipt: any
  ): Promise<string | null> {
    try {
      if (!receipt || !receipt.logs || !Array.isArray(receipt.logs)) {
        throw new Error("Invalid receipt or logs");
      }

      // Look for the ManagerDeployed event (topic: 0xb9eeb0ca3259038acb2879e65ccb1f2a6433df58eefa491654cc6607b01944d4)
      const managerDeployedTopic =
        "0xb9eeb0ca3259038acb2879e65ccb1f2a6433df58eefa491654cc6607b01944d4";

      for (const log of receipt.logs) {
        if (
          log.topics &&
          log.topics.length > 1 &&
          log.topics[0] === managerDeployedTopic
        ) {
          // Found the ManagerDeployed event, extract manager address from topic[1]
          const managerAddressHex = log.topics[1];
          // Remove padding zeros to get the actual address
          const managerAddress = `0x${managerAddressHex.slice(-40)}`;
          console.log(
            "✅ Found manager address from ManagerDeployed event:",
            managerAddress
          );
          return managerAddress;
        }
      }

      console.log(
        "❌ No ManagerDeployed event found in logs for manager address extraction"
      );
      return null;
    } catch (error) {
      console.error(
        "Failed to extract manager address from transaction logs:",
        error
      );
      return null;
    }
  }

  private async extractContractAddressFromReceipt(
    content: any,
    transactionType: "group_creation" | "coin_creation"
  ): Promise<string | null> {
    // Helper function to safely stringify objects with BigInt values
    const safeStringify = (obj: any) => {
      try {
        return JSON.stringify(
          obj,
          (key, value) =>
            typeof value === "bigint" ? value.toString() + "n" : value,
          2
        );
      } catch (error) {
        return "[Unable to stringify - contains non-serializable values]";
      }
    };

    console.log("🔍 EXTRACTING CONTRACT ADDRESS FROM RECEIPT", {
      contentType: typeof content,
      transactionType,
      content: safeStringify(content),
    });

    try {
      // Parse transaction receipt logs based on transaction type
      if (
        content &&
        typeof content === "object" &&
        content.logs &&
        Array.isArray(content.logs)
      ) {
        const logs = content.logs;
        console.log(`📊 Found ${logs.length} logs in transaction receipt`);

        // Log each log for debugging
        // logs.forEach((log: any, index: number) => {
        //   console.log(`Log ${index}:`, {
        //     address: log.address,
        //     topics: log.topics,
        //     data: log.data ? log.data.substring(0, 100) + "..." : "no data",
        //   });
        // });

        if (transactionType === "group_creation") {
          // For group creation, look for the ManagerDeployed event with specific topic[0]
          console.log("🔍 Group creation: Looking for ManagerDeployed event");

          const managerDeployedTopic =
            "0xb9eeb0ca3259038acb2879e65ccb1f2a6433df58eefa491654cc6607b01944d4";

          for (const log of logs) {
            if (
              log.topics &&
              log.topics.length > 1 &&
              log.topics[0] === managerDeployedTopic
            ) {
              // Found the ManagerDeployed event, extract manager address from topic[1]
              const managerAddressHex = log.topics[1];
              // Remove padding zeros to get the actual address
              const managerAddress = `0x${managerAddressHex.slice(-40)}`;
              console.log(
                "✅ Found manager address from ManagerDeployed event:",
                managerAddress
              );
              return managerAddress;
            }
          }

          console.log("❌ No ManagerDeployed event found in logs");
          console.log("🔍 Available fields in receipt:", Object.keys(content));
        } else if (transactionType === "coin_creation") {
          // For coin creation, use the proper PoolCreated event decoder
          console.log("Parsing coin creation logs for PoolCreated event");

          const memecoinAddress = getMemecoinAddress(logs);
          if (memecoinAddress) {
            console.log(
              "✅ Found memecoin address using PoolCreated decoder:",
              memecoinAddress
            );
            return memecoinAddress;
          } else {
            console.log(
              "❌ PoolCreated event decoder did not find memecoin address"
            );
          }
        }
      } else {
        console.log(
          "❌ No logs found in transaction receipt or invalid format:",
          {
            hasContent: !!content,
            isObject: typeof content === "object",
            hasLogs: !!(content && content.logs),
            isLogsArray: !!(
              content &&
              content.logs &&
              Array.isArray(content.logs)
            ),
            logsType:
              content && content.logs ? typeof content.logs : "undefined",
          }
        );
      }

      // Fallback: Try to extract from common fields (backwards compatibility)
      if (content && typeof content === "object") {
        // Check for memecoin/memecoinAddress fields first (Flaunch-specific)
        if (content.memecoin) {
          console.log("Found memecoin address in content:", content.memecoin);
          return content.memecoin;
        }
        if (content.memecoinAddress) {
          console.log(
            "Found memecoinAddress in content:",
            content.memecoinAddress
          );
          return content.memecoinAddress;
        }
        if (content.managerAddress && transactionType === "group_creation") {
          console.log(
            "Found managerAddress in content:",
            content.managerAddress
          );
          return content.managerAddress;
        }

        // Generic fields
        if (content.contractAddress) {
          console.log(
            "Found contractAddress in content:",
            content.contractAddress
          );
          return content.contractAddress;
        }
        if (content.address) {
          console.log("Found address in content:", content.address);
          return content.address;
        }
      }

      // Try to extract from string content
      if (typeof content === "string" && content.includes("0x")) {
        const match = content.match(/0x[a-fA-F0-9]{40}/);
        if (match) {
          console.log("Found address in string content:", match[0]);
          return match[0];
        }
      }

      console.error(
        "❌ CRITICAL: Could not extract contract address from receipt"
      );
      console.error("🚨 SECURITY: Refusing to proceed with unknown address");
      console.error(
        "💡 For group creation: Check returnValue, result, or output fields in receipt"
      );
      console.error("💡 For coin creation: Check PoolCreated event logs");

      // Return null to indicate failure - do not generate mock addresses for security reasons
      return null;
    } catch (error) {
      console.error("Error parsing transaction receipt:", error);
      return null;
    }
  }

  /**
   * Extract text content from a message, handling different content types properly
   */
  private extractMessageText(message: DecodedMessage): string {
    if (!message.content) {
      return "";
    }

    // Handle string content (regular text messages)
    if (typeof message.content === "string") {
      return message.content;
    }

    // Handle reply messages - extract text from reply.content
    if (message.contentType?.sameAs(ContentTypeReply)) {
      const replyContent = message.content as Reply;
      if (replyContent.content && typeof replyContent.content === "string") {
        console.log("📝 Extracted text from reply message", {
          originalContent: replyContent.content.substring(0, 50) + "...",
          referenceId: (replyContent.reference as string)?.slice(0, 16) + "...",
        });
        return replyContent.content;
      }
      return "";
    }

    // For other content types, return empty string
    return "";
  }

  /**
   * Extract combined text content from primary message and related messages
   * This handles cases where text and attachment are sent as separate messages
   */
  private extractCombinedMessageText(
    primaryMessage: DecodedMessage,
    relatedMessages: DecodedMessage[]
  ): string {
    const isAttachment = primaryMessage.contentType?.sameAs(
      ContentTypeRemoteAttachment
    );

    if (isAttachment) {
      // Look for text in related messages
      const textMessage = relatedMessages.find(
        (msg) => !msg.contentType?.sameAs(ContentTypeRemoteAttachment)
      );
      if (textMessage) {
        return this.extractMessageText(textMessage).trim();
      }
      return "";
    } else {
      // Primary message is text (or reply with text)
      return this.extractMessageText(primaryMessage).trim();
    }
  }

  private async shouldProcessMessage(
    primaryMessage: DecodedMessage,
    conversation: any,
    groupState: any,
    relatedMessages: DecodedMessage[] = [],
    isReplyToImage: boolean = false
  ): Promise<boolean> {
    // Always process messages in 1:1 conversations
    const members = await conversation.members();
    const isGroupChat = members.length > 2;

    if (!isGroupChat) {
      return true;
    }

    // Extract combined message text from primary message and related messages
    // This handles cases where text and attachment are sent as separate messages
    const messageText = this.extractCombinedMessageText(
      primaryMessage,
      relatedMessages
    );
    const senderInboxId = primaryMessage.senderInboxId;
    const conversationId = primaryMessage.conversationId;

    console.log("🔍 COMBINED MESSAGE TEXT EXTRACTION", {
      conversationId: conversationId.slice(0, 8) + "...",
      primaryMessageType: primaryMessage.contentType?.typeId || "text",
      relatedMessagesCount: relatedMessages.length,
      extractedText: messageText.substring(0, 100) + "...",
      hasText: messageText.length > 0,
    });

    // Check if user is in coin data collection step AND sending image without text
    if (
      groupState.coinLaunchProgress?.step === "collecting_coin_data" &&
      primaryMessage.contentType?.sameAs(ContentTypeRemoteAttachment) &&
      (!messageText || messageText.trim() === "")
    ) {
      console.log("🪙 COIN DATA COLLECTION: Image-only message - processing", {
        senderInboxId: senderInboxId.slice(0, 8) + "...",
        conversationId: conversationId.slice(0, 8) + "...",
        step: groupState.coinLaunchProgress.step,
        hasText: !!messageText,
        hasAttachment: true,
      });

      // Start/update active thread since they're providing content for their coin launch
      await this.updateActiveThread(
        conversationId,
        senderInboxId,
        primaryMessage
      );
      return true;
    }

    // Check if this is a reply to an image attachment during coin data collection
    if (isReplyToImage) {
      console.log("🪙 COIN DATA COLLECTION: Reply to image - processing", {
        senderInboxId: senderInboxId.slice(0, 8) + "...",
        conversationId: conversationId.slice(0, 8) + "...",
        step: groupState.coinLaunchProgress?.step,
        hasText: !!messageText,
        isReplyToImage: true,
      });

      // Start/update active thread since they're providing content for their coin launch
      await this.updateActiveThread(
        conversationId,
        senderInboxId,
        primaryMessage
      );
      return true;
    }

    // Check if this is a reply to a flaunchy message (high confidence engagement)
    const isReplyToAgent = await this.isReplyToAgentMessage(primaryMessage);

    if (isReplyToAgent) {
      // Special handling for non-text replies (reactions, etc.)
      if (
        !messageText ||
        messageText === "[NON-TEXT]" ||
        messageText.trim() === ""
      ) {
        console.log("🐾 NON-TEXT REPLY TO AGENT", {
          senderInboxId: senderInboxId.slice(0, 8) + "...",
          conversationId: conversationId.slice(0, 8) + "...",
          contentType: primaryMessage.contentType?.toString(),
          content: primaryMessage.content?.toString().substring(0, 50) + "...",
        });

        // Update thread but don't process through flow router
        await this.updateActiveThread(
          conversationId,
          senderInboxId,
          primaryMessage
        );
        return false; // Don't continue to flow processing
      }

      console.log(
        "💬 REPLY TO AGENT DETECTED - processing with high confidence",
        {
          senderInboxId: senderInboxId.slice(0, 8) + "...",
          conversationId: conversationId.slice(0, 8) + "...",
          messageText: messageText.substring(0, 100) + "...",
        }
      );

      // Start/update active thread when user replies to agent
      await this.updateActiveThread(
        conversationId,
        senderInboxId,
        primaryMessage
      );
      return true;
    }

    // CRITICAL: If this is a reply to someone else (not Flaunchy), only process if explicitly @mentioned
    if (primaryMessage.contentType?.sameAs(ContentTypeReply)) {
      const hasExplicitMention = this.detectExplicitAgentMention(messageText);

      if (!hasExplicitMention) {
        console.log(
          "🚫 REPLY TO OTHER USER - ignoring without explicit @mention",
          {
            senderInboxId: senderInboxId.slice(0, 8) + "...",
            conversationId: conversationId.slice(0, 8) + "...",
            messageText: messageText.substring(0, 50) + "...",
            reason: "reply_to_other_without_explicit_mention",
          }
        );
        return false;
      }

      console.log(
        "✅ REPLY TO OTHER USER with explicit @mention - processing",
        {
          senderInboxId: senderInboxId.slice(0, 8) + "...",
          conversationId: conversationId.slice(0, 8) + "...",
          messageText: messageText.substring(0, 50) + "...",
        }
      );
    }

    // Fast regex check for obvious mentions (saves LLM calls)
    const hasObviousMention = this.detectObviousAgentMention(messageText);

    if (hasObviousMention) {
      console.log("⚡ OBVIOUS MENTION DETECTED - processing message", {
        senderInboxId: senderInboxId.slice(0, 8) + "...",
        conversationId: conversationId.slice(0, 8) + "...",
        messageText: messageText.substring(0, 100) + "...",
      });

      // Start/update active thread when obviously mentioned
      await this.updateActiveThread(
        conversationId,
        senderInboxId,
        primaryMessage
      );
      return true;
    } else {
      return false;
    }
    // skiping the non-tag or reply as detection for all messages is not reliable + costs llm calls

    /**
      // LLM fallback for bot commands and edge cases that regex might miss
      const engagementCheck = await this.checkConversationEngagement(
        messageText,
        conversationId,
        senderInboxId,
        "new_message",
        primaryMessage
      );

      if (engagementCheck.isEngaged) {
        console.log("🧠 LLM DETECTED ENGAGEMENT - processing message", {
          senderInboxId: senderInboxId.slice(0, 8) + "...",
          conversationId: conversationId.slice(0, 8) + "...",
          messageText: messageText.substring(0, 100) + "...",
          reason: engagementCheck.reason,
        });

        // Start/update active thread when LLM detects engagement
        await this.updateActiveThread(
          conversationId,
          senderInboxId,
          primaryMessage
        );
        return true;
      }

      // Check if this is part of an active conversation thread
      const isActiveThread = await this.isInActiveThread(
        conversationId,
        senderInboxId,
        primaryMessage
      );

      if (isActiveThread) {
        console.log("🔄 ACTIVE THREAD - continuing conversation", {
          senderInboxId: senderInboxId.slice(0, 8) + "...",
          conversationId: conversationId.slice(0, 8) + "...",
        });

        // Update thread activity
        await this.updateThreadActivity(conversationId, senderInboxId);
        return true;
      }

      // Special case: Check if user has ongoing coin launch process and this is an attachment
      // Coin launches often involve images, so we should process attachment-only messages
      if (primaryMessage.contentType?.sameAs(ContentTypeRemoteAttachment)) {
        const creatorAddress = await this.getCreatorAddressFromInboxId(
          senderInboxId
        );
        if (creatorAddress) {
          const groupState = await this.sessionManager.getGroupState(
            creatorAddress,
            conversationId
          );

          if (groupState.coinLaunchProgress) {
            console.log("🪙 COIN LAUNCH IN PROGRESS - processing attachment", {
              senderInboxId: senderInboxId.slice(0, 8) + "...",
              conversationId: conversationId.slice(0, 8) + "...",
              step: groupState.coinLaunchProgress.step,
            });

            // Start/update active thread since they're providing content for their coin launch
            await this.updateActiveThread(
              conversationId,
              senderInboxId,
              primaryMessage
            );
            return true;
          }
        }
      }

      // REMOVED: Critical process logic was too broad and caused bot to respond to all messages
      // The bot should ONLY respond when explicitly mentioned or in active conversation thread
      // Having ongoing processes doesn't mean every message should be processed

      console.log("⏭️ IGNORING MESSAGE - no explicit engagement detected", {
        senderInboxId: senderInboxId.slice(0, 8) + "...",
        conversationId: conversationId.slice(0, 8) + "...",
        messageText: messageText.substring(0, 50) + "...",
        reason: "not_mentioned_and_not_in_active_thread",
      });

      return false;
     */
  }

  /**
   * Fast regex detection for obvious agent mentions (saves LLM calls)
   * Only catches the most clear-cut cases where we're 100% sure
   */
  private detectObviousAgentMention(messageText: string): boolean {
    if (!messageText || typeof messageText !== "string") {
      return false;
    }

    const lowerText = messageText.toLowerCase();
    const agentName = this.character.name.toLowerCase(); // "flaunchy"

    // Check for @ mention patterns (most reliable)
    const mentionPatterns = [
      `@${agentName}`, // @flaunchy
      `@ ${agentName}`, // @ flaunchy
      `@${agentName} `, // @flaunchy (with space after)
      ` @${agentName}`, // (space before) @flaunchy
      ` @${agentName} `, // (spaces around) @flaunchy
    ];

    // Check exact @ mention patterns
    for (const pattern of mentionPatterns) {
      if (lowerText.includes(pattern)) {
        return true;
      }
    }

    // Check for @ at start of message followed by agent name
    if (
      lowerText.startsWith(`@${agentName}`) ||
      lowerText.startsWith(`@ ${agentName}`)
    ) {
      return true;
    }

    // Check for VERY OBVIOUS direct address to agent
    const obviousPatterns = [
      new RegExp(`^(hey|hello|hi|ok|yes|sure|alright)\\s+${agentName}\\b`, "i"), // "hey flaunchy", "ok flaunchy"
      new RegExp(
        `^${agentName}\\s+(hey|hello|hi|let|can|help|show|create|add|include|remove|launch|make)`,
        "i"
      ), // "flaunchy hey", "flaunchy add", "flaunchy create"
      new RegExp(
        `^${agentName}[,\\s]+(help|what|how|can|could|show|let|add|create|launch|include)`,
        "i"
      ), // "flaunchy, help me", "flaunchy add javery"
    ];

    // Check obvious patterns
    for (const pattern of obviousPatterns) {
      if (pattern.test(lowerText)) {
        return true;
      }
    }

    return false;
  }

  /**
   * Detect only explicit @mentions of the agent (stricter than obvious mention detection)
   * Used for reply messages to ensure they only engage when explicitly tagged
   */
  private detectExplicitAgentMention(messageText: string): boolean {
    if (!messageText || typeof messageText !== "string") {
      return false;
    }

    const lowerText = messageText.toLowerCase();
    const agentName = this.character.name.toLowerCase(); // "flaunchy"

    // Only check for explicit @ mention patterns
    const explicitMentionPatterns = [
      `@${agentName}`, // @flaunchy
      `@ ${agentName}`, // @ flaunchy
    ];

    // Check exact @ mention patterns
    for (const pattern of explicitMentionPatterns) {
      if (lowerText.includes(pattern)) {
        return true;
      }
    }

    // Check for @ at start of message followed by agent name
    if (
      lowerText.startsWith(`@${agentName}`) ||
      lowerText.startsWith(`@ ${agentName}`)
    ) {
      return true;
    }

    // Do NOT include casual name mentions - those are handled by detectObviousAgentMention
    // for non-reply messages only
    return false;
  }

  /**
   * Check if message is part of an active conversation thread
   */
  private async isInActiveThread(
    conversationId: string,
    senderInboxId: string,
    message: DecodedMessage
  ): Promise<boolean> {
    const thread = this.activeThreads.get(conversationId);

    if (!thread) {
      return false;
    }

    // Check if thread has timed out
    const now = new Date();
    const timeSinceLastActivity =
      now.getTime() - thread.lastAgentMessageTime.getTime();

    if (timeSinceLastActivity > this.THREAD_TIMEOUT_MS) {
      // Thread has timed out, remove it
      this.activeThreads.delete(conversationId);
      console.log("🕐 THREAD TIMEOUT - removing inactive thread", {
        conversationId: conversationId.slice(0, 8) + "...",
        timeoutMinutes: Math.round(timeSinceLastActivity / (60 * 1000)),
      });
      return false;
    }

    // Check if this user is participating in the thread
    const isParticipating = thread.participatingUsers.has(senderInboxId);

    if (!isParticipating) {
      return false;
    }

    // SPECIAL HANDLING: If user has pending transaction or is in active flow,
    // always consider them engaged to allow follow-up messages
    const creatorAddress = await this.getCreatorAddressFromInboxId(
      senderInboxId
    );
    if (creatorAddress) {
      const groupState = await this.sessionManager.getGroupState(
        creatorAddress,
        conversationId
      );
      const hasActiveFlow =
        groupState.pendingTransaction ||
        groupState.onboardingProgress ||
        groupState.managementProgress ||
        groupState.coinLaunchProgress;

      if (hasActiveFlow) {
        console.log("⚡ ACTIVE FLOW DETECTED - skipping engagement check", {
          conversationId: conversationId.slice(0, 8) + "...",
          userId: senderInboxId.slice(0, 8) + "...",
          pendingTx: groupState.pendingTransaction?.type,
          onboarding: !!groupState.onboardingProgress,
          management: !!groupState.managementProgress,
          coinLaunch: !!groupState.coinLaunchProgress,
        });

        // Update thread activity and return true
        await this.updateThreadActivity(conversationId, senderInboxId);
        return true;
      }
    }

    // Use improved LLM to check if user is still engaging with the bot
    const messageText = this.extractMessageText(message);
    const engagementResult = await this.checkConversationEngagement(
      messageText,
      conversationId,
      senderInboxId,
      "active_thread",
      message
    );

    if (!engagementResult.isEngaged) {
      // Remove this user from the thread - they've moved on
      thread.participatingUsers.delete(senderInboxId);
      console.log("👋 USER DISENGAGED - removing from thread", {
        conversationId: conversationId.slice(0, 8) + "...",
        userId: senderInboxId.slice(0, 8) + "...",
        messageText: messageText.substring(0, 50) + "...",
        reason: engagementResult.reason,
      });
      return false;
    }

    // Also check if this message is a direct response to recent agent activity
    const isRecentResponse = await this.isRecentResponseToAgent(
      message,
      thread.lastAgentMessageTime
    );

    return isParticipating || isRecentResponse;
  }

  /**
   * Fetch and filter the previous text messages from conversation history
   * Only returns actual text messages, excluding read receipts, reactions, etc.
   * Excludes the latest message since it's provided separately
   */
  private async fetchTextMessageHistory(
    conversationId: string,
    latestMessageId: string,
    limit: number = 10
  ): Promise<
    Array<{
      senderInboxId: string;
      content: string;
      timestamp: Date;
      isBot: boolean;
    }>
  > {
    try {
      const conversation = await this.client.conversations.getConversationById(
        conversationId
      );
      if (!conversation) return [];

      // Fetch more messages than needed to account for filtering
      const messages = await conversation.messages({
        limit: limit * 3,
        direction: 1,
      }); // Descending order
      const textMessages = [];

      for (const message of messages) {
        // Skip the latest message since it's provided separately
        if (message.id === latestMessageId) {
          continue;
        }

        const contentTypeId = message.contentType?.typeId;

        // Skip read receipts, wallet send calls, and other non-text types
        if (
          contentTypeId === "readReceipt" ||
          contentTypeId === "wallet-send-calls" ||
          message.contentType?.sameAs(ContentTypeTransactionReference) ||
          message.contentType?.sameAs(ContentTypeRemoteAttachment)
        ) {
          continue;
        }

        // Skip transaction receipt messages with '...' content
        if (
          typeof message.content === "string" &&
          message.content.trim() === "..."
        ) {
          continue;
        }

        // Extract text content
        const textContent = this.extractMessageText(message);
        if (textContent && textContent.trim().length > 0) {
          textMessages.push({
            senderInboxId: message.senderInboxId,
            content: textContent.trim(),
            timestamp: new Date(message.sentAt),
            isBot: message.senderInboxId === this.client.inboxId,
          });

          // Stop when we have enough text messages
          if (textMessages.length >= limit) {
            break;
          }
        }
      }

      // Reverse to get chronological order (oldest first)
      return textMessages.reverse();
    } catch (error) {
      console.error("Error fetching text message history:", error);
      return [];
    }
  }

  /**
   * Use LLM to determine conversation engagement with proper context
   * Handles both initial engagement detection and ongoing conversation analysis
   */
  private async checkConversationEngagement(
    messageText: string,
    conversationId: string,
    senderInboxId: string,
    context: "new_message" | "active_thread",
    primaryMessage: DecodedMessage
  ): Promise<{ isEngaged: boolean; reason: string }> {
    if (!messageText) return { isEngaged: false, reason: "empty_message" };

    try {
      // Fetch previous text messages for context
      const messageHistory = await this.fetchTextMessageHistory(
        conversationId,
        primaryMessage.id,
        10
      );

      const contextualPrompt =
        context === "active_thread"
          ? this.buildActiveThreadPrompt(messageText, messageHistory)
          : this.buildNewMessagePrompt(messageText, messageHistory);

      const response = await this.openai.chat.completions.create({
        model: "gpt-4o-mini",
        messages: [{ role: "user", content: contextualPrompt }],
        max_tokens: 20,
        temperature: 0,
      });

      const result = response.choices[0]?.message?.content?.trim();
      const [answer, ...reasonParts] = result?.split(":") || [];
      const isEngaged = answer?.toUpperCase() === "YES";
      const reason = reasonParts.join(":").trim() || answer;

      console.log("🤖 ENGAGEMENT CHECK", {
        context,
        userId: senderInboxId.slice(0, 8) + "...",
        messageText: messageText.substring(0, 50) + "...",
        historyMessages: messageHistory.length,
        result: answer,
        reason,
        isEngaged,
      });

      return { isEngaged, reason };
    } catch (error) {
      console.error("Error checking conversation engagement:", error);
      // On error, be conservative based on context
      const fallbackEngaged = context === "active_thread";
      return { isEngaged: fallbackEngaged, reason: "llm_error" };
    }
  }

  private buildActiveThreadPrompt(
    messageText: string,
    messageHistory: Array<{
      senderInboxId: string;
      content: string;
      timestamp: Date;
      isBot: boolean;
    }>
  ): string {
    // Format message history for context
    const historyContext =
      messageHistory.length > 0
        ? `RECENT CONVERSATION HISTORY (last ${messageHistory.length} messages):\n` +
          messageHistory
            .map((msg, index) => {
              const sender = msg.isBot
                ? "Bot (flaunchy)"
                : `User (${msg.senderInboxId.slice(0, 8)}...)`;
              return `${index + 1}. ${sender}: "${msg.content}"`;
            })
            .join("\n") +
          "\n\n"
        : "";

    return `You are analyzing if a user is still engaged with bot "flaunchy" in an ACTIVE conversation thread.

CONTEXT: User was previously talking to flaunchy and is in an active conversation thread.

${historyContext}LATEST USER MESSAGE: "${messageText}"

Is the user still engaged with flaunchy? Be STRICT and consider the conversation context:

ENGAGED (respond "YES:continuing"):
- Asking questions about bot features: "what can you do?", "how does this work?"
- Continuing bot topics: groups, coins, fees, transactions
- Providing requested information: usernames, addresses, confirmations
- Direct responses to bot: "yes", "ok", "go ahead"
- Bot-related requests: "show my groups", "launch a coin"
- Modification requests: "remove user", "add person", "change percentage", "exclude someone"
- User management: "remove alice", "add bob", "kick user", "exclude person"
- Group/coin modifications: "change that", "remove noblet", "add javery", "exclude @user"
- Continuing previous bot-related conversations based on history

DISENGAGED (respond "NO:reason"):
- Greeting others: "hey alice", "hi bob" → "NO:greeting_others"
- General chat without bot context: "lol", "nice", "cool" → "NO:general_chat"  
- Unrelated topics: "what's for lunch?" → "NO:off_topic"
- Side conversations about non-bot things → "NO:side_conversation"
- Completely switching topics from bot conversation → "NO:topic_switch"

IMPORTANT: 
- Use the conversation history to understand context better
- Look at both bot messages and user messages to understand the conversation flow
- If user says "remove [username]" or "add [username]" in context of group creation, they are continuing the bot interaction
- Consider whether the latest message relates to the previous conversation flow

Respond: "YES:continuing" or "NO:reason"`;
  }

  private buildNewMessagePrompt(
    messageText: string,
    messageHistory: Array<{
      senderInboxId: string;
      content: string;
      timestamp: Date;
      isBot: boolean;
    }>
  ): string {
    // Format message history for context
    const historyContext =
      messageHistory.length > 0
        ? `RECENT CONVERSATION HISTORY (last ${messageHistory.length} messages):\n` +
          messageHistory
            .map((msg, index) => {
              const sender = msg.isBot
                ? "Bot (flaunchy)"
                : `User (${msg.senderInboxId.slice(0, 8)}...)`;
              return `${index + 1}. ${sender}: "${msg.content}"`;
            })
            .join("\n") +
          "\n\n"
        : "";

    return `You are analyzing if a user wants to engage with bot "flaunchy" in a group chat.

CONTEXT: Most obvious mentions like "@flaunchy" and "hey flaunchy" are pre-filtered. You handle BOT COMMANDS and edge cases.

${historyContext}LATEST USER MESSAGE: "${messageText}"

Does this message want to engage with flaunchy? Consider the conversation context:

ENGAGE (respond "YES:reason"):
- Bot commands: "launch a coin", "show my coins" → "YES:bot_command"
- Bot name + action: "flaunchy add javery", "flaunchy help" → "YES:bot_command"
- Help requests: "help", "what can you do", "how does this work" → "YES:help_request"
- Bot actions: "start", "begin", "initialize" → "YES:action_request"
- Addressing flaunchy: "ok flaunchy let's...", "sure flaunchy...", "alright flaunchy..." → "YES:addressing_bot"
- Creative mentions: "flaunchy?", "yo flaunchy!" → "YES:creative_mention"
- Continuing previous bot-related conversations based on history → "YES:continuing_conversation"

CRITICAL: COIN LAUNCH PATTERNS (respond "YES:coin_launch"):
- Token/coin specifications: "Launch Test (TEST)", "MyCoin (MCN)", "DOGE token" → "YES:coin_launch"
- Coin launch requests: "launch a coin", "create a token", "flaunch DOGE" → "YES:coin_launch"
- Coin parameters: "Banana (BNAA) with $100 market cap", "Token ABC with 30 minute fair launch" → "YES:coin_launch"
- Ticker patterns: "TEST", "DOGE", "MCN", "BTC" (when clearly meant as coin tickers) → "YES:coin_launch"
- Launch commands: "launch [anything]", "create [token/coin]", "flaunch [anything]" → "YES:coin_launch"

DO NOT ENGAGE (respond "NO:reason"):
- General greetings: "hi", "hello", "hey" (without bot name) → "NO:general_greeting"
- Casual chat: "what's up", "how are you", "nice", "cool" → "NO:casual_chat"
- Pure social talk: "hey alice", "bob how are you" (not involving bot) → "NO:talking_to_others"
- Unrelated topics: "what's for lunch", "did you see the game" → "NO:off_topic"
- Random messages unrelated to previous bot conversation → "NO:unrelated_to_context"

IMPORTANT: 
- Use the conversation history to understand context better
- Look at both bot messages and user messages to understand the conversation flow
- If someone says "flaunchy [action]" like "flaunchy add javery please" they are clearly addressing the bot
- Coin launch patterns like "Launch Test (TEST)" are core bot functionality and should ALWAYS trigger engagement
- Consider whether the latest message relates to or continues a previous bot conversation

Respond: "YES:reason" or "NO:reason"`;
  }

  /**
   * Check if message is a recent response to agent activity
   */
  private async isRecentResponseToAgent(
    message: DecodedMessage,
    lastAgentTime: Date
  ): Promise<boolean> {
    try {
      const conversation = await this.client.conversations.getConversationById(
        message.conversationId
      );
      if (!conversation) return false;

      // Get recent messages to check sequence
      const messages = await conversation.messages({ limit: 10, direction: 1 }); // Descending order

      // Find messages between the last agent activity and now
      const messageTime = new Date(message.sentAt);
      const timeSinceAgent = messageTime.getTime() - lastAgentTime.getTime();

      // Consider it a recent response if within 2 minutes of agent activity
      // This prevents bot from being overly eager to continue conversations
      if (timeSinceAgent > 0 && timeSinceAgent < 2 * 60 * 1000) {
        // Check if there are mostly user messages since agent activity
        const recentMessages = messages.filter((msg: any) => {
          const msgTime = new Date(msg.sentAt);
          return msgTime.getTime() > lastAgentTime.getTime();
        });

        const agentMessagesCount = recentMessages.filter(
          (msg: any) => msg.senderInboxId === this.client.inboxId
        ).length;
        const userMessagesCount = recentMessages.length - agentMessagesCount;

        // If mostly user messages since agent activity, consider it a response
        return userMessagesCount >= agentMessagesCount;
      }

      return false;
    } catch (error) {
      console.error("Error checking recent response:", error);
      return false;
    }
  }

  /**
   * Update active thread when agent is mentioned or responds
   */
  private async updateActiveThread(
    conversationId: string,
    mentioningUserId: string,
    message: DecodedMessage
  ): Promise<void> {
    const now = new Date();
    let thread = this.activeThreads.get(conversationId);

    if (!thread) {
      thread = {
        lastAgentMessageTime: now,
        participatingUsers: new Set(),
        threadStartTime: now,
      };
      this.activeThreads.set(conversationId, thread);
    }

    // Add the mentioning user to participating users
    thread.participatingUsers.add(mentioningUserId);

    console.log("🧵 THREAD UPDATED", {
      conversationId: conversationId.slice(0, 8) + "...",
      participatingUsers: thread.participatingUsers.size,
      mentioningUser: mentioningUserId.slice(0, 8) + "...",
    });
  }

  /**
   * Update thread activity when user responds in active thread
   */
  private async updateThreadActivity(
    conversationId: string,
    userId: string
  ): Promise<void> {
    const thread = this.activeThreads.get(conversationId);
    if (thread) {
      thread.participatingUsers.add(userId);
    }
  }

  /**
   * Call this when agent sends a message to update thread state
   */
  private updateThreadWithAgentMessage(conversationId: string): void {
    const thread = this.activeThreads.get(conversationId);
    if (thread) {
      thread.lastAgentMessageTime = new Date();

      console.log("🤖 AGENT MESSAGE SENT - thread updated", {
        conversationId: conversationId.slice(0, 8) + "...",
        timestamp: thread.lastAgentMessageTime.toISOString(),
      });
    }
  }

  /**
   * Check if the message is a reply to one of the agent's messages
   */
  private async isReplyToAgentMessage(
    message: DecodedMessage
  ): Promise<boolean> {
    try {
      // Check if this message has reply content type
      if (!message.contentType?.sameAs(ContentTypeReply)) {
        return false;
      }

      const replyContent = message.content as Reply;

      console.log("🔍 REPLY MESSAGE DEBUG", {
        contentType: message.contentType.toString(),
        hasReference: !!replyContent.reference,
        referenceType: typeof replyContent.reference,
        referenceValue: replyContent.reference
          ? (replyContent.reference as string).slice(0, 16) + "..."
          : "none",
        replyContentKeys: Object.keys(replyContent || {}),
        messageContent: replyContent.content
          ? replyContent.content.toString().substring(0, 50) + "..."
          : "no-content",
      });

      // Get the referenced message ID
      if (!replyContent.reference) {
        console.log("❌ No reference found in reply content");
        return false;
      }

      // Get the conversation to look up the referenced message
      const conversation = await this.client.conversations.getConversationById(
        message.conversationId
      );
      if (!conversation) {
        return false;
      }

      // Get more messages to find the referenced message (increase limit)
      const messages = await conversation.messages({
        limit: 100,
        direction: 1,
      }); // Descending order

      console.log("🔍 MESSAGE HISTORY", {
        messages,
      });

      // Enhanced debugging for message ID comparison
      const referenceId = replyContent.reference as string;

      // Log first 10 message IDs with full details
      const messageDetails = messages.slice(0, 10).map((msg: any, index) => ({
        index,
        id: msg.id,
        idType: typeof msg.id,
        idLength: msg.id?.length,
        idSliced: msg.id?.slice(0, 16) + "...",
        isAgent: msg.senderInboxId === this.client.inboxId,
        sender: msg.senderInboxId?.slice(0, 8) + "...",
        exactMatch: msg.id === referenceId,
        sentAt: msg.sentAt,
      }));

      console.log("🔍 MESSAGE ID COMPARISON", {
        searchingFor: referenceId,
        messageDetails,
      });

      // Find the message being replied to
      const referencedMessage = messages.find(
        (msg: any) => msg.id === referenceId
      );

      if (!referencedMessage) {
        console.log("❌ REPLY REFERENCE NOT FOUND - IGNORING MESSAGE", {
          referenceId: referenceId?.slice(0, 16) + "...",
          totalMessagesSearched: messages.length,
          reason: "reference_not_found",
        });

        // NO FALLBACK - If it's not a reply to an agent message, ignore it completely
        return false;
      }

      // Check if the referenced message was sent by this agent
      const isFromAgent =
        referencedMessage.senderInboxId === this.client.inboxId;

      if (isFromAgent) {
        console.log("✅ Confirmed reply to agent message");
      }

      return isFromAgent;
    } catch (error) {
      console.error("Error checking if message is reply to agent:", error);
      return false;
    }
  }

  /**
   * Check if the message is a reply to an image attachment during coin data collection
   */
  private async isReplyToImageAttachment(
    message: DecodedMessage,
    conversation: any,
    groupState: any
  ): Promise<boolean> {
    try {
      // First check if we're in coin data collection step
      if (groupState.coinLaunchProgress?.step !== "collecting_coin_data") {
        return false;
      }

      // Check if this message has reply content type
      if (!message.contentType?.sameAs(ContentTypeReply)) {
        return false;
      }

      const replyContent = message.content as Reply;

      // Get the referenced message ID
      if (!replyContent.reference) {
        return false;
      }

      // Get more messages to find the referenced message
      const messages = await conversation.messages({
        limit: 100,
        direction: 1,
      }); // Descending order
      const referenceId = replyContent.reference as string;

      // Find the message being replied to
      const referencedMessage = messages.find(
        (msg: any) => msg.id === referenceId
      );

      if (!referencedMessage) {
        console.log("❌ REPLY TO IMAGE: Referenced message not found", {
          referenceId: referenceId?.slice(0, 16) + "...",
        });
        return false;
      }

      // Check if the referenced message is an image attachment
      const isImageAttachment = referencedMessage.contentType?.sameAs(
        ContentTypeRemoteAttachment
      );

      if (isImageAttachment) {
        console.log(
          "✅ REPLY TO IMAGE: Found reply to image attachment during coin data collection",
          {
            referenceId: referenceId?.slice(0, 16) + "...",
            step: groupState.coinLaunchProgress?.step,
          }
        );
        return true;
      }

      return false;
    } catch (error) {
      console.error(
        "Error checking if message is reply to image attachment:",
        error
      );
      return false;
    }
  }

  /**
   * Check if we should use reply format due to intervening messages from other users
   */
  private async shouldUseReplyFormat(
    originalMessage: DecodedMessage,
    conversation: any,
    agentInboxId: string
  ): Promise<boolean> {
    try {
      // Get recent messages to check for intervening messages
      const messages = await conversation.messages({ limit: 20, direction: 1 }); // Descending order

      // Find the index of the original message
      const originalMessageIndex = messages.findIndex(
        (msg: any) => msg.id === originalMessage.id
      );

      if (originalMessageIndex === -1) {
        console.log(
          "🔍 Original message not found in recent messages, defaulting to normal message"
        );
        return false;
      }

      // Check messages that came after the original message (before it in the array since newest first)
      const messagesAfterOriginal = messages.slice(0, originalMessageIndex);

      // Look for messages from users other than the agent and the original sender
      const interveningMessages = messagesAfterOriginal.filter(
        (msg: any) =>
          msg.senderInboxId !== agentInboxId &&
          msg.senderInboxId !== originalMessage.senderInboxId
      );

      const shouldUseReply = interveningMessages.length > 0;

      if (shouldUseReply) {
        console.log("📨 Using reply format due to intervening messages", {
          originalMessageId: originalMessage.id.slice(0, 16) + "...",
          originalSender: originalMessage.senderInboxId.slice(0, 8) + "...",
          interveningMessages: interveningMessages.length,
          interveningSenders: interveningMessages.map(
            (msg: any) => msg.senderInboxId.slice(0, 8) + "..."
          ),
        });
      } else {
        console.log("📝 Using normal message format - no intervening messages");
      }

      return shouldUseReply;
    } catch (error) {
      console.error("Error checking for intervening messages:", error);
      return false; // Default to normal message on error
    }
  }

  /**
   * Check if this is a direct message (1-on-1 conversation)
   * Skip paw reactions in direct messages since we'll always reply directly
   */
  private async isDirectMessage(conversation: any): Promise<boolean> {
    try {
      // Get conversation members to determine if it's a direct message
      // In XMTP, a direct message has exactly 2 members (user + agent)
      const members = await conversation.members();
      const memberCount = members ? members.length : 0;

      console.log("📊 Conversation type check", {
        conversationId: conversation.id?.slice(0, 16) + "...",
        memberCount,
        isDirectMessage: memberCount === 2,
      });

      return memberCount === 2;
    } catch (error) {
      console.error("Error checking if direct message:", error);
      // Default to false (assume group chat) if we can't determine
      // This ensures paw reactions are sent when in doubt
      return false;
    }
  }

  private async getCreatorAddressFromInboxId(
    inboxId: string
  ): Promise<string | undefined> {
    try {
      // Use the same pattern as in processCoordinatedMessages
      const inboxState = await this.client.preferences.inboxStateFromInboxIds([
        inboxId,
      ]);
      const creatorAddress = inboxState[0]?.identifiers[0]?.identifier || "";
      return creatorAddress.startsWith("0x") ? creatorAddress : undefined;
    } catch (error) {
      console.error("Error getting creator address from inbox ID:", error);
      return undefined;
    }
  }

  /**
   * Ensure that a group exists in the user state for all chat room members
   * This creates the group if it doesn't exist
   */
  private async ensureGroupExistsForChatRoom(
    conversation: any,
    groupAddress: string,
    chainId: number,
    chainName: "base" | "baseSepolia"
  ): Promise<void> {
    try {
      // Get all chat room members
      const members = await conversation.members();

      // Generate a fun group name
      const groupName = `Chat Room ${groupAddress.slice(
        0,
        6
      )}...${groupAddress.slice(-4)}`;

      // Get all member addresses and create receivers array
      const receivers = [];
      for (const member of members) {
        if (member.inboxId !== this.client.inboxId) {
          const memberInboxState =
            await this.client.preferences.inboxStateFromInboxIds([
              member.inboxId,
            ]);
          if (
            memberInboxState.length > 0 &&
            memberInboxState[0].identifiers.length > 0
          ) {
            const memberAddress = memberInboxState[0].identifiers[0].identifier;
            receivers.push({
              username: `${memberAddress.slice(0, 6)}...${memberAddress.slice(
                -4
              )}`,
              resolvedAddress: memberAddress,
              percentage: 100 / (members.length - 1), // Equal split excluding bot
            });
          }
        }
      }

      // Create the group object
      const newGroup = {
        id: groupAddress,
        name: groupName,
        createdBy: conversation.creatorInboxId || "unknown",
        type: "username_split" as const,
        receivers,
        coins: [],
        chainId,
        chainName,
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      // Add the group to all members who don't have it
      const promises = receivers.map(async (receiver) => {
        const userState = await this.sessionManager.getUserState(
          receiver.resolvedAddress
        );

        // Check if they already have this group
        const existingGroup = userState.groups.find(
          (g) => g.id.toLowerCase() === groupAddress.toLowerCase()
        );

        if (!existingGroup) {
          await this.sessionManager.addGroup(
            receiver.resolvedAddress,
            newGroup
          );
        }
      });

      await Promise.all(promises);

      console.log(
        `[GroupCreation] Created group ${groupAddress} for ${receivers.length} members`
      );
    } catch (error) {
      console.error(`Failed to ensure group exists for chat room:`, error);
    }
  }

  /**
   * Ensure that a group exists properly for chat room coin launches
   * This uses GroupStorageService to create the group with proper structure
   */
  private async ensureGroupExistsForChatRoomLaunch(
    conversation: any,
    groupAddress: string,
    chainId: number,
    chainName: "base" | "baseSepolia",
    creatorAddress: string
  ): Promise<void> {
    try {
      console.log(
        `[GroupCreation] Ensuring group ${groupAddress} exists for chat room launch`
      );

      // Check if the creator already has this group
      const creatorState = await this.sessionManager.getUserState(
        creatorAddress
      );
      const existingGroup = creatorState.groups.find(
        (g) => g.id.toLowerCase() === groupAddress.toLowerCase()
      );

      if (existingGroup) {
        console.log(
          `[GroupCreation] Group ${groupAddress} already exists for creator - skipping creation`
        );
        return;
      }

      // Get all chat room members
      const members = await conversation.members();
      console.log(
        `[GroupCreation] Found ${members.length} total members (including bot)`
      );

      // Get all member addresses and create receivers array
      const receivers = [];
      for (const member of members) {
        if (member.inboxId !== this.client.inboxId) {
          const memberInboxState =
            await this.client.preferences.inboxStateFromInboxIds([
              member.inboxId,
            ]);
          if (
            memberInboxState.length > 0 &&
            memberInboxState[0].identifiers.length > 0
          ) {
            const memberAddress = memberInboxState[0].identifiers[0].identifier;

            // Try to resolve address to username/ENS
            let username = memberAddress;
            try {
              const resolvedName =
                await this.ensResolverService.resolveSingleAddress(
                  memberAddress
                );
              if (resolvedName) {
                username = resolvedName;
              }
            } catch (error) {
              // If resolution fails, use shortened address as fallback
              username = `${memberAddress.slice(0, 6)}...${memberAddress.slice(
                -4
              )}`;
            }

            receivers.push({
              username: username,
              resolvedAddress: memberAddress,
              percentage: 100 / (members.length - 1), // Equal split excluding bot
            });

            console.log(
              `[GroupCreation] Added receiver: ${username} (${memberAddress})`
            );
          }
        }
      }

      if (receivers.length === 0) {
        console.error(
          "❌ No valid receivers found for chat room group creation"
        );
        return;
      }

      console.log(
        `[GroupCreation] Created ${receivers.length} receivers for group ${groupAddress}`
      );
      console.log(`[GroupCreation] Creator address: ${creatorAddress}`);

      // Use GroupStorageService to create the group properly
      const groupName =
        await this.groupStorageService.storeGroupForAllReceivers(
          conversation.creatorInboxId || "unknown",
          creatorAddress,
          groupAddress,
          receivers,
          chainId,
          chainName,
          "chat-room-launch" // Use a placeholder tx hash for chat room launches
        );

      console.log(
        `[GroupCreation] ✅ Created group "${groupName}" (${groupAddress}) for ${receivers.length} chat room members`
      );

      // Verify the group was created for the creator
      const updatedCreatorState = await this.sessionManager.getUserState(
        creatorAddress
      );
      const creatorGroup = updatedCreatorState.groups.find(
        (g) => g.id.toLowerCase() === groupAddress.toLowerCase()
      );

      if (creatorGroup) {
        console.log(
          `[GroupCreation] ✅ Verified group exists in creator's state`
        );
      } else {
        console.error(
          `[GroupCreation] ❌ CRITICAL: Group NOT found in creator's state after creation`
        );
        console.error(
          `[GroupCreation] Creator's groups: ${updatedCreatorState.groups
            .map((g) => g.id)
            .join(", ")}`
        );
      }
    } catch (error) {
      console.error(
        `Failed to ensure group exists for chat room launch:`,
        error
      );
    }
  }

  /**
   * Forcefully ensure a group exists for the creator and all chat room members
   * This is a fallback method that doesn't check if the group exists first
   */
  private async forcefullyEnsureGroupForChatRoom(
    conversation: any,
    groupAddress: string,
    chainId: number,
    chainName: "base" | "baseSepolia",
    creatorAddress: string
  ): Promise<void> {
    try {
      console.log(
        `[ForcefulGroupCreation] Forcefully ensuring group ${groupAddress} exists for all chat room members`
      );

      // Get all chat room members
      const members = await conversation.members();

      // Get all member addresses and create receivers array
      const receivers = [];
      const allAddresses = new Set<string>();

      for (const member of members) {
        if (member.inboxId !== this.client.inboxId) {
          const memberInboxState =
            await this.client.preferences.inboxStateFromInboxIds([
              member.inboxId,
            ]);
          if (
            memberInboxState.length > 0 &&
            memberInboxState[0].identifiers.length > 0
          ) {
            const memberAddress = memberInboxState[0].identifiers[0].identifier;
            allAddresses.add(memberAddress.toLowerCase());

            // Try to resolve address to username/ENS
            let username = memberAddress;
            try {
              const resolvedName =
                await this.ensResolverService.resolveSingleAddress(
                  memberAddress
                );
              if (resolvedName) {
                username = resolvedName;
              }
            } catch (error) {
              username = `${memberAddress.slice(0, 6)}...${memberAddress.slice(
                -4
              )}`;
            }

            receivers.push({
              username: username,
              resolvedAddress: memberAddress,
              percentage: 100 / (members.length - 1),
            });
          }
        }
      }

      // Generate a group name
      const groupName = `Chat Room ${groupAddress.slice(
        0,
        6
      )}...${groupAddress.slice(-4)}`;

      // Create the group object
      const newGroup = {
        id: groupAddress,
        name: groupName,
        createdBy: conversation.creatorInboxId || "unknown",
        type: "username_split" as const,
        receivers,
        coins: [],
        chainId,
        chainName,
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      // Forcefully add the group to all addresses
      for (const address of allAddresses) {
        try {
          const userState = await this.sessionManager.getUserState(address);

          // Check if they already have this group
          const existingGroup = userState.groups.find(
            (g) => g.id.toLowerCase() === groupAddress.toLowerCase()
          );

          if (!existingGroup) {
            await this.sessionManager.updateUserState(address, {
              groups: [...userState.groups, newGroup],
            });
            console.log(
              `[ForcefulGroupCreation] ✅ Added group ${groupAddress} to user ${address}`
            );
          } else {
            console.log(
              `[ForcefulGroupCreation] User ${address} already has group ${groupAddress}`
            );
          }
        } catch (error) {
          console.error(
            `[ForcefulGroupCreation] ❌ Failed to add group to ${address}:`,
            error
          );
        }
      }

      console.log(
        `[ForcefulGroupCreation] ✅ Forcefully ensured group ${groupAddress} exists for all chat room members`
      );
    } catch (error) {
      console.error(
        `[ForcefulGroupCreation] ❌ Failed to forcefully ensure group exists:`,
        error
      );
    }
  }
}
