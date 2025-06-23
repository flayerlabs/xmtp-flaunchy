import type { Client, DecodedMessage, Conversation } from "@xmtp/node-sdk";
import type OpenAI from "openai";
import { FlowRouter } from "../flows/FlowRouter";
import { SessionManager } from "../session/SessionManager";
import { FlowContext } from "../types/FlowContext";
import { UserState } from "../types/UserState";
import { Character } from "../../../types";
import { ContentTypeRemoteAttachment, type RemoteAttachment } from "@xmtp/content-type-remote-attachment";

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
  }

  async processMessage(message: DecodedMessage): Promise<boolean> {
    // Skip messages from the bot itself
    if (message.senderInboxId === this.client.inboxId) {
      return false;
    }

    // Skip wallet send calls but handle transaction receipts
    const contentTypeId = message.contentType?.typeId;
    if (contentTypeId === 'wallet-send-calls') {
      console.log('⏭️ SKIPPING WALLET SEND CALLS', {
        contentType: contentTypeId,
        senderInboxId: message.senderInboxId,
        timestamp: new Date().toISOString()
      });
      return false;
    }

    // Handle transaction receipts and references for success messages
    if (contentTypeId === 'transaction-receipt' || contentTypeId === 'transactionReference') {
      console.log('🧾 PROCESSING TRANSACTION COMPLETION', {
        contentType: contentTypeId,
        senderInboxId: message.senderInboxId,
        timestamp: new Date().toISOString()
      });
      return await this.handleTransactionReceipt(message);
    }

    // Skip transaction receipt messages that come as text with '...' content
    if (typeof message.content === 'string') {
      const trimmedContent = message.content.trim();
      console.log('🔍 CONTENT CHECK', {
        originalContent: JSON.stringify(message.content),
        trimmedContent: JSON.stringify(trimmedContent),
        isTripleDot: trimmedContent === '...',
        contentLength: message.content.length,
        trimmedLength: trimmedContent.length
      });
      
      if (trimmedContent === '...') {
        console.log('⏭️ SKIPPING TRANSACTION RECEIPT', {
          content: message.content,
          senderInboxId: message.senderInboxId,
          timestamp: new Date().toISOString()
        });
        return false;
      }
    }

    const isAttachment = message.contentType?.sameAs(ContentTypeRemoteAttachment);
    const conversationId = message.conversationId;

    // Log incoming message
    console.log('📨 INCOMING MESSAGE', {
      conversationId: conversationId,
      senderInboxId: message.senderInboxId,
      contentType: message.contentType?.typeId || 'text',
      isAttachment: isAttachment,
      content: isAttachment ? '[ATTACHMENT]' : (typeof message.content === 'string' ? message.content : '[NON-TEXT]'),
      timestamp: new Date().toISOString(),
      messageId: message.id,
      contentLength: typeof message.content === 'string' ? message.content.length : 0
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
          entry.attachmentMessage
        ]);
        this.messageQueue.delete(conversationId);
        return result;
      }

      // Set timer to process attachment alone if no text arrives
      entry.timer = setTimeout(async () => {
        if (entry?.attachmentMessage) {
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
          entry.attachmentMessage
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

  private async processCoordinatedMessages(messages: DecodedMessage[]): Promise<boolean> {
    try {
      // Get the primary message (most recent)
      const primaryMessage = messages[messages.length - 1];
      const relatedMessages = messages.slice(0, -1);

      // Log coordinated message processing
      console.log('🔄 PROCESSING COORDINATED MESSAGES', {
        totalMessages: messages.length,
        primaryMessage: {
          id: primaryMessage.id,
          contentType: primaryMessage.contentType?.typeId || 'text',
          isAttachment: primaryMessage.contentType?.sameAs(ContentTypeRemoteAttachment),
          content: primaryMessage.contentType?.sameAs(ContentTypeRemoteAttachment) 
            ? '[ATTACHMENT]' 
            : (typeof primaryMessage.content === 'string' ? primaryMessage.content.substring(0, 100) + '...' : '[NON-TEXT]')
        },
        relatedMessages: relatedMessages.map(msg => ({
          id: msg.id,
          contentType: msg.contentType?.typeId || 'text',
          isAttachment: msg.contentType?.sameAs(ContentTypeRemoteAttachment)
        })),
        timestamp: new Date().toISOString()
      });
      
      // Get conversation
      const conversation = await this.client.conversations.getConversationById(primaryMessage.conversationId);
      if (!conversation) {
        console.error('Could not find conversation');
        return false;
      }

      // Get sender info
      const senderInboxId = primaryMessage.senderInboxId;
      const inboxState = await this.client.preferences.inboxStateFromInboxIds([senderInboxId]);
      const creatorAddress = inboxState[0]?.identifiers[0]?.identifier || '';

      // Get user state
      const userState = await this.sessionManager.getUserState(senderInboxId);

      // Create flow context (using relatedMessages as conversation history for now)
      const context = await this.createFlowContext({
        primaryMessage,
        relatedMessages,
        conversation,
        userState,
        senderInboxId,
        creatorAddress,
        conversationHistory: relatedMessages
      });

      // Route to appropriate flow
      await this.flowRouter.routeMessage(context);
      
      return true;
    } catch (error) {
      console.error('Error processing coordinated messages:', error);
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
    conversationHistory
  }: {
    primaryMessage: DecodedMessage;
    relatedMessages: DecodedMessage[];
    conversation: Conversation<any>;
    userState: UserState;
    senderInboxId: string;
    creatorAddress: string;
    conversationHistory: DecodedMessage[];
  }): Promise<FlowContext> {
    // Determine message text and attachment info
    const isAttachment = primaryMessage.contentType?.sameAs(ContentTypeRemoteAttachment);
    let messageText = '';
    let hasAttachment = false;
    let attachment: any = undefined;

    if (isAttachment) {
      hasAttachment = true;
      attachment = primaryMessage.content;
      
      // Look for text in related messages
      const textMessage = relatedMessages.find(msg => 
        !msg.contentType?.sameAs(ContentTypeRemoteAttachment)
      );
      if (textMessage && typeof textMessage.content === 'string') {
        messageText = textMessage.content.trim();
      }
    } else {
      // Primary message is text
      if (typeof primaryMessage.content === 'string') {
        messageText = primaryMessage.content.trim();
      }
      
      // Check for attachment in related messages
      const attachmentMessage = relatedMessages.find(msg =>
        msg.contentType?.sameAs(ContentTypeRemoteAttachment)
      );
      if (attachmentMessage) {
        hasAttachment = true;
        attachment = attachmentMessage.content;
      }
    }

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
      
      // Session management
      sessionManager: this.sessionManager,

      // Message context
      messageText,
      hasAttachment,
      attachment,
      relatedMessages,
      conversationHistory,

      // Helper functions
      sendResponse: async (message: string) => {
        await conversation.send(message);
      },

      updateState: async (updates: Partial<UserState>) => {
        await this.sessionManager.updateUserState(senderInboxId, updates);
      },

      // Utility functions
      resolveUsername: async (username: string) => {
        return this.resolveUsername(username);
      },

      processImageAttachment: async (attachment: any) => {
        return this.processImageAttachment(attachment);
      }
    };
  }

  private async resolveUsername(username: string): Promise<string | undefined> {
    // TODO: Implement actual username resolution
    // This would integrate with ENS, Farcaster, etc.
    
    // For now, return mock addresses for testing
    if (username.startsWith('@')) {
      // Mock Farcaster resolution
      return '0x' + Math.random().toString(16).substring(2, 42).padStart(40, '0');
    } else if (username.includes('.eth')) {
      // Mock ENS resolution
      return '0x' + Math.random().toString(16).substring(2, 42).padStart(40, '0');
    } else if (/^0x[a-fA-F0-9]{40}$/.test(username)) {
      // Already an address
      return username;
    }
    
    return undefined;
  }

  private async processImageAttachment(attachment: RemoteAttachment): Promise<string> {
    // TODO: Implement actual image processing
    // This would handle decryption, IPFS upload, etc.
    
    // For now, return mock IPFS URL
    await new Promise(resolve => setTimeout(resolve, 1000)); // Simulate processing
    return `ipfs://Qm${Math.random().toString(36).substring(2, 15)}`;
  }

  private async handleTransactionReceipt(message: DecodedMessage): Promise<boolean> {
    try {
      const senderInboxId = message.senderInboxId;
      const userState = await this.sessionManager.getUserState(senderInboxId);
      
      // Check if user has a pending transaction
      if (!userState.pendingTransaction) {
        console.log('No pending transaction found for transaction receipt');
        return false;
      }

      const pendingTx = userState.pendingTransaction;
      const conversation = await this.client.conversations.getConversationById(message.conversationId);
      
      if (!conversation) {
        console.error('Could not find conversation for transaction receipt');
        return false;
      }

      // Extract contract address from transaction receipt
      // This is a simplified version - in reality, you'd parse the actual receipt
      const contractAddress = this.extractContractAddress(message.content);
      
      if (!contractAddress) {
        console.log('Could not extract contract address from transaction receipt');
        return false;
      }

      // Determine network
      const network = pendingTx.network;
      
      // Create success message
      let successMessage: string;
      let url: string;
      
      if (pendingTx.type === 'group_creation') {
        successMessage = `Group created!\n\nCA: ${contractAddress}`;
        url = `https://flaunch.gg/${network}/groups/${contractAddress}`;
      } else {
        successMessage = `Coin created!\n\nCA: ${contractAddress}`;
        url = `https://flaunch.gg/${network}/coins/${contractAddress}`;
      }
      
      successMessage += `\n\n${url}`;
      
      // Send success message
      await conversation.send(successMessage);
      
      // Generate next steps in character's voice
      const nextStepsMessage = await this.generateNextStepsMessage(pendingTx.type);
      await conversation.send(nextStepsMessage);
      
      // Update user state - clear pending transaction and update coin/group data
      await this.sessionManager.updateUserState(senderInboxId, {
        pendingTransaction: undefined,
        // Add the launched coin to user's collection
        ...(pendingTx.coinData && {
          coins: [
            ...userState.coins,
            {
              ticker: pendingTx.coinData.ticker,
              name: pendingTx.coinData.name,
              image: pendingTx.coinData.image,
              groupId: pendingTx.type === 'group_creation' ? contractAddress : 'existing-group',
              contractAddress,
              launched: true,
              fairLaunchDuration: 30 * 60, // 30 minutes
              fairLaunchPercent: 40,
              initialMarketCap: 1000,
              createdAt: new Date()
            }
          ]
        })
      });

      console.log('Successfully processed transaction receipt and sent success message', {
        type: pendingTx.type,
        contractAddress,
        network,
        url
      });

      return true;
    } catch (error) {
      console.error('Error handling transaction receipt:', error);
      return false;
    }
  }

  private extractContractAddress(content: any): string | null {
    console.log('🔍 EXTRACTING CONTRACT ADDRESS', {
      contentType: typeof content,
      content: JSON.stringify(content, null, 2)
    });

    // Try to extract from transaction reference object
    if (content && typeof content === 'object') {
      // Check for memecoin/memecoinAddress fields first (Flaunch-specific)
      if (content.memecoin) {
        console.log('Found memecoin address:', content.memecoin);
        return content.memecoin;
      }
      if (content.memecoinAddress) {
        console.log('Found memecoinAddress:', content.memecoinAddress);
        return content.memecoinAddress;
      }
      
      // Fallback to common fields
      if (content.contractAddress) {
        return content.contractAddress;
      }
      if (content.to) {
        return content.to;
      }
      if (content.address) {
        return content.address;
      }
      if (content.hash) {
        // Sometimes transaction hash is provided instead
        console.log('Found transaction hash, using for demonstration:', content.hash);
      }
    }

    // Try to extract from string content
    if (typeof content === 'string' && content.includes('0x')) {
      const match = content.match(/0x[a-fA-F0-9]{40}/);
      if (match) {
        return match[0];
      }
    }
    
    // For demonstration purposes, generate a mock contract address
    // In production, you'd need to fetch the actual contract address from the transaction receipt
    const mockAddress = `0x${Math.random().toString(16).substring(2, 42).padStart(40, '0')}`;
    console.log('🎭 Generated mock contract address for demonstration:', mockAddress);
    return mockAddress;
  }

  private async generateNextStepsMessage(transactionType: 'group_creation' | 'coin_creation'): Promise<string> {
    const { getCharacterResponse } = await import('../../../utils/character');
    
    const prompt = transactionType === 'group_creation' 
      ? `The user just successfully created a Group. Tell them what they can do next: they can ask for details on their Groups or Coins, launch more coins into any of their Groups, and claim fees through you. Ask if there's anything more they'd like to do. Use your character's voice and style.`
      : `The user just successfully created a Coin. Tell them what they can do next: they can ask for details on their Groups or Coins, launch more coins into any of their Groups, and claim fees through you. Ask if there's anything more they'd like to do. Use your character's voice and style.`;

    return await getCharacterResponse({
      openai: this.openai,
      character: this.character,
      prompt
    });
  }


} 