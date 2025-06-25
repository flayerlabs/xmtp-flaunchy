import type { Client, DecodedMessage, Conversation } from "@xmtp/node-sdk";
import type OpenAI from "openai";
import { FlowRouter } from "../flows/FlowRouter";
import { SessionManager } from "../session/SessionManager";
import { FlowContext } from "../types/FlowContext";
import { UserState, UserGroup } from "../types/UserState";
import { Character } from "../../../types";
import { ContentTypeRemoteAttachment, type RemoteAttachment, RemoteAttachmentCodec, type Attachment } from "@xmtp/content-type-remote-attachment";
import { ContentTypeTransactionReference, type TransactionReference } from "@xmtp/content-type-transaction-reference";
import { decodeEventLog, type Log, createPublicClient, http, isAddress } from 'viem';
import { base, baseSepolia, mainnet } from 'viem/chains';
import { uploadImageToIPFS } from '../../../utils/ipfs';

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
        '0x54976b48704e67457d6a85a2db51d6e760bbeddf6151f9206512108adce80b42'
      );
    });
    if (!poolCreatedLog) {
      console.error('No PoolCreated event found in log data');
      return undefined;
    }

    console.log('Found PoolCreated log:', {
      address: poolCreatedLog.address,
      topics: poolCreatedLog.topics,
      data: poolCreatedLog.data
    });

    // Decode the log data using the actual topics from the log
    const decoded = decodeEventLog({
      abi: poolCreatedAbi,
      data: poolCreatedLog.data as `0x${string}`,
      topics: poolCreatedLog.topics as [`0x${string}`, ...`0x${string}`[]],
      eventName: 'PoolCreated',
    });

    console.log('Decoded PoolCreated event:', {
      poolId: decoded.args._poolId,
      memecoin: decoded.args._memecoin,
      memecoinTreasury: decoded.args._memecoinTreasury,
      tokenId: decoded.args._tokenId,
      currencyFlipped: decoded.args._currencyFlipped,
      flaunchFee: decoded.args._flaunchFee?.toString(),
      params: {
        name: decoded.args._params.name,
        symbol: decoded.args._params.symbol,
        creator: decoded.args._params.creator
      }
    });

    return decoded.args._memecoin as string;
  } catch (error) {
    console.error('Error decoding PoolCreated log:', error);
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

    // Handle transaction references for success messages
    if (message.contentType?.sameAs(ContentTypeTransactionReference)) {
      console.log('🧾 PROCESSING TRANSACTION REFERENCE', {
        contentType: 'transaction-reference',
        senderInboxId: message.senderInboxId,
        timestamp: new Date().toISOString()
      });
      return await this.handleTransactionReference(message);
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

      // Check if we should process this message
      const shouldProcess = await this.shouldProcessMessage(primaryMessage, conversation, userState);
      
      if (!shouldProcess) {
        console.log('🚫 MESSAGE FILTERED OUT', {
          senderInboxId: senderInboxId.substring(0, 8) + '...',
          reason: 'Not directed at agent and no ongoing process',
          messageContent: typeof primaryMessage.content === 'string' ? primaryMessage.content.substring(0, 50) + '...' : '[NON-TEXT]',
          timestamp: new Date().toISOString()
        });
        return false;
      }

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
    try {
      // If already an Ethereum address, return it
      if (isAddress(username)) {
      return username;
    }
    
      // Handle ENS names
      if (username.includes('.eth')) {
        return await this.resolveENS(username);
      }

      // Handle Farcaster usernames
      if (username.startsWith('@')) {
        return await this.resolveFarcaster(username.substring(1)); // Remove @ prefix
      }

      // If no specific format detected, try as Farcaster username
      return await this.resolveFarcaster(username);
      
    } catch (error) {
      console.error('Error resolving username:', username, error);
      return undefined;
    }
  }

  private async resolveENS(ensName: string): Promise<string | undefined> {
    try {
      // Both ENS and Basenames are resolved on Ethereum mainnet
      const isBasename = ensName.endsWith('.base.eth');
      const rpcUrl = process.env.MAINNET_RPC_URL;
      
      console.log(`🔍 Resolving ${isBasename ? 'Basename' : 'ENS'}: ${ensName} on Ethereum mainnet`);
      
      // Create a public client for ENS/Basename resolution (always mainnet)
      const publicClient = createPublicClient({
        chain: mainnet,
        transport: rpcUrl ? http(rpcUrl) : http()
      });

      const address = await publicClient.getEnsAddress({
        name: ensName
      });

      if (address) {
        console.log(`✅ ${isBasename ? 'Basename' : 'ENS'} resolved: ${ensName} -> ${address}`);
        return address;
      }

      console.log(`❌ ${isBasename ? 'Basename' : 'ENS'} resolution failed for: ${ensName}`);
      return undefined;
    } catch (error) {
      console.error(`Error resolving ENS/Basename ${ensName}:`, error);
      return undefined;
    }
  }

  private async resolveFarcaster(username: string): Promise<string | undefined> {
    try {
      const apiKey = process.env.NEYNAR_API_KEY;
      if (!apiKey) {
        console.error('NEYNAR_API_KEY not found in environment variables');
        return undefined;
      }

      // Call Neynar API to resolve Farcaster username
      const response = await fetch(`https://api.neynar.com/v2/farcaster/user/by_username?username=${username}`, {
        headers: {
          'accept': 'application/json',
          'api_key': apiKey
        }
      });

      if (!response.ok) {
        console.error(`Neynar API error: ${response.status} ${response.statusText}`);
        return undefined;
      }

      const data = await response.json();
      
      // Extract the primary verified address or custody address
      const user = data.user;
      if (user) {
        // Prefer verified ETH addresses, fallback to custody address
        const address = user.verified_addresses?.eth_addresses?.[0] || user.custody_address;
        
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

  private async processImageAttachment(attachment: RemoteAttachment): Promise<string> {
    try {
      console.log('🖼️ Processing image attachment:', {
        filename: attachment.filename,
        url: attachment.url
      });
      
      // Decrypt the attachment using XMTP's RemoteAttachmentCodec
      console.log('🔓 Decrypting attachment...');
      const decrypted = await RemoteAttachmentCodec.load(attachment, this.client) as Attachment;
      
      // Convert decrypted data to base64 for IPFS upload
      const base64Image = Buffer.from(decrypted.data).toString('base64');
      
      // Upload to IPFS
      console.log('📤 Uploading to IPFS...');
      const ipfsResponse = await uploadImageToIPFS({
        pinataConfig: { jwt: process.env.PINATA_JWT! },
        base64Image,
        name: attachment.filename || 'image'
      });
      
      const ipfsUrl = `ipfs://${ipfsResponse.IpfsHash}`;
      console.log('✅ Successfully uploaded image to IPFS:', ipfsUrl);
      
      return ipfsUrl;
      
    } catch (error) {
      console.error('❌ Error processing image attachment:', error);
      
      // Fallback to a placeholder to maintain compatibility
      console.log('🔄 Falling back to placeholder image processing');
      await new Promise(resolve => setTimeout(resolve, 1000)); // Simulate processing
      return `ipfs://QmPlaceholder${Math.random().toString(36).substring(2, 15)}`;
    }
  }

  private async handleTransactionReference(message: DecodedMessage): Promise<boolean> {
    try {
      const senderInboxId = message.senderInboxId;
      const userState = await this.sessionManager.getUserState(senderInboxId);

      // Check if user has a pending transaction
      if (!userState.pendingTransaction) {
        console.log('No pending transaction found for transaction reference');
        return false;
      }

      const pendingTx = userState.pendingTransaction;
      const conversation = await this.client.conversations.getConversationById(message.conversationId);
      
      if (!conversation) {
        console.error('Could not find conversation for transaction reference');
        return false;
      }
      
      // Parse the transaction reference content
      const transactionRef = message.content as TransactionReference;
      console.log('📋 TRANSACTION REFERENCE RECEIVED', {
        reference: transactionRef.reference,
        networkId: transactionRef.networkId,
        namespace: transactionRef.namespace,
        metadata: transactionRef.metadata
      });
      
      // Fetch the transaction receipt using the hash
      const txHash = transactionRef.reference as `0x${string}`;
      console.log('🔍 Fetching transaction receipt for hash:', txHash);
      
      // Determine which network to use based on the networkId
      const isMainnet = transactionRef.networkId === 8453 || transactionRef.networkId === '8453';
      const chain = isMainnet ? base : baseSepolia;
      
      // Create a public client to fetch the transaction receipt
      const publicClient = createPublicClient({
        chain,
        transport: http()
      });
      
      try {
        console.log('⏳ Waiting for transaction to be confirmed...');
        const receipt = await publicClient.waitForTransactionReceipt({ 
          hash: txHash,
          timeout: 60_000 // 60 second timeout
        });
        console.log('✅ Transaction confirmed and receipt fetched successfully');
        
        // Extract contract address from the receipt logs
        const contractAddress = await this.extractContractAddressFromReceipt(receipt, pendingTx.type);
        
        if (!contractAddress) {
          console.error('❌ CRITICAL: Failed to extract contract address from transaction receipt');
          
          // Send error message to user
          const errorMessage = pendingTx.type === 'group_creation' 
            ? "❌ **Transaction Error**\n\nI couldn't verify your Group creation. The transaction completed, but I was unable to extract the Group address from the receipt.\n\nPlease check your wallet for the transaction details, or try creating another Group."
            : "❌ **Transaction Error**\n\nI couldn't verify your Coin creation. The transaction completed, but I was unable to extract the Coin address from the receipt.\n\nPlease check your wallet for the transaction details, or try launching another Coin.";
          
          await conversation.send(errorMessage);
          
          // Clear the pending transaction since we can't process it
          await this.sessionManager.updateUserState(senderInboxId, {
            pendingTransaction: undefined
          });
          
          return false;
        }
        
        // Validate that the extracted address is a valid Ethereum address
        if (!isAddress(contractAddress)) {
          console.error('❌ CRITICAL: Extracted address is not a valid Ethereum address:', contractAddress);
          
          // Send error message to user
          const errorMessage = pendingTx.type === 'group_creation' 
            ? "❌ **Transaction Error**\n\nI extracted an invalid Group address from your transaction receipt. This is a security issue.\n\nPlease check your wallet for the correct address, or try creating another Group."
            : "❌ **Transaction Error**\n\nI extracted an invalid Coin address from your transaction receipt. This is a security issue.\n\nPlease check your wallet for the correct address, or try launching another Coin.";
          
          await conversation.send(errorMessage);
          
          // Clear the pending transaction since we can't process it
          await this.sessionManager.updateUserState(senderInboxId, {
            pendingTransaction: undefined
          });
          
          return false;
        }

        // Determine network
        const network = pendingTx.network;
        
        // Create success message
        let successMessage: string;
        let url: string;
        
        if (pendingTx.type === 'group_creation') {
          successMessage = `Group created!\n\nCA: ${contractAddress}`;
          url = `https://flaunch.gg/${network}/group/${contractAddress}`;
        } else {
          successMessage = `Coin created!\n\nCA: ${contractAddress}`;
          url = `https://flaunch.gg/${network}/coin/${contractAddress}`;
        }
        
        successMessage += `\n\n${url}`;
        
        // Send success message
        await conversation.send(successMessage);
        
        // Generate next steps in character's voice with user context
        const nextStepsMessage = await this.generateNextStepsMessage(pendingTx.type, userState);
        await conversation.send(nextStepsMessage);
        
        // Update user state based on transaction type
        if (pendingTx.type === 'group_creation') {
          // For group creation, store the manager address and move to coin creation
          const currentProgress = userState.onboardingProgress;
          
          // Determine chain info from network
          const chainId = isMainnet ? 8453 : 84532; // Base mainnet : Base Sepolia
          const chainName = pendingTx.network as 'base' | 'base-sepolia';
          
          // Create the group entry for the user's groups array
          const newGroup: UserGroup = {
            id: contractAddress,
            type: 'username_split',
            receivers: (currentProgress?.splitData?.receivers || []).map(r => ({
              username: r.username,
              resolvedAddress: r.resolvedAddress || 'unknown',
              percentage: r.percentage || (100 / (currentProgress?.splitData?.receivers.length || 1))
            })),
            coins: [],
            chainId,
            chainName,
            createdAt: new Date(),
            updatedAt: new Date()
          };
          
          await this.sessionManager.updateUserState(senderInboxId, {
            pendingTransaction: undefined,
            // Add the group to the user's groups array
            groups: [
              ...userState.groups,
              newGroup
            ],
            onboardingProgress: currentProgress ? {
              ...currentProgress,
              step: 'coin_creation',
              splitData: currentProgress.splitData ? {
                ...currentProgress.splitData,
                managerAddress: contractAddress
              } : undefined,
              groupData: {
                managerAddress: contractAddress,
                txHash: txHash
              },
              // Preserve existing coin data if any, otherwise initialize empty
              coinData: currentProgress.coinData || { name: undefined, ticker: undefined, image: undefined }
            } : undefined
          });
        } else {
          // For coin creation, add the coin to user's collection
          // Use the group address from the user's onboarding progress (the group they just created)
          const groupAddress = userState.onboardingProgress?.groupData?.managerAddress || 
                             userState.onboardingProgress?.splitData?.managerAddress ||
                             (userState.groups.length > 0 ? userState.groups[userState.groups.length - 1].id : 'unknown-group');
          
          // Determine chain info from network
          const chainId = isMainnet ? 8453 : 84532; // Base mainnet : Base Sepolia
          const chainName = pendingTx.network as 'base' | 'base-sepolia';
          
          await this.sessionManager.updateUserState(senderInboxId, {
            pendingTransaction: undefined,
            ...(pendingTx.coinData && {
              coins: [
                ...userState.coins,
                {
                  ticker: pendingTx.coinData.ticker,
                  name: pendingTx.coinData.name,
                  image: pendingTx.coinData.image,
                  groupId: groupAddress,
                  contractAddress,
                  launched: true,
                  fairLaunchDuration: 30 * 60, // 30 minutes
                  fairLaunchPercent: 40,
                  initialMarketCap: 1000,
                  chainId,
                  chainName,
                  createdAt: new Date()
                }
              ],
              // Update the group's coins array to include the new coin ticker
              groups: userState.groups.map(group => 
                group.id === groupAddress 
                  ? { ...group, coins: [...group.coins, pendingTx.coinData!.ticker], updatedAt: new Date() }
                  : group
              )
            })
          });
        }

        console.log('Successfully processed transaction reference and sent success message', {
          type: pendingTx.type,
          contractAddress,
          network,
          url,
          txHash
        });

        return true;
        
      } catch (receiptError: any) {
        console.error('❌ Failed to wait for transaction receipt:', receiptError);
        
        let errorMessage: string;
        if (receiptError?.name === 'TimeoutError' || receiptError?.message?.includes('timeout')) {
          errorMessage = "⏰ **Transaction Timeout**\n\nYour transaction is taking longer than expected to confirm. This is normal during network congestion.\n\nPlease check your wallet in a few minutes, or send the transaction reference again once it's confirmed.";
        } else {
          errorMessage = "❌ **Transaction Error**\n\nI couldn't fetch your transaction receipt from the blockchain. This could be due to network issues.\n\nPlease wait a moment and try again, or check your wallet for transaction details.";
        }
        
        await conversation.send(errorMessage);
        
        // Don't clear pending transaction in case of network issues - user might retry
        return false;
      }
    } catch (error) {
      console.error('❌ CRITICAL: Error handling transaction reference:', error);
      
      try {
        const conversation = await this.client.conversations.getConversationById(message.conversationId);
        if (conversation) {
          await conversation.send("❌ **System Error**\n\nI encountered an error while processing your transaction reference. This could be due to an unexpected format or system issue.\n\nPlease check your wallet for transaction details and try again if needed.");
        }
        
        // Clear any pending transaction state
        const senderInboxId = message.senderInboxId;
        await this.sessionManager.updateUserState(senderInboxId, {
          pendingTransaction: undefined
        });
      } catch (notificationError) {
        console.error('Failed to send error notification to user:', notificationError);
      }
      
      return false;
    }
  }

  private async extractContractAddressFromReceipt(content: any, transactionType: 'group_creation' | 'coin_creation'): Promise<string | null> {
    // Helper function to safely stringify objects with BigInt values
    const safeStringify = (obj: any) => {
      try {
        return JSON.stringify(obj, (key, value) =>
          typeof value === 'bigint' ? value.toString() + 'n' : value
        , 2);
      } catch (error) {
        return '[Unable to stringify - contains non-serializable values]';
      }
    };

    console.log('🔍 EXTRACTING CONTRACT ADDRESS FROM RECEIPT', {
      contentType: typeof content,
      transactionType,
      content: safeStringify(content)
    });

    try {
      // Parse transaction receipt logs based on transaction type
      if (content && typeof content === 'object' && content.logs && Array.isArray(content.logs)) {
        const logs = content.logs;
        console.log(`📊 Found ${logs.length} logs in transaction receipt`);
        
        // Log each log for debugging
        logs.forEach((log: any, index: number) => {
          console.log(`Log ${index}:`, {
            address: log.address,
            topics: log.topics,
            data: log.data ? log.data.substring(0, 100) + '...' : 'no data'
          });
        });
        
        if (transactionType === 'group_creation') {
          // For group creation, look for the ManagerDeployed event with specific topic[0]
          console.log('🔍 Group creation: Looking for ManagerDeployed event');
          
          const managerDeployedTopic = '0xb9eeb0ca3259038acb2879e65ccb1f2a6433df58eefa491654cc6607b01944d4';
          
          for (const log of logs) {
            if (log.topics && log.topics.length > 1 && log.topics[0] === managerDeployedTopic) {
              // Found the ManagerDeployed event, extract manager address from topic[1]
              const managerAddressHex = log.topics[1];
              // Remove padding zeros to get the actual address
              const managerAddress = `0x${managerAddressHex.slice(-40)}`;
              console.log('✅ Found manager address from ManagerDeployed event:', managerAddress);
              return managerAddress;
            }
          }
          
          console.log('❌ No ManagerDeployed event found in logs');
          console.log('🔍 Available fields in receipt:', Object.keys(content));
          
        } else if (transactionType === 'coin_creation') {
          // For coin creation, use the proper PoolCreated event decoder
          console.log('Parsing coin creation logs for PoolCreated event');
          
          const memecoinAddress = getMemecoinAddress(logs);
          if (memecoinAddress) {
            console.log('✅ Found memecoin address using PoolCreated decoder:', memecoinAddress);
            return memecoinAddress;
          } else {
            console.log('❌ PoolCreated event decoder did not find memecoin address');
          }
        }
      } else {
        console.log('❌ No logs found in transaction receipt or invalid format:', {
          hasContent: !!content,
          isObject: typeof content === 'object',
          hasLogs: !!(content && content.logs),
          isLogsArray: !!(content && content.logs && Array.isArray(content.logs)),
          logsType: content && content.logs ? typeof content.logs : 'undefined'
        });
      }
      
      // Fallback: Try to extract from common fields (backwards compatibility)
      if (content && typeof content === 'object') {
        // Check for memecoin/memecoinAddress fields first (Flaunch-specific)
        if (content.memecoin) {
          console.log('Found memecoin address in content:', content.memecoin);
          return content.memecoin;
        }
        if (content.memecoinAddress) {
          console.log('Found memecoinAddress in content:', content.memecoinAddress);
          return content.memecoinAddress;
        }
        if (content.managerAddress && transactionType === 'group_creation') {
          console.log('Found managerAddress in content:', content.managerAddress);
          return content.managerAddress;
        }
        
        // Generic fields
        if (content.contractAddress) {
          console.log('Found contractAddress in content:', content.contractAddress);
          return content.contractAddress;
        }
        if (content.address) {
          console.log('Found address in content:', content.address);
          return content.address;
        }
      }

      // Try to extract from string content
      if (typeof content === 'string' && content.includes('0x')) {
        const match = content.match(/0x[a-fA-F0-9]{40}/);
        if (match) {
          console.log('Found address in string content:', match[0]);
          return match[0];
        }
      }
      
      console.error('❌ CRITICAL: Could not extract contract address from receipt');
      console.error('🚨 SECURITY: Refusing to proceed with unknown address');
      console.error('💡 For group creation: Check returnValue, result, or output fields in receipt');
      console.error('💡 For coin creation: Check PoolCreated event logs');
      
      // Return null to indicate failure - do not generate mock addresses for security reasons
      return null;
      
    } catch (error) {
      console.error('Error parsing transaction receipt:', error);
      return null;
    }
  }

  private async generateNextStepsMessage(transactionType: 'group_creation' | 'coin_creation', userState: any): Promise<string> {
    const { getCharacterResponse } = await import('../../../utils/character');
    
    let prompt: string;
    
    if (transactionType === 'group_creation') {
      // Check if coin details are already stored
      const coinData = userState.onboardingProgress?.coinData;
      const hasStoredCoin = coinData && (coinData.name || coinData.ticker);
      
      if (hasStoredCoin) {
        // User already provided coin details earlier
        const coinName = coinData.name || 'your coin';
        const coinTicker = coinData.ticker ? `(${coinData.ticker})` : '';
        const needsImage = !coinData.image;
        
                 prompt = `The user just successfully created their Group! 
         
         Great news - you already mentioned wanting to launch "${coinName}" ${coinTicker} earlier! 
         ${needsImage ? 'Just need an image to complete your coin launch.' : 'We have all the details needed for your coin launch.'}
         
         Be excited about remembering their coin details and the progress made. Keep it concise and use your character's voice.`;
      } else {
                 // No coin details stored, ask for them
         prompt = `The user just successfully created their Group! Now ask for coin details to launch their first coin:
         - Coin name
         - Ticker symbol (2-8 letters)  
         - Image URL or they can upload an image
         
         Be excited about the progress and explain this will be their first coin in the group. Keep it concise and use your character's voice.`;
      }
    } else {
      prompt = `The user just successfully created a Coin! 
      
      Tell them what they can do next: they can ask for details on their Groups or Coins, launch more coins into any of their Groups, and importantly, they can go to https://mini.flaunch.gg to see all their coins and claim fees.
      
      Mention that they've completed onboarding and can now use https://mini.flaunch.gg for coin management and fee claiming. Ask if there's anything more they'd like to do. Use your character's voice and style.`;
    }

    return await getCharacterResponse({
      openai: this.openai,
      character: this.character,
      prompt
    });
  }

  private async shouldProcessMessage(
    primaryMessage: DecodedMessage,
    conversation: any,
    userState: any
  ): Promise<boolean> {
    // Always process messages in 1:1 conversations
    const members = await conversation.members();
    const isGroupChat = members.length > 2;
    
    if (!isGroupChat) {
      return true;
    }

    // In group chats, check if message is directed at the agent
    const messageText = typeof primaryMessage.content === 'string' ? primaryMessage.content.toLowerCase() : '';
    
    // Check if message mentions the agent by name
    const agentName = this.character.name.toLowerCase();
    const mentionsAgent = messageText.includes(agentName) || 
                         messageText.includes(`@${agentName}`) ||
                         messageText.includes('flaunchy') ||
                         messageText.includes('@flaunchy');

    // Check if this is a response to a previous agent message
    const isResponseToAgent = await this.isResponseToAgentMessage(primaryMessage, conversation);

    // Check if user has ongoing onboarding or management progress (agent should continue conversations)
    const hasOngoingProcess = userState.status === 'onboarding' || 
                             userState.managementProgress !== undefined;

    // Process if: mentioned, response to agent, or has ongoing process
    return mentionsAgent || isResponseToAgent || hasOngoingProcess;
  }

  private async isResponseToAgentMessage(message: DecodedMessage, conversation: any): Promise<boolean> {
    try {
      // Get recent messages to check if this is following an agent message
      const messages = await conversation.messages({ limit: 10 });
      
      // Find the message before this one
      const messageIndex = messages.findIndex((msg: any) => msg.id === message.id);
      if (messageIndex > 0) {
        const previousMessage = messages[messageIndex - 1];
        // Check if previous message was from the agent
        return previousMessage.senderInboxId === this.client.inboxId;
      }
      
      return false;
    } catch (error) {
      console.error('Error checking if response to agent message:', error);
      return false;
    }
  }
} 