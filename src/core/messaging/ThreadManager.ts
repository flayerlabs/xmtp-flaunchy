import type { DecodedMessage } from "@xmtp/node-sdk";
import { EngagementDetector } from "./EngagementDetector";
import { UsernameResolver } from "./UsernameResolver";
import type OpenAI from "openai";

/**
 * Service for managing active conversation threads where the agent is engaged
 * Tracks thread activity, user participation, and determines ongoing engagement
 */
export class ThreadManager {
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

  // Thread timeout - if no activity for 5 minutes, consider thread inactive
  // This ensures bot doesn't continue responding to users who've moved on
  private readonly THREAD_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

  constructor(
    private engagementDetector: EngagementDetector,
    private usernameResolver: UsernameResolver,
    private openai: OpenAI
  ) {}

  /**
   * Check if message is part of an active conversation thread
   */
  async isInActiveThread(
    conversationId: string,
    senderInboxId: string,
    message: DecodedMessage,
    sessionManager: any,
    client: any
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
    const creatorAddress =
      await this.usernameResolver.getCreatorAddressFromInboxId(
        senderInboxId,
        client
      );
    if (creatorAddress) {
      const groupState = await sessionManager.getGroupState(
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
    const messageText = message.content as string;
    const engagementResult =
      await this.engagementDetector.checkConversationEngagement(
        messageText,
        conversationId,
        senderInboxId,
        "active_thread",
        message,
        client
      );

    if (!engagementResult.isEngaged) {
      // Remove this user from the thread - they've moved on
      thread.participatingUsers.delete(senderInboxId);
      console.log("👋 USER DISENGAGED - removing from thread", {
        conversationId: conversationId.slice(0, 8) + "...",
        userId: senderInboxId.slice(0, 8) + "...",
        messageText: messageText?.substring(0, 50) + "...",
        reason: engagementResult.reason,
      });
      return false;
    }

    // Also check if this message is a direct response to recent agent activity
    const isRecentResponse = await this.isRecentResponseToAgent(
      message,
      thread.lastAgentMessageTime,
      client
    );

    return isParticipating || isRecentResponse;
  }

  /**
   * Check if message is a recent response to agent activity
   */
  private async isRecentResponseToAgent(
    message: DecodedMessage,
    lastAgentTime: Date,
    client: any
  ): Promise<boolean> {
    try {
      const conversation = await client.conversations.getConversationById(
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
          (msg: any) => msg.senderInboxId === client.inboxId
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
  async updateActiveThread(
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
  async updateThreadActivity(
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
  updateThreadWithAgentMessage(conversationId: string): void {
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
   * Get active thread information for debugging
   */
  getActiveThreadInfo(conversationId: string): {
    isActive: boolean;
    participantCount: number;
    lastActivity: Date | null;
    threadAge: number | null;
  } {
    const thread = this.activeThreads.get(conversationId);

    if (!thread) {
      return {
        isActive: false,
        participantCount: 0,
        lastActivity: null,
        threadAge: null,
      };
    }

    const now = new Date();
    const threadAge = now.getTime() - thread.threadStartTime.getTime();
    const timeSinceLastActivity =
      now.getTime() - thread.lastAgentMessageTime.getTime();
    const isActive = timeSinceLastActivity <= this.THREAD_TIMEOUT_MS;

    return {
      isActive,
      participantCount: thread.participatingUsers.size,
      lastActivity: thread.lastAgentMessageTime,
      threadAge,
    };
  }

  /**
   * Clear all inactive threads (cleanup utility)
   */
  clearInactiveThreads(): number {
    const now = new Date();
    let clearedCount = 0;

    for (const [conversationId, thread] of this.activeThreads.entries()) {
      const timeSinceLastActivity =
        now.getTime() - thread.lastAgentMessageTime.getTime();

      if (timeSinceLastActivity > this.THREAD_TIMEOUT_MS) {
        this.activeThreads.delete(conversationId);
        clearedCount++;
      }
    }

    if (clearedCount > 0) {
      console.log(`🧹 Cleared ${clearedCount} inactive threads`);
    }

    return clearedCount;
  }

  /**
   * Get total number of active threads
   */
  getActiveThreadCount(): number {
    // Clean up inactive threads first
    this.clearInactiveThreads();
    return this.activeThreads.size;
  }
}
