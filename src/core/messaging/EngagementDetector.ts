import type { DecodedMessage } from "@xmtp/node-sdk";
import type OpenAI from "openai";
import { Character } from "../../../types";
import { MessageTextExtractor } from "./MessageTextExtractor";

/**
 * Service for detecting user engagement with the agent
 * Determines whether messages should be processed based on mentions, patterns, and context
 */
export class EngagementDetector {
  constructor(private openai: OpenAI, private character: Character) {}

  /**
   * Fast regex detection for obvious agent mentions (saves LLM calls)
   * Only catches the most clear-cut cases where we're 100% sure
   */
  detectObviousAgentMention(messageText: string): boolean {
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
  detectExplicitAgentMention(messageText: string): boolean {
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

  /**
   * Use LLM to determine conversation engagement with proper context
   * Handles both initial engagement detection and ongoing conversation analysis
   */
  async checkConversationEngagement(
    messageText: string,
    conversationId: string,
    senderInboxId: string,
    context: "new_message" | "active_thread",
    primaryMessage: DecodedMessage,
    client: any
  ): Promise<{ isEngaged: boolean; reason: string }> {
    if (!messageText) return { isEngaged: false, reason: "empty_message" };

    try {
      // Fetch previous text messages for context
      const messageHistory = await this.fetchTextMessageHistory(
        conversationId,
        primaryMessage.id,
        client,
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

  /**
   * Build prompt for checking engagement in active thread context
   */
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

  /**
   * Build prompt for checking engagement in new message context
   */
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
}
