import type { Client, DecodedMessage, Conversation } from "@xmtp/node-sdk";
import type OpenAI from "openai";
import { FlowRouter } from "../flows/FlowRouter";
import { SessionManager } from "../session/SessionManager";
import { FlowContext } from "../types/FlowContext";
import { UserState, UserGroup } from "../types/UserState";
import { Character } from "../../../types";
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
import {
  decodeEventLog,
  decodeAbiParameters,
  type Log,
  createPublicClient,
  http,
  isAddress,
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
  private readonly THREAD_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes

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
    if (typeof message.content === "string") {
      const trimmedContent = message.content.trim();
      console.log("🔍 CONTENT CHECK", {
        originalContent: JSON.stringify(message.content),
        trimmedContent: JSON.stringify(trimmedContent),
        isTripleDot: trimmedContent === "...",
        contentLength: message.content.length,
        trimmedLength: trimmedContent.length,
      });

      if (trimmedContent === "...") {
        console.log("⏭️ SKIPPING TRANSACTION RECEIPT", {
          content: message.content,
          senderInboxId: message.senderInboxId,
          timestamp: new Date().toISOString(),
        });
        return false;
      }
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

      // Log coordinated message processing
      console.log("🔄 PROCESSING COORDINATED MESSAGES", {
        totalMessages: messages.length,
        primaryMessage: {
          id: primaryMessage.id,
          contentType: primaryMessage.contentType?.typeId || "text",
          isAttachment: primaryMessage.contentType?.sameAs(
            ContentTypeRemoteAttachment
          ),
          content: primaryMessage.contentType?.sameAs(
            ContentTypeRemoteAttachment
          )
            ? "[ATTACHMENT]"
            : typeof primaryMessage.content === "string"
            ? primaryMessage.content.substring(0, 100) + "..."
            : "[NON-TEXT]",
        },
        relatedMessages: relatedMessages.map((msg) => ({
          id: msg.id,
          contentType: msg.contentType?.typeId || "text",
          isAttachment: msg.contentType?.sameAs(ContentTypeRemoteAttachment),
        })),
        timestamp: new Date().toISOString(),
      });

      // Get conversation
      const conversation = await this.client.conversations.getConversationById(
        primaryMessage.conversationId
      );
      if (!conversation) {
        console.error("Could not find conversation");
        return false;
      }

      // Get sender info
      const senderInboxId = primaryMessage.senderInboxId;
      const inboxState = await this.client.preferences.inboxStateFromInboxIds([
        senderInboxId,
      ]);
      const creatorAddress = inboxState[0]?.identifiers[0]?.identifier || "";

      // Get user state by Ethereum address (the actual on-chain identity)
      let userState = await this.sessionManager.getUserState(creatorAddress);

      // Check if we should process this message
      const shouldProcess = await this.shouldProcessMessage(
        primaryMessage,
        conversation,
        userState
      );

      if (!shouldProcess) {
        console.log("🚫 MESSAGE FILTERED OUT", {
          senderInboxId: senderInboxId.substring(0, 8) + "...",
          reason: "Not directed at agent and no ongoing process",
          messageContent:
            typeof primaryMessage.content === "string"
              ? primaryMessage.content.substring(0, 50) + "..."
              : "[NON-TEXT]",
          timestamp: new Date().toISOString(),
        });
        return false;
      }

      // Send a message to the user to let them know the agent is processing their message
      await conversation.send("🐾 Thinking...");

      // Create flow context (using relatedMessages as conversation history for now)
      const context = await this.createFlowContext({
        primaryMessage,
        relatedMessages,
        conversation,
        userState,
        senderInboxId,
        creatorAddress,
        conversationHistory: relatedMessages,
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
    const isAttachment = primaryMessage.contentType?.sameAs(
      ContentTypeRemoteAttachment
    );
    let messageText = "";
    let hasAttachment = false;
    let attachment: any = undefined;

    if (isAttachment) {
      hasAttachment = true;
      attachment = primaryMessage.content;

      // Look for text in related messages
      const textMessage = relatedMessages.find(
        (msg) => !msg.contentType?.sameAs(ContentTypeRemoteAttachment)
      );
      if (textMessage && typeof textMessage.content === "string") {
        messageText = textMessage.content.trim();
      }
    } else {
      // Primary message is text
      if (typeof primaryMessage.content === "string") {
        messageText = primaryMessage.content.trim();
      }

      // Check for attachment in related messages
      const attachmentMessage = relatedMessages.find((msg) =>
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

      // Services
      ensResolver: this.ensResolverService,

      // Message context
      messageText,
      hasAttachment,
      attachment,
      relatedMessages,
      conversationHistory,

      // Helper functions
      sendResponse: async (message: string) => {
        await conversation.send(message);
        // Update thread state when agent sends a message
        this.updateThreadWithAgentMessage(conversation.id);
      },

      updateState: async (updates: Partial<UserState>) => {
        await this.sessionManager.updateUserState(creatorAddress, updates);
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

      console.log("📊 Image processing details:", {
        originalDataSize: decryptedAttachment.data.length,
        base64Size: base64Image.length,
        filename: decryptedAttachment.filename || "image",
        mimeType: decryptedAttachment.mimeType || "unknown",
      });

      // Upload to IPFS using our existing upload function
      const ipfsResponse = await uploadImageToIPFS({
        pinataConfig: { jwt: process.env.PINATA_JWT! },
        base64Image,
        name: decryptedAttachment.filename || "image",
      });

      console.log("📋 IPFS upload response:", {
        IpfsHash: ipfsResponse.IpfsHash,
        PinSize: ipfsResponse.PinSize,
        Timestamp: ipfsResponse.Timestamp,
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

      // Check if user has a pending transaction
      if (!userState.pendingTransaction) {
        console.log("No pending transaction found for transaction reference");
        return false;
      }

      const pendingTx = userState.pendingTransaction;
      const conversation = await this.client.conversations.getConversationById(
        message.conversationId
      );

      if (!conversation) {
        console.error("Could not find conversation for transaction reference");
        return false;
      }

      // Parse the transaction reference content
      const transactionRef = message.content as TransactionReference;
      console.log("📋 TRANSACTION REFERENCE RECEIVED", {
        reference: transactionRef.reference,
        networkId: transactionRef.networkId,
        namespace: transactionRef.namespace,
        metadata: transactionRef.metadata,
      });

      // Fetch the transaction receipt using the hash
      const txHash = transactionRef.reference as `0x${string}`;
      console.log("🔍 Fetching transaction receipt for hash:", txHash);

      // Use default chain from environment
      const defaultChain = getDefaultChain();
      const chain = defaultChain.viemChain;

      // Create a public client to fetch the transaction receipt
      const publicClient = createPublicClient({
        chain,
        transport: http(),
      });

      try {
        console.log("⏳ Waiting for transaction to be confirmed...");
        const receipt = await publicClient.waitForTransactionReceipt({
          hash: txHash,
          timeout: 60_000, // 60 second timeout
        });
        console.log(
          "✅ Transaction confirmed and receipt fetched successfully"
        );

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
          await this.sessionManager.updateUserState(creatorAddress, {
            pendingTransaction: undefined,
            managementProgress: undefined, // Clear management progress on system error
          });

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
          await this.sessionManager.updateUserState(creatorAddress, {
            pendingTransaction: undefined,
            managementProgress: undefined, // Clear management progress on system error
          });

          return false;
        }

        // Determine network
        const network = pendingTx.network;

        // Update user state based on transaction type
        if (pendingTx.type === "group_creation") {
          // For group creation, extract receiver data FIRST
          const currentProgress = userState.onboardingProgress;

          // Use default chain from environment
          const defaultChain = getDefaultChain();
          const chainId = defaultChain.id;
          const chainName = defaultChain.name;

          // FIXED: Use stored receiver data instead of transaction logs for better accuracy
          let receivers: Array<{
            username: string;
            resolvedAddress: string;
            percentage: number;
          }> = [];

          // Always use stored data for receiver information since it preserves original usernames
          const storedReceivers =
            currentProgress?.splitData?.receivers ||
            userState.managementProgress?.groupCreationData?.receivers ||
            [];

          if (storedReceivers.length > 0) {
            receivers = storedReceivers
              .map((r) => ({
                username: r.username,
                resolvedAddress: r.resolvedAddress || "", // Don't fallback to inbox ID
                percentage: r.percentage || 100 / storedReceivers.length,
              }))
              .filter(
                (r) => r.resolvedAddress && r.resolvedAddress.startsWith("0x")
              ); // Only include valid Ethereum addresses

            console.log(
              "📋 Using stored receivers (filtered for valid addresses):",
              receivers
            );
          }

          // REMOVED: Fallback to transaction sender as this was causing the inbox ID issue
          // If no valid receivers found, this is an error condition
          if (receivers.length === 0) {
            console.error(
              "❌ CRITICAL: No valid fee receivers found for group creation"
            );
            await conversation.send(
              "❌ Group Creation Error\n\nNo valid fee receivers were found for your group. This is a critical error.\n\nPlease try creating the group again with valid usernames or addresses."
            );

            // Clear the pending transaction since we can't process it
            await this.sessionManager.updateUserState(creatorAddress, {
              pendingTransaction: undefined,
              managementProgress: undefined,
            });

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
          await this.sessionManager.updateUserState(creatorAddress, {
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
          });
        } else {
          // Coin creation success
          const networkPath =
            network === "baseSepolia" ? "base-sepolia" : "base";
          await conversation.send(
            `coin created! CA: ${contractAddress}\n\ntrack your coin's progress: https://mini.flaunch.gg\nview details: https://flaunch.gg/${networkPath}/coin/${contractAddress}`
          );
          // For coin creation, add the coin to user's collection
          // Use the group address from the user's onboarding progress (the group they just created)
          const groupAddress =
            userState.onboardingProgress?.groupData?.managerAddress ||
            userState.onboardingProgress?.splitData?.managerAddress ||
            (userState.groups.length > 0
              ? userState.groups[userState.groups.length - 1].id
              : "unknown-group");

          // Use default chain from environment
          const defaultChain = getDefaultChain();
          const chainId = defaultChain.id;
          const chainName = defaultChain.name;

          // Create the coin object (only if coinData exists)
          if (pendingTx.coinData) {
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

            // Add coin to ALL group members (not just creator)
            await this.groupStorageService.addCoinToAllGroupMembers(
              groupAddress,
              newCoin,
              creatorAddress
            );
          }

          // Clear the creator's pending transaction and management progress
          await this.sessionManager.updateUserState(creatorAddress, {
            pendingTransaction: undefined,
            managementProgress: undefined, // Clear management progress when coin creation completes
          });

          // If user was onboarding, complete onboarding
          if (userState.status === "onboarding") {
            await this.sessionManager.completeOnboarding(creatorAddress);

            // Send onboarding completion message immediately when first coin is launched
            const completionMessage = `🎉 onboarding complete! you've got groups and coins set up. track your progress at https://mini.flaunch.gg`;
            await conversation.send(completionMessage);
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

        await this.sessionManager.updateUserState(creatorAddress, {
          pendingTransaction: undefined,
          managementProgress: undefined, // Clear management progress on system error
        });
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
        logs.forEach((log: any, index: number) => {
          console.log(`Log ${index}:`, {
            address: log.address,
            topics: log.topics,
            data: log.data ? log.data.substring(0, 100) + "..." : "no data",
          });
        });

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

    const messageText =
      typeof primaryMessage.content === "string" ? primaryMessage.content : "";
    const senderInboxId = primaryMessage.senderInboxId;
    const conversationId = primaryMessage.conversationId;

    // Check for explicit @ mentions of the agent
    const hasMention = this.detectAgentMention(messageText);

    if (hasMention) {
      console.log("🎯 AGENT MENTIONED - processing message", {
        senderInboxId: senderInboxId.slice(0, 8) + "...",
        conversationId: conversationId.slice(0, 8) + "...",
        messageText: messageText.substring(0, 100) + "...",
      });

      // Start/update active thread when mentioned
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

    // Check if user has critical ongoing processes that require attention
    const hasCriticalProcess = this.hasCriticalOngoingProcess(userState);

    if (hasCriticalProcess) {
      console.log("⚠️ CRITICAL PROCESS - processing message", {
        senderInboxId: senderInboxId.slice(0, 8) + "...",
        status: userState.status,
        hasOnboarding: !!userState.onboardingProgress,
        hasManagement: !!userState.managementProgress,
        hasPendingTx: !!userState.pendingTransaction,
      });

      return true;
    }

    console.log("⏭️ IGNORING GROUP MESSAGE - no mention or active thread", {
      senderInboxId: senderInboxId.slice(0, 8) + "...",
      conversationId: conversationId.slice(0, 8) + "...",
      messageText: messageText.substring(0, 50) + "...",
    });

    return false;
  }

  /**
   * Detect if message contains @ mention of the agent
   */
  private detectAgentMention(messageText: string): boolean {
    if (!messageText || typeof messageText !== "string") {
      return false;
    }

    const lowerText = messageText.toLowerCase();
    const agentName = this.character.name.toLowerCase(); // "flaunchy"

    // Check for various mention patterns
    const mentionPatterns = [
      `@${agentName}`, // @flaunchy
      `@ ${agentName}`, // @ flaunchy
      `@${agentName} `, // @flaunchy (with space after)
      ` @${agentName}`, // (space before) @flaunchy
      ` @${agentName} `, // (spaces around) @flaunchy
    ];

    // Check exact @ mention patterns first (most reliable)
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

    // Also check if this message is a direct response to recent agent activity
    const isRecentResponse = await this.isRecentResponseToAgent(
      message,
      thread.lastAgentMessageTime
    );

    return isParticipating || isRecentResponse;
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
      const messages = await conversation.messages({ limit: 10 });

      // Find messages between the last agent activity and now
      const messageTime = new Date(message.sentAt);
      const timeSinceAgent = messageTime.getTime() - lastAgentTime.getTime();

      // Consider it a recent response if within 5 minutes of agent activity
      if (timeSinceAgent > 0 && timeSinceAgent < 5 * 60 * 1000) {
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
   * Check if user has critical ongoing processes that require attention
   */
  private hasCriticalOngoingProcess(userState: any): boolean {
    // Only consider truly critical processes that need immediate attention
    return (
      // User is in onboarding and has made progress
      (userState.status === "onboarding" && userState.onboardingProgress) ||
      // User has a pending transaction that needs processing
      userState.pendingTransaction !== undefined ||
      // User has active management progress with recent activity
      (userState.managementProgress !== undefined &&
        this.isRecentManagementActivity(userState.managementProgress))
    );
  }

  /**
   * Check if management progress is recent (within last 10 minutes)
   */
  private isRecentManagementActivity(managementProgress: any): boolean {
    if (!managementProgress?.startedAt) return false;

    const now = new Date();
    const startTime = new Date(managementProgress.startedAt);
    const timeDiff = now.getTime() - startTime.getTime();

    // Consider recent if within last 10 minutes
    return timeDiff < 10 * 60 * 1000;
  }

  /**
   * Handle errors that might come from users with installation limit issues
   */
  private async handleUserInstallationLimitError(
    error: any,
    senderAddress?: string
  ): Promise<void> {
    const errorMessage = error?.message?.toLowerCase() || "";
    const isInstallationLimit = [
      "installation limit",
      "max installations",
      "maximum installations",
      "exceeded installation limit",
      "12/5 installations",
    ].some((pattern) => errorMessage.includes(pattern));

    if (isInstallationLimit && senderAddress) {
      console.log(
        `⚠️ User ${senderAddress} appears to have hit XMTP installation limit`
      );

      // You could potentially send them a helpful message if possible
      const helpMessage = `🚫 It looks like you've hit XMTP's 5-installation limit! 

To fix this:
• Clean up old XMTP installations from other apps/devices
• Use the same database/encryption key across deployments
• Contact XMTP support if you need help managing installations

This is a new limit in XMTP 3.0.0 to improve network performance.`;

      // Log for your reference
      console.log(
        "📋 Installation limit help message prepared for user:",
        helpMessage
      );
    }
  }
}
