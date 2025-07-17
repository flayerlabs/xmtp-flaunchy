import { FlowRouter_detectMultipleIntentsPrompt } from "../../data/prompts/FlowRouter_detectMultipleIntentsPrompt";
import { LLMResponse } from "../messaging/LLMResponse";
import { FlowContext } from "../types/FlowContext";
import { BaseFlow } from "./BaseFlow";

export type FlowType = "qa" | "management" | "coin_launch";

export interface FlowRegistry {
  qa: BaseFlow;
  management: BaseFlow;
  coin_launch: BaseFlow;
}

export interface UnifiedRoutingResult {
  // Transaction-related
  isTransactionInquiry: boolean;

  // Question classification
  questionType: "capability" | "informational" | null;

  // Coin launch related
  isMultipleCoinRequest: boolean;

  // Action classification
  actionType:
    | "coin_launch"
    | "modify_existing"
    | "inquiry"
    | "greeting"
    | "other";
  confidence: number;
  reasoning: string;
}

export interface MultiIntentResult {
  primaryIntent: {
    type: "action" | "question" | "management" | "social" | "other";
    action:
      | "coin_launch"
      | "modify_existing"
      | "inquiry"
      | "greeting"
      | "cancel"
      | "management"
      | "other";
    confidence: number;
    reasoning: string;
  };
  secondaryIntents: Array<{
    type: "action" | "question" | "management" | "social" | "other";
    action:
      | "coin_launch"
      | "modify_existing"
      | "inquiry"
      | "greeting"
      | "cancel"
      | "management"
      | "other";
    confidence: number;
  }>;
  flags: {
    isTransactionInquiry: boolean;
    isStatusInquiry: boolean;
  };
}

export class FlowRouter {
  private flows: FlowRegistry;

  constructor(flows: FlowRegistry) {
    this.flows = flows;
  }

  async routeMessage(context: FlowContext): Promise<void> {
    // Skip transaction receipt messages that come as '...'
    if (context.messageText.trim() === "...") {
      console.log(
        `[FlowRouter] Skipping transaction receipt message for user ${context.creatorAddress}`
      );
      return;
    }

    try {
      // 1. Detect ALL intents in the message
      const multiIntentResult = await this.detectMultipleIntents(context);

      // 2. Determine primary flow based on primary intent (supports both architectures)
      const primaryFlow = this.getPrimaryFlow(multiIntentResult, context);

      // 3. Add multi-intent result to context so flows can handle secondary intents
      context.multiIntentResult = multiIntentResult;

      // Enhanced logging with all detection details
      console.log(
        `[FlowRouter] 🎯 Primary: ${
          multiIntentResult.primaryIntent.action
        } (${multiIntentResult.primaryIntent.confidence.toFixed(
          2
        )}) → ${primaryFlow} | Secondary: [${multiIntentResult.secondaryIntents
          .map((s) => `${s.action}(${s.confidence.toFixed(2)})`)
          .join(", ")}]`
      );
      console.log(
        `[FlowRouter] 🏷️  Flags: ${
          Object.entries(multiIntentResult.flags)
            .filter(([_, value]) => value)
            .map(([key, _]) => key)
            .join(", ") || "none"
        }`
      );

      // 4. Process with primary flow
      const flow = this.flows[primaryFlow];
      await flow.processMessage(context);
    } catch (error) {
      console.error(`[FlowRouter] Error:`, error);
      await context.sendResponse(
        "sorry, something went wrong. please try again or type 'help' for assistance."
      );
    }
  }

  /**
   * Detect all intents in a message using a single API call
   * Now supports both old and new architecture
   */
  async detectMultipleIntents(
    context: FlowContext
  ): Promise<MultiIntentResult> {
    const { messageText, participantState } = context;

    if (!messageText.trim()) {
      return {
        primaryIntent: {
          type: "other",
          action: "other",
          confidence: 0.1,
          reasoning: "Empty message",
        },
        secondaryIntents: [],
        flags: {
          isTransactionInquiry: false,
          isStatusInquiry: false,
        },
      };
    }

    const groupCount = 1; // Participant is in this group, so at least 1
    const coinCount = context.groupState?.coins?.length || 0;
    const pendingTxType = participantState?.pendingTransaction?.type || "none";

    console.log(
      `[FlowRouter] 🔍 Analyzing: "${messageText}" | Status: ${status} | Groups: ${groupCount} | Coins: ${coinCount} | PendingTx: ${pendingTxType}`
    );

    try {
      const response = await LLMResponse.getResponse({
        context,
        prompt: FlowRouter_detectMultipleIntentsPrompt({
          messageText,
          status,
          groupCount,
          coinCount,
          pendingTxType,
        }),
        max_tokens: 800,
      });
      if (!response) {
        throw new Error("No response from LLM");
      }

      // Extract JSON from response
      const jsonMatch = response.match(/```json\n([\s\S]*?)\n```/);
      if (!jsonMatch) {
        throw new Error("No JSON found in response");
      }

      const result = JSON.parse(jsonMatch[1]);

      // Validate and sanitize result
      return this.validateMultiIntentResult(result);
    } catch (error) {
      console.error("[FlowRouter] Failed to detect intents:", error);

      // Fallback: basic intent detection
      return {
        primaryIntent: {
          type: "question",
          action: "inquiry",
          confidence: 0.5,
          reasoning: "Fallback due to detection error",
        },
        secondaryIntents: [],
        flags: {
          isTransactionInquiry:
            messageText.toLowerCase().includes("transaction") ||
            messageText.toLowerCase().includes("pending"),
          isStatusInquiry:
            messageText.toLowerCase().includes("do i have") ||
            messageText.toLowerCase().includes("status"),
        },
      };
    }
  }

  /**
   * Validate and sanitize multi-intent result
   */
  validateMultiIntentResult(result: any): MultiIntentResult {
    const validTypes = ["action", "question", "management", "social", "other"];
    const validActions = [
      "coin_launch",
      "modify_existing",
      "inquiry",
      "greeting",
      "cancel",
      "management",
      "other",
    ];

    return {
      primaryIntent: {
        type: validTypes.includes(result.primaryIntent?.type)
          ? result.primaryIntent.type
          : "question",
        action: validActions.includes(result.primaryIntent?.action)
          ? result.primaryIntent.action
          : "other",
        confidence: Math.max(
          0.1,
          Math.min(1.0, Number(result.primaryIntent?.confidence) || 0.5)
        ),
        reasoning: String(
          result.primaryIntent?.reasoning || "No reasoning provided"
        ),
      },
      secondaryIntents: (result.secondaryIntents || []).map((intent: any) => ({
        type: validTypes.includes(intent.type) ? intent.type : "question",
        action: validActions.includes(intent.action) ? intent.action : "other",
        confidence: Math.max(
          0.1,
          Math.min(1.0, Number(intent.confidence) || 0.3)
        ),
      })),
      flags: {
        isTransactionInquiry: Boolean(result.flags?.isTransactionInquiry),
        isStatusInquiry: Boolean(result.flags?.isStatusInquiry),
      },
    };
  }

  /**
   * Determine primary flow based on primary intent and context
   * SIMPLIFIED: Agent is now just a coin launcher with automatic group creation
   * Now supports both old and new architecture
   */
  getPrimaryFlow(
    multiIntentResult: MultiIntentResult,
    context: FlowContext
  ): FlowType {
    const { primaryIntent, flags } = multiIntentResult;

    // Extract state information from new group-centric architecture
    const hasCoinLaunchProgress = context.participantState?.coinLaunchProgress;
    const hasPendingTransaction = context.participantState?.pendingTransaction;

    // SIMPLIFIED PRIORITY LOGIC

    // Priority 0: HIGHEST PRIORITY - Continue existing coin launch progress
    // This ensures attachment-only messages during coin launch go to the right flow
    // Takes precedence over status inquiries to handle coin data collection properly
    if (hasCoinLaunchProgress) {
      // Only continue coin launch if:
      // 1. It's an attachment-only message (image upload), OR
      // 2. It's NOT a clear inquiry (let inquiries go to QA)
      const isAttachmentOnly =
        context.hasAttachment && !context.messageText.trim();
      const isInquiry =
        primaryIntent.action === "inquiry" && primaryIntent.confidence >= 0.7;

      if (isAttachmentOnly || !isInquiry) {
        console.log(
          `[FlowRouter] ✅ Existing coin launch progress → coin_launch ${
            isAttachmentOnly ? "(attachment-only)" : "(continuing launch)"
          }`
        );
        return "coin_launch";
      } else {
        console.log(
          `[FlowRouter] 🔄 Coin launch progress exists but inquiry detected → routing to qa`
        );
      }
    }

    // Priority 1: Status inquiries go to QA
    // User wants to know about their current state
    if (
      primaryIntent.action === "inquiry" &&
      (flags.isStatusInquiry || flags.isTransactionInquiry) &&
      primaryIntent.confidence >= 0.7
    ) {
      console.log(`[FlowRouter] ✅ Status inquiry → qa`);
      return "qa";
    }

    // Priority 2: Action intents (what user wants to DO)
    if (primaryIntent.type === "action") {
      switch (primaryIntent.action) {
        case "coin_launch":
          // All coin launches go to coin_launch flow (handles auto group creation)
          console.log(`[FlowRouter] ✅ Launch coin → coin_launch`);
          return "coin_launch";

        case "modify_existing":
          // Handle modifications in the appropriate context
          if (hasPendingTransaction) {
            const pendingTxType =
              context.participantState?.pendingTransaction?.type;
            if (pendingTxType === "coin_creation") {
              console.log(`[FlowRouter] ✅ Modify pending coin → coin_launch`);
              return "coin_launch";
            }
          }
          console.log(`[FlowRouter] ✅ Modify existing → coin_launch`);
          return "coin_launch";
      }
    }

    // Priority 3: Questions (what user wants to KNOW)
    if (primaryIntent.type === "question") {
      console.log(`[FlowRouter] ✅ Question → qa`);
      return "qa";
    }

    // Priority 4: Management tasks
    if (
      primaryIntent.type === "management" ||
      primaryIntent.action === "cancel"
    ) {
      console.log(`[FlowRouter] ✅ Management → management`);
      return "management";
    }

    // Priority 5: Social/Greetings - route to QA for explanation
    if (
      primaryIntent.type === "social" ||
      primaryIntent.action === "greeting"
    ) {
      console.log(`[FlowRouter] ✅ Greeting → qa (explain how agent works)`);
      return "qa";
    }

    // Priority 6: Other/Unknown intents - route to QA for help
    if (primaryIntent.type === "other" || primaryIntent.action === "other") {
      console.log(`[FlowRouter] ✅ Other → qa (help and explanation)`);
      return "qa";
    }

    // Priority 7: Fallback - route to QA
    console.log(`[FlowRouter] ✅ Fallback → qa`);
    return "qa";
  }

  // =============================================================================
  // HELPER METHODS
  // =============================================================================

  /**
   * Update a flow in the registry
   */
  updateFlow(flowType: FlowType, flow: BaseFlow): void {
    this.flows[flowType] = flow;
  }
}
