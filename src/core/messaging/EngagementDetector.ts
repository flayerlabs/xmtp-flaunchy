import { MessageTextExtractor } from "./MessageTextExtractor";

/**
 * Service for detecting user engagement with the agent
 * Determines whether messages should be processed based on mentions, patterns, and context
 */
export class EngagementDetector {
  constructor(private characterName: string) {}

  /**
   * Fast regex detection for obvious agent mentions (saves LLM calls)
   * Only catches the most clear-cut cases where we're 100% sure
   */
  detectObviousAgentMention(messageText: string): boolean {
    if (!messageText || typeof messageText !== "string") {
      return false;
    }

    const lowerText = messageText.toLowerCase();
    const agentName = this.characterName.toLowerCase(); // "flaunchy"

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
  detectExplicitAgentMention(messageText: string): boolean {
    if (!messageText || typeof messageText !== "string") {
      return false;
    }

    const lowerText = messageText.toLowerCase();
    const agentName = this.characterName.toLowerCase(); // "flaunchy"

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
   * Fetch and filter the previous text messages from conversation history
   * Only returns actual text messages, excluding read receipts, reactions, etc.
   * Excludes the latest message since it's provided separately
   */
  async fetchTextMessageHistory(
    conversationId: string,
    latestMessageId: string,
    client: any,
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
      const conversation = await client.conversations.getConversationById(
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
          MessageTextExtractor.isTransactionReceipt(message) ||
          MessageTextExtractor.isAttachment(message)
        ) {
          continue;
        }

        // Extract text content
        const textContent = MessageTextExtractor.extractMessageText(message);
        if (textContent && textContent.trim().length > 0) {
          textMessages.push({
            senderInboxId: message.senderInboxId,
            content: textContent.trim(),
            timestamp: new Date(message.sentAt),
            isBot: message.senderInboxId === client.inboxId,
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
}
