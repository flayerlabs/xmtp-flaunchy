import { UserState } from "../types/UserState";
import { FlowContext } from "../types/FlowContext";
import { BaseFlow } from "./BaseFlow";
import { IntentClassifier, MessageIntent } from "./IntentClassifier";
import OpenAI from "openai";

export type FlowType = 'onboarding' | 'qa' | 'management' | 'coin_launch';

export interface FlowRegistry {
  onboarding: BaseFlow;
  qa: BaseFlow;
  management: BaseFlow;
  coin_launch: BaseFlow;
}

export class FlowRouter {
  private flows: FlowRegistry;
  private intentClassifier: IntentClassifier;

  constructor(flows: FlowRegistry, openai: OpenAI) {
    this.flows = flows;
    this.intentClassifier = new IntentClassifier(openai);
  }

  async routeMessage(context: FlowContext): Promise<void> {
    // Skip transaction receipt messages that come as '...'
    if (context.messageText.trim() === '...') {
      console.log(`[FlowRouter] Skipping transaction receipt message for user ${context.userState.userId}`);
      return;
    }

    const intentResult = await this.intentClassifier.classifyIntent(context.messageText, context.userState);
    const flowType = this.intentToFlowType(intentResult.intent, context.userState);
    const flow = this.flows[flowType];
    
    console.log(`[FlowRouter] Intent: ${intentResult.intent} (confidence: ${intentResult.confidence.toFixed(2)}) - ${intentResult.reasoning}`);
    console.log(`[FlowRouter] Routing to ${flowType} flow for user ${context.userState.userId}`);
    
    try {
      await flow.processMessage(context);
    } catch (error) {
      console.error(`[FlowRouter] Error in ${flowType} flow:`, error);
      await context.sendResponse("sorry, something went wrong. please try again or type 'help' for assistance.");
    }
  }

  private intentToFlowType(intent: MessageIntent, userState?: UserState): FlowType {
    switch (intent) {
      case 'onboarding':
        return 'onboarding';
      case 'coin_launch':
        return 'coin_launch';
      case 'management':
        return 'management';
      case 'qa':
        return 'qa';
      case 'confirmation':
        // For confirmations, route based on user state context
        if (userState) {
          // If user has no groups, likely confirming group creation
          if (userState.groups.length === 0) {
            return 'onboarding';
          }
          // If user has groups, might be confirming coin launch
          return 'coin_launch';
        }
        // Default fallback
        return 'qa';
      default:
        return 'qa';
    }
  }



  // Helper method to register or update flows
  updateFlow(flowType: FlowType, flow: BaseFlow): void {
    this.flows[flowType] = flow;
  }

  // Get current flow for a user (useful for debugging)
  async getCurrentFlowType(userState: UserState, message: string): Promise<FlowType> {
    const intentResult = await this.intentClassifier.classifyIntent(message, userState);
    return this.intentToFlowType(intentResult.intent, userState);
  }
} 