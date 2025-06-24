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

    // PRIORITY: Check if user is in active onboarding - keep them there unless it's a clear QA request
    const flowType = await this.determineFlowType(context);
    const flow = this.flows[flowType];
    
    console.log(`[FlowRouter] Routing to ${flowType} flow for user ${context.userState.userId}`);
    
    try {
      await flow.processMessage(context);
    } catch (error) {
      console.error(`[FlowRouter] Error in ${flowType} flow:`, error);
      await context.sendResponse("sorry, something went wrong. please try again or type 'help' for assistance.");
    }
  }

  private async determineFlowType(context: FlowContext): Promise<FlowType> {
    const { userState, messageText } = context;
    
    // PRIORITY 1: Active onboarding - keep user in onboarding unless clear QA
    if ((userState.status === 'onboarding' || userState.status === 'new') && userState.onboardingProgress) {
      // Only allow QA for clear help requests
      if (this.isQARequest(messageText)) {
        console.log(`[FlowRouter] User in onboarding but requesting help - routing to QA`);
        return 'qa';
      }
      
      console.log(`[FlowRouter] User in active onboarding (status: ${userState.status}, step: ${userState.onboardingProgress.step}) - keeping in onboarding`);
      return 'onboarding';
    }

    // PRIORITY 2: Use intent classification for other cases
    const intentResult = await this.intentClassifier.classifyIntent(messageText, userState);
    const flowType = this.intentToFlowType(intentResult.intent, userState);
    
    console.log(`[FlowRouter] Intent: ${intentResult.intent} (confidence: ${intentResult.confidence.toFixed(2)}) - ${intentResult.reasoning}`);
    
    return flowType;
  }

  private isQARequest(message: string): boolean {
    const qaKeywords = ['help', 'what', 'how', 'explain', 'tell me', '?'];
    const lowerMessage = message.toLowerCase();
    return qaKeywords.some(keyword => lowerMessage.includes(keyword));
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