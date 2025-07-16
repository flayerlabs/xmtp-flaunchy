import type { Client, DecodedMessage, Conversation } from "@xmtp/node-sdk";
import type OpenAI from "openai";
import { FlowRouter } from "../flows/FlowRouter";
import { SessionManager } from "../session/SessionManager";
import { FlowContext } from "../types/FlowContext";
import { Character } from "../../../types";
import { ContentTypeRemoteAttachment } from "@xmtp/content-type-remote-attachment";
import { ContentTypeTransactionReference } from "@xmtp/content-type-transaction-reference";
import {
  ContentTypeReaction,
  type Reaction,
} from "@xmtp/content-type-reaction";
import { ContentTypeText } from "@xmtp/content-type-text";
import { ContentTypeReply, type Reply } from "@xmtp/content-type-reply";

// Import all our extracted services
import { MessageTextExtractor } from "./MessageTextExtractor";
import { ImageProcessor } from "./ImageProcessor";
import { UsernameResolver } from "./UsernameResolver";
import { ReplyDetector } from "./ReplyDetector";
import { EngagementDetector } from "./EngagementDetector";
import { ThreadManager } from "./ThreadManager";
import { TransactionReferenceHandler } from "./TransactionReferenceHandler";
import { GroupEnsurer } from "./GroupEnsurer";
import { GroupStorageService } from "../../services/GroupStorageService";
import { ENSResolverService } from "../../services/ENSResolverService";

/**
 * Enhanced Message Coordinator - Refactored to use extracted services
 * Now focuses purely on message coordination and delegation to specialized services
 */
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

  // Extracted services
  private imageProcessor: ImageProcessor;
  private usernameResolver: UsernameResolver;
  private replyDetector: ReplyDetector;
  private engagementDetector: EngagementDetector;
  private threadManager: ThreadManager;
  private transactionReferenceHandler: TransactionReferenceHandler;
  private groupEnsurer: GroupEnsurer;
  private groupStorageService: GroupStorageService;
  private ensResolverService: ENSResolverService;

  constructor(
    private client: Client<any>,
    private openai: OpenAI,
    private character: Character,
    private flowRouter: FlowRouter,
    private sessionManager: SessionManager,
    waitTimeMs = 3000
  ) {
    this.messageQueue = new Map();
    this.waitTimeMs = waitTimeMs;

    // Initialize all services
    this.imageProcessor = new ImageProcessor(this.client);
    this.usernameResolver = new UsernameResolver();
    this.replyDetector = new ReplyDetector(this.client);
    this.engagementDetector = new EngagementDetector(
      this.openai,
      this.character
    );
    this.threadManager = new ThreadManager(
      this.engagementDetector,
      this.usernameResolver,
      this.openai
    );
    this.groupStorageService = new GroupStorageService(this.sessionManager);
    this.ensResolverService = new ENSResolverService();
    this.groupEnsurer = new GroupEnsurer(
      this.client,
      this.sessionManager,
      this.groupStorageService,
      this.ensResolverService
    );
    this.transactionReferenceHandler = new TransactionReferenceHandler(
      this.client,
      this.sessionManager,
      this.groupStorageService
    );
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
      return await this.transactionReferenceHandler.handleTransactionReference(
        message
      );
    }

    // Skip transaction receipt messages that come as text with '...' content
    if (MessageTextExtractor.isTransactionReceipt(message)) {
      console.log("[MessageCoordinator] ⏭️ Skipping transaction receipt");
      return false;
    }

    const isAttachment = MessageTextExtractor.isAttachment(message);
    const conversationId = message.conversationId;

    // Log incoming message
    console.log("📨 INCOMING MESSAGE", {
      conversationId: conversationId,
      senderInboxId: message.senderInboxId,
      contentType: message.contentType?.typeId || "text",
      isAttachment: isAttachment,
      content: MessageTextExtractor.getContentPreview(message),
      timestamp: new Date().toISOString(),
      messageId: message.id,
      contentLength:
        typeof message.content === "string" ? message.content.length : 0,
    });

    // Handle message coordination (text + attachment timing)
    return await this.coordinateMessage(message, isAttachment, conversationId);
  }

  /**
   * Handle message coordination with timing for text + attachment combinations
   */
  private async coordinateMessage(
    message: DecodedMessage,
    isAttachment: boolean,
    conversationId: string
  ): Promise<boolean> {
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
        const currentEntry = this.messageQueue.get(conversationId);
        if (currentEntry?.attachmentMessage) {
          await this.processCoordinatedMessages([
            currentEntry.attachmentMessage,
          ]);
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

      // Check if text message has obvious agent mention
      const messageText = MessageTextExtractor.extractMessageText(message);
      const hasObviousMention =
        this.engagementDetector.detectObviousAgentMention(messageText);

      if (hasObviousMention) {
        // Process immediately for text messages with agent mentions
        const result = await this.processCoordinatedMessages([
          entry.textMessage,
        ]);
        this.messageQueue.delete(conversationId);
        return result;
      } else {
        // Wait briefly for potential attachment only if no agent mention
        entry.timer = setTimeout(async () => {
          const currentEntry = this.messageQueue.get(conversationId);
          if (currentEntry?.textMessage) {
            await this.processCoordinatedMessages([currentEntry.textMessage]);
            this.messageQueue.delete(conversationId);
          }
        }, this.waitTimeMs);

        return false;
      }
    }
  }

  /**
   * Process coordinated messages (text + attachment combinations)
   */
  private async processCoordinatedMessages(
    messages: DecodedMessage[]
  ): Promise<boolean> {
    try {
      // For engagement detection, prioritize text message as primary
      // This ensures proper engagement detection when attachment + text are sent together
      const textMessage = messages.find(
        (msg) => !MessageTextExtractor.isAttachment(msg)
      );

      // Use text message as primary if available, otherwise most recent
      const primaryMessage = textMessage || messages[messages.length - 1];
      const relatedMessages = messages.filter((msg) => msg !== primaryMessage);

      const hasAttachment = messages.some((msg) =>
        MessageTextExtractor.isAttachment(msg)
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
      const isDirectMessage = await this.replyDetector.isDirectMessage(
        conversation
      );

      if (isDirectMessage) {
        return await this.handleDirectMessage(
          primaryMessage,
          relatedMessages,
          conversation
        );
      }

      // Get sender info
      const creatorAddress =
        await this.usernameResolver.getCreatorAddressFromInboxId(
          primaryMessage.senderInboxId,
          this.client
        );

      if (!creatorAddress) {
        console.error("Could not get creator address");
        return false;
      }

      // Get user and group state
      const userState = await this.sessionManager.getUserState(creatorAddress);
      const groupState = await this.sessionManager.getGroupState(
        creatorAddress,
        primaryMessage.conversationId
      );

      // Check if this is a reply to an image attachment during coin data collection
      const isReplyToImage = await this.replyDetector.isReplyToImageAttachment(
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

      // Create flow context and route to appropriate flow
      const context = await this.createFlowContext({
        primaryMessage,
        relatedMessages,
        conversation,
        userState,
        creatorAddress,
        conversationHistory: relatedMessages,
        isDirectMessage: false,
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

  /**
   * Handle direct message processing with flow restrictions
   */
  private async handleDirectMessage(
    primaryMessage: DecodedMessage,
    relatedMessages: DecodedMessage[],
    conversation: Conversation<any>
  ): Promise<boolean> {
    console.log(
      "[MessageCoordinator] 📱 Direct message detected - checking intent before processing"
    );

    const creatorAddress =
      await this.usernameResolver.getCreatorAddressFromInboxId(
        primaryMessage.senderInboxId,
        this.client
      );

    if (!creatorAddress) {
      return false;
    }

    // Get user state for intent detection
    const userState = await this.sessionManager.getUserState(creatorAddress);

    // Create a minimal context for intent detection
    const messageText = MessageTextExtractor.extractCombinedMessageText(
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
    const context = await this.createFlowContext({
      primaryMessage,
      relatedMessages,
      conversation,
      userState,
      creatorAddress,
      conversationHistory: relatedMessages,
      isDirectMessage: true,
      isReplyToImage: false,
    });

    await this.flowRouter.routeMessage(context);
    return true;
  }

  /**
   * Determine if a message should be processed based on engagement patterns
   */
  private async shouldProcessMessage(
    primaryMessage: DecodedMessage,
    conversation: Conversation<any>,
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
    const messageText = MessageTextExtractor.extractCombinedMessageText(
      primaryMessage,
      relatedMessages
    );

    // Check if user is in coin data collection step AND sending image without text
    if (
      groupState.coinLaunchProgress?.step === "collecting_coin_data" &&
      MessageTextExtractor.isAttachment(primaryMessage) &&
      (!messageText || messageText.trim() === "")
    ) {
      console.log("🪙 COIN DATA COLLECTION: Image-only message - processing");

      // Start/update active thread since they're providing content for their coin launch
      await this.threadManager.updateActiveThread(
        primaryMessage.conversationId,
        primaryMessage.senderInboxId,
        primaryMessage
      );
      return true;
    }

    // Check if this is a reply to an image attachment during coin data collection
    if (isReplyToImage) {
      console.log("🪙 COIN DATA COLLECTION: Reply to image - processing");

      // Start/update active thread since they're providing content for their coin launch
      await this.threadManager.updateActiveThread(
        primaryMessage.conversationId,
        primaryMessage.senderInboxId,
        primaryMessage
      );
      return true;
    }

    // Check if this is a reply to a flaunchy message (high confidence engagement)
    const isReplyToAgent = await this.replyDetector.isReplyToAgentMessage(
      primaryMessage
    );

    if (isReplyToAgent) {
      // Special handling for non-text replies (reactions, etc.)
      if (
        !messageText ||
        messageText === "[NON-TEXT]" ||
        messageText.trim() === ""
      ) {
        console.log("🐾 NON-TEXT REPLY TO AGENT");

        // Update thread but don't process through flow router
        await this.threadManager.updateActiveThread(
          primaryMessage.conversationId,
          primaryMessage.senderInboxId,
          primaryMessage
        );
        return false; // Don't continue to flow processing
      }

      console.log(
        "💬 REPLY TO AGENT DETECTED - processing with high confidence"
      );

      // Start/update active thread when user replies to agent
      await this.threadManager.updateActiveThread(
        primaryMessage.conversationId,
        primaryMessage.senderInboxId,
        primaryMessage
      );
      return true;
    }

    // CRITICAL: If this is a reply to someone else (not Flaunchy), only process if explicitly @mentioned
    if (primaryMessage.contentType?.sameAs(ContentTypeReply)) {
      const hasExplicitMention =
        this.engagementDetector.detectExplicitAgentMention(messageText);

      if (!hasExplicitMention) {
        console.log(
          "🚫 REPLY TO OTHER USER - ignoring without explicit @mention"
        );
        return false;
      }

      console.log("✅ REPLY TO OTHER USER with explicit @mention - processing");
    }

    // Fast regex check for obvious mentions (saves LLM calls)
    const hasObviousMention =
      this.engagementDetector.detectObviousAgentMention(messageText);

    if (hasObviousMention) {
      console.log("⚡ OBVIOUS MENTION DETECTED - processing message");

      // Start/update active thread when obviously mentioned
      await this.threadManager.updateActiveThread(
        primaryMessage.conversationId,
        primaryMessage.senderInboxId,
        primaryMessage
      );
      return true;
    }

    // Special case: If this is an attachment-only message and there are related messages
    // with agent mentions, or if user has active engagement, process it
    if (
      MessageTextExtractor.isAttachment(primaryMessage) &&
      (!messageText || messageText.trim() === "")
    ) {
      // Check if any related messages mention the agent
      const relatedMessageTexts = relatedMessages.map((msg) =>
        MessageTextExtractor.extractMessageText(msg)
      );
      const relatedHasMention = relatedMessageTexts.some((text) =>
        this.engagementDetector.detectObviousAgentMention(text)
      );

      if (relatedHasMention) {
        console.log("🖼️ ATTACHMENT with related agent mention - processing");
        await this.threadManager.updateActiveThread(
          primaryMessage.conversationId,
          primaryMessage.senderInboxId,
          primaryMessage
        );
        return true;
      }

      // Check if user has recent engagement in this conversation
      const isInActiveThread = await this.threadManager.isInActiveThread(
        primaryMessage.conversationId,
        primaryMessage.senderInboxId,
        primaryMessage,
        this.sessionManager,
        this.client
      );

      if (isInActiveThread) {
        console.log("🖼️ ATTACHMENT from active user thread - processing");
        await this.threadManager.updateActiveThread(
          primaryMessage.conversationId,
          primaryMessage.senderInboxId,
          primaryMessage
        );
        return true;
      }
    }

    return false;
  }

  /**
   * Create flow context for message processing
   */
  private async createFlowContext({
    primaryMessage,
    relatedMessages,
    conversation,
    userState,
    creatorAddress,
    conversationHistory,
    isDirectMessage,
    isReplyToImage = false,
  }: {
    primaryMessage: DecodedMessage;
    relatedMessages: DecodedMessage[];
    conversation: Conversation<any>;
    userState: any;
    creatorAddress: string;
    conversationHistory: DecodedMessage[];
    isDirectMessage: boolean;
    isReplyToImage?: boolean;
  }): Promise<FlowContext> {
    // Determine message text and attachment info
    const isAttachment = MessageTextExtractor.isAttachment(primaryMessage);
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
        MessageTextExtractor.isAttachment(referencedMessage)
      ) {
        hasAttachment = true;
        attachment = referencedMessage.content;
        console.log(
          "🖼️ REPLY TO IMAGE: Extracted attachment from replied-to message"
        );
      }
    } else if (isAttachment) {
      hasAttachment = true;
      attachment = primaryMessage.content;

      // Look for text in related messages
      const textMessage = relatedMessages.find(
        (msg) => !MessageTextExtractor.isAttachment(msg)
      );
      if (textMessage) {
        messageText =
          MessageTextExtractor.extractMessageText(textMessage).trim();
      }
    } else {
      // Primary message is text (or reply with text)
      messageText =
        MessageTextExtractor.extractMessageText(primaryMessage).trim();

      // Check for attachment in related messages
      const attachmentMessage = relatedMessages.find((msg) =>
        MessageTextExtractor.isAttachment(msg)
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
      senderInboxId: primaryMessage.senderInboxId,
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
        const shouldUseReply = await this.replyDetector.shouldUseReplyFormat(
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

          console.log("💬 Sending reply due to intervening messages");
          await conversation.send(reply, ContentTypeReply);
        } else {
          // Send as normal text message
          await conversation.send(message);
        }

        // Update thread state when agent sends a message
        this.threadManager.updateThreadWithAgentMessage(conversation.id);
      },

      updateState: async (updates: any) => {
        await this.sessionManager.updateUserState(creatorAddress, updates);
      },

      // Group-specific state management
      updateGroupState: async (updates: any) => {
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
        return this.usernameResolver.resolveUsername(username);
      },

      processImageAttachment: async (attachment: any) => {
        return this.imageProcessor.processImageAttachment(attachment);
      },
    };
  }
}
