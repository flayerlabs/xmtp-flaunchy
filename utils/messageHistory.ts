import type { Client, DecodedMessage, Conversation } from "@xmtp/node-sdk";

interface MessageHistoryEntry {
  role: "user" | "assistant";
  content: string;
}

export class MessageHistory {
  private history: Map<string, MessageHistoryEntry[]>;
  private readonly maxMessages: number;

  constructor(maxMessages: number = 20) {
    this.history = new Map();
    this.maxMessages = maxMessages;
  }

  async loadHistoricalMessages(client: Client) {
    // Get all conversations
    const conversations = await client.conversations.list();

    for (const conversation of conversations) {
      try {
        // Get messages for each conversation
        const messages = await conversation.messages();

        // Group messages by sender
        for (const message of messages) {
          if (message.contentType?.typeId === "text") {
            const isAssistant =
              message.senderInboxId.toLowerCase() ===
              client.inboxId.toLowerCase();

            // For assistant messages, store under the recipient's ID to maintain context
            let senderId = message.senderInboxId;
            if (isAssistant) {
              // Get the other member's ID from the conversation
              const members = await conversation.members();
              const otherMember = members.find(
                (member) =>
                  member.inboxId.toLowerCase() !== client.inboxId.toLowerCase()
              );
              if (otherMember) {
                senderId = otherMember.inboxId;
              }
            }

            this.addMessage(senderId, message, isAssistant);
          }
        }
      } catch (error) {
        console.error(`Error loading messages for conversation: ${error}`);
      }
    }
  }

  addMessage(
    senderId: string,
    message: DecodedMessage,
    isAssistant: boolean = false
  ) {
    if (!this.history.has(senderId)) {
      this.history.set(senderId, []);
    }

    const senderHistory = this.history.get(senderId)!;
    senderHistory.push({
      role: isAssistant ? "assistant" : "user",
      content: message.content as string,
    });

    // Keep only the last maxMessages
    if (senderHistory.length > this.maxMessages) {
      senderHistory.shift();
    }

    this.history.set(senderId, senderHistory);
  }

  getHistory(senderId: string): MessageHistoryEntry[] {
    return this.history.get(senderId) || [];
  }
}
