import type { Client, Conversation } from "@xmtp/node-sdk";
import type OpenAI from "openai";
import { SessionManager } from "../core/session/SessionManager";
import { Character } from "../../types";
import { getCharacterResponse } from "../../utils/character";

/**
 * Service that periodically detects when the bot is added to new groups
 * and sends a welcome message explaining the bot's capabilities
 */
export class NewGroupDetectionService {
  private intervalId: NodeJS.Timeout | null = null;
  private isRunning = false;
  private knownGroupIds = new Set<string>();

  constructor(
    private client: Client,
    private sessionManager: SessionManager,
    private openai: OpenAI,
    private character: Character,
    private syncIntervalMs: number = 30000 // 30 seconds
  ) {}

  /**
   * Start the periodic group detection service
   */
  async start(): Promise<void> {
    if (this.isRunning) {
      console.log("🔄 NewGroupDetectionService is already running");
      return;
    }

    console.log(
      `🚀 Starting NewGroupDetectionService with ${this.syncIntervalMs}ms interval`
    );

    // Initialize known groups from existing state
    await this.initializeKnownGroups();

    this.isRunning = true;
    this.intervalId = setInterval(async () => {
      try {
        await this.checkForNewGroups();
      } catch (error) {
        console.error("❌ Error in NewGroupDetectionService:", error);
      }
    }, this.syncIntervalMs);

    // Run initial check asynchronously to not block message stream startup
    this.checkForNewGroups().catch((error) => {
      console.error("❌ Error in initial group check:", error);
    });
  }

  /**
   * Stop the periodic group detection service
   */
  stop(): void {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
    this.isRunning = false;
    console.log("🛑 NewGroupDetectionService stopped");
  }

  /**
   * Initialize known groups from existing group states
   */
  private async initializeKnownGroups(): Promise<void> {
    try {
      const groupStateManager = this.sessionManager.getGroupStateManager();
      const allGroupStates = await groupStateManager.getAllGroupStates();

      this.knownGroupIds = new Set(Object.keys(allGroupStates));
      console.log(
        `📊 Initialized with ${this.knownGroupIds.size} known groups`
      );
    } catch (error) {
      console.error("❌ Error initializing known groups:", error);
      this.knownGroupIds = new Set();
    }
  }

  /**
   * Check for new groups by syncing conversations and comparing with known groups
   */
  private async checkForNewGroups(): Promise<void> {
    try {
      // Sync conversations to discover new groups
      // console.log("🔄 Syncing conversations...");
      await this.client.conversations.sync();

      // Get all current conversations
      const conversations = await this.client.conversations.list();
      const currentGroupIds = new Set<string>();
      const newGroups: Array<{
        conversation: Conversation<any>;
        groupId: string;
      }> = [];

      // Process each conversation
      for (const conversation of conversations) {
        try {
          const members = await conversation.members();
          const isGroupChat = members.length > 2;

          if (isGroupChat) {
            const groupId = conversation.id;
            currentGroupIds.add(groupId);

            // Check if this is a new group we haven't seen before
            if (!this.knownGroupIds.has(groupId)) {
              console.log(
                `🆕 Detected new group: ${groupId} (${members.length} members)`
              );
              newGroups.push({ conversation, groupId });
            }
          }
        } catch (error) {
          console.error(
            `❌ Error processing conversation ${conversation.id}:`,
            error
          );
        }
      }

      // Update known groups
      this.knownGroupIds = currentGroupIds;

      if (newGroups.length > 0) {
        console.log(
          `🚀 Processing ${newGroups.length} new groups in parallel...`
        );

        // Create all group states in batch with single write operation (fast)
        await this.sessionManager
          .getGroupStateManager()
          .batchInitializeEmptyGroups(newGroups.map((g) => g.groupId));

        // Send welcome messages to all new groups in parallel (non-blocking)
        const welcomePromises = newGroups.map(({ conversation, groupId }) =>
          this.sendWelcomeMessage(conversation, groupId).catch((error) => {
            console.error(
              `❌ Error sending welcome message to group ${groupId}:`,
              error
            );
            // Don't throw to avoid breaking other promises
          })
        );

        // Execute all welcome messages in parallel
        await Promise.all(welcomePromises);
        console.log(`✅ Processed ${newGroups.length} new groups in parallel`);
      }
    } catch (error) {
      console.error("❌ Error checking for new groups:", error);
    }
  }

  /**
   * Send welcome message to a new group using the same prompt structure as QAFlow
   */
  private async sendWelcomeMessage(
    conversation: Conversation<any>,
    groupId: string
  ): Promise<void> {
    try {
      console.log(`💬 Sending welcome message to new group: ${groupId}`);

      // Use the same prompt structure from QAFlow for capability explanation
      const response = `🐾 gmeow!

flaunching coins is as easy as tagging me. here's what i do:
- i help you launch coins and automatically split trading fees equally with everyone here. no complex setup needed.  

how it works:
- just provide coin details (name, ticker, image attachment)  
- coin starts at: $1000 market cap, 10% supply in fair launch for 30-minute duration  
- you can ask to prebuy % of supply within the launch tx

how to interact:  
- tag me @Flaunchy or reply to my messages  
- everyone in this chat is instantly part of any launched coins  
- example: "@Flaunchy let's launch a coin"  

so, let's get to launching some great coins together!`;

      // Send the response to the group
      await conversation.send(response);
      console.log(`✅ Welcome message sent to group: ${groupId}`);

      // Note: Group state is now created in batch, so we don't create it here
    } catch (error) {
      console.error(
        `❌ Error sending welcome message to group ${groupId}:`,
        error
      );
      throw error;
    }
  }

  /**
   * Get current status of the service
   */
  getStatus(): {
    isRunning: boolean;
    knownGroupsCount: number;
    syncIntervalMs: number;
  } {
    return {
      isRunning: this.isRunning,
      knownGroupsCount: this.knownGroupIds.size,
      syncIntervalMs: this.syncIntervalMs,
    };
  }
}
