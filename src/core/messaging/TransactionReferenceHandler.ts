import type { Client, DecodedMessage, Conversation } from "@xmtp/node-sdk";
import type { TransactionReferenceMessage } from "../../../types";
import { createPublicClient, http, type Hex } from "viem";
import { getDefaultChain } from "../../flows/utils/ChainSelection";
import { ContractExtractor } from "./ContractExtractor";
import { GroupStorageService } from "../../services/GroupStorageService";
import { SessionManager } from "../session/SessionManager";

/**
 * Service for handling transaction references and processing success messages
 * Handles both group creation and coin creation transactions
 */
export class TransactionReferenceHandler {
  constructor(
    private client: Client<any>,
    private sessionManager: SessionManager,
    private groupStorageService: GroupStorageService
  ) {}

  /**
   * Process a transaction reference message and handle success/failure scenarios
   */
  async handleTransactionReference(message: DecodedMessage): Promise<boolean> {
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

      // Extract transaction hash
      const txHash = this.extractTransactionHash(message);
      if (!txHash) {
        console.error("❌ Transaction hash is undefined");
        return false;
      }

      console.log(
        `[TransactionReferenceHandler] 🔍 Processing ${pendingTx.type} transaction: ${txHash}`
      );

      // Get transaction receipt
      const receipt = await this.getTransactionReceipt(txHash);
      if (!receipt) {
        return await this.handleReceiptError(
          conversation,
          null,
          creatorAddress,
          message.conversationId
        );
      }

      // Extract and validate contract address
      const contractAddress = ContractExtractor.extractContractAddress(
        receipt,
        pendingTx.type
      );
      if (
        !ContractExtractor.validateExtractedAddress(
          contractAddress,
          pendingTx.type
        )
      ) {
        return await this.handleContractExtractionError(
          conversation,
          pendingTx.type,
          creatorAddress,
          message.conversationId
        );
      }

      // Process based on transaction type
      if (pendingTx.type === "group_creation") {
        return await this.handleGroupCreationSuccess(
          conversation,
          contractAddress!,
          pendingTx,
          groupState,
          userState,
          creatorAddress,
          message.conversationId,
          txHash,
          receipt
        );
      } else {
        return await this.handleCoinCreationSuccess(
          conversation,
          contractAddress!,
          pendingTx,
          groupState,
          userState,
          creatorAddress,
          message.conversationId
        );
      }
    } catch (error) {
      return await this.handleCriticalError(error, message);
    }
  }

  /**
   * Extract transaction hash from message content
   */
  private extractTransactionHash(message: DecodedMessage): Hex | undefined {
    const messageContent = (message as TransactionReferenceMessage).content;

    if (!messageContent) {
      return undefined;
    }

    const transactionRef = messageContent.transactionReference;
    if (transactionRef) {
      return transactionRef.reference;
    }

    // Handle old format
    const oldMessageContent = messageContent as unknown as { reference: Hex };
    return oldMessageContent.reference;
  }

  /**
   * Get transaction receipt with timeout
   */
  private async getTransactionReceipt(txHash: Hex): Promise<any | null> {
    try {
      const defaultChain = getDefaultChain();
      const publicClient = createPublicClient({
        chain: defaultChain.viemChain,
        transport: http(),
      });

      const receipt = await publicClient.waitForTransactionReceipt({
        hash: txHash,
        timeout: 60_000, // 60 second timeout
      });

      console.log("[TransactionReferenceHandler] ✅ Transaction confirmed");
      return receipt;
    } catch (error) {
      console.error("❌ Failed to wait for transaction receipt:", error);
      return null;
    }
  }

  /**
   * Handle successful group creation transaction
   */
  private async handleGroupCreationSuccess(
    conversation: Conversation<any>,
    contractAddress: string,
    pendingTx: any,
    groupState: any,
    userState: any,
    creatorAddress: string,
    conversationId: string,
    txHash: Hex,
    receipt: any
  ): Promise<boolean> {
    // Send success message
    await conversation.send("✅ Group created successfully!");

    // Clear pending transaction
    await this.sessionManager.updateGroupState(creatorAddress, conversationId, {
      pendingTransaction: undefined,
      managementProgress: undefined,
    });

    return true;
  }

  /**
   * Handle successful coin creation transaction
   */
  private async handleCoinCreationSuccess(
    conversation: Conversation<any>,
    contractAddress: string,
    pendingTx: any,
    groupState: any,
    userState: any,
    creatorAddress: string,
    conversationId: string
  ): Promise<boolean> {
    const networkPath =
      pendingTx.network === "baseSepolia" ? "base-sepolia" : "base";

    await conversation.send(
      `coin created! CA: ${contractAddress}\n\nlink: https://flaunch.gg/${networkPath}/coin/${contractAddress}\n\nview in mini app:`
    );
    await conversation.send(
      `https://mini.flaunch.gg/${networkPath}/coin/${contractAddress}`
    );

    // Clear pending transaction and update user status
    await this.sessionManager.updateGroupState(creatorAddress, conversationId, {
      pendingTransaction: undefined,
      managementProgress: undefined,
    });

    // Update user status to active after successful coin launch
    if (userState.status === "new" || userState.status === "onboarding") {
      await this.sessionManager.updateUserState(creatorAddress, {
        status: "active",
      });

      const completionMessage =
        userState.status === "new"
          ? `🎉 coin launched! you're now active and earning fees from trading.`
          : `🎉 onboarding complete! you've got groups and coins set up.`;

      await conversation.send(completionMessage);
    }

    return true;
  }

  /**
   * Handle contract extraction error
   */
  private async handleContractExtractionError(
    conversation: Conversation<any>,
    transactionType: string,
    creatorAddress: string,
    conversationId: string
  ): Promise<boolean> {
    const errorMessage =
      transactionType === "group_creation"
        ? "❌ Transaction Error\n\nI couldn't verify your Group creation. Please check your wallet for the transaction details."
        : "❌ Transaction Error\n\nI couldn't verify your Coin creation. Please check your wallet for the transaction details.";

    await conversation.send(errorMessage);

    // Clear the pending transaction
    await this.sessionManager.updateGroupState(creatorAddress, conversationId, {
      pendingTransaction: undefined,
      managementProgress: undefined,
    });

    return false;
  }

  /**
   * Handle receipt fetching error
   */
  private async handleReceiptError(
    conversation: Conversation<any>,
    receiptError: any,
    creatorAddress: string,
    conversationId: string
  ): Promise<boolean> {
    const errorMessage =
      "⏰ Transaction Timeout\n\nYour transaction is taking longer than expected to confirm. Please check your wallet in a few minutes.";
    await conversation.send(errorMessage);
    return false;
  }

  /**
   * Handle critical system error
   */
  private async handleCriticalError(
    error: any,
    message: DecodedMessage
  ): Promise<boolean> {
    console.error("❌ CRITICAL: Error handling transaction reference:", error);

    try {
      const conversation = await this.client.conversations.getConversationById(
        message.conversationId
      );
      if (conversation) {
        await conversation.send(
          "❌ System Error\n\nI encountered an error while processing your transaction reference."
        );
      }
    } catch (notificationError) {
      console.error(
        "Failed to send error notification to user:",
        notificationError
      );
    }

    return false;
  }
}
