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
    
    // PRIORITY 1: If user has pending transaction, check if they're asking about it
    if (userState.pendingTransaction) {
      const isTransactionInquiry = await this.isTransactionInquiry(context, messageText);
      if (isTransactionInquiry) {
        console.log(`[FlowRouter] User has pending transaction and is asking about it - staying in current flow`);
        // Keep them in their current flow (onboarding or management)
        if (userState.status === 'onboarding' || userState.status === 'new') {
          return 'onboarding';
        } else {
          return 'management';
        }
      }
    }
    
    // Always use intent classification for other cases
    const intentResult = await this.intentClassifier.classifyIntent(messageText, userState);
    const flowType = this.intentToFlowType(intentResult.intent, userState);
    
    console.log(`[FlowRouter] Intent: ${intentResult.intent} (confidence: ${intentResult.confidence.toFixed(2)}) - ${intentResult.reasoning}`);
    
    // OVERRIDE: Only keep user in onboarding if they have active onboarding AND the intent is onboarding-related
    if ((userState.status === 'onboarding' || userState.status === 'new') && userState.onboardingProgress) {
      
      // Check if this is an onboarding-related question that should stay in onboarding
      const isOnboardingQuestion = this.isOnboardingRelatedQuestion(messageText);
      
      if (isOnboardingQuestion) {
        console.log(`[FlowRouter] User in onboarding asking onboarding-related question - keeping in onboarding`);
        return 'onboarding';
      }
      
      // If intent is clearly NOT onboarding (management, qa, etc.), respect that
      if (intentResult.intent !== 'onboarding' && intentResult.confidence > 0.7) {
        console.log(`[FlowRouter] User in onboarding but intent is ${intentResult.intent} with high confidence - routing to ${flowType}`);
        return flowType;
      }
      
      // If intent is onboarding or low confidence, keep in onboarding
      console.log(`[FlowRouter] User in active onboarding (status: ${userState.status}, step: ${userState.onboardingProgress.step}) - keeping in onboarding`);
      return 'onboarding';
    }

    return flowType;
  }

  private async isTransactionInquiry(context: FlowContext, messageText: string): Promise<boolean> {
    const { openai } = context;
    
    const prompt = `
      User has a pending transaction and said: "${messageText}"
      
      Is this user asking about their pending transaction? Look for:
      - Questions about transaction details (addresses, receivers, amounts, etc.)
      - Requests to see transaction info
      - Questions about who's included
      - Asking about the group/coin being created
      - Cancellation requests
      
      Return ONLY:
      "yes" - if they're asking about the pending transaction
      "no" - if they're asking about something else entirely
    `;

    const response = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.1,
      max_tokens: 10
    });

    return response.choices[0]?.message?.content?.trim()?.toLowerCase() === 'yes';
  }

  private isOnboardingRelatedQuestion(messageText: string): boolean {
    const lowerMessage = messageText.toLowerCase();
    
    // Questions about fee receivers, groups, or basic concepts during onboarding
    const onboardingQuestions = [
      'who are the fee receivers',
      'what are fee receivers',
      'who should receive',
      'what is a fee receiver',
      'how do fee receivers work',
      'what does fee receiver mean',
      'who gets the fees',
      'how does fee splitting work',
      'what is a group',
      'how do groups work',
      'what is group creation',
      'how does this work',
      'what do i need',
      'what should i provide',
      'how do i specify',
      'what format',
      'can you explain',
      'i don\'t understand',
      'what does this mean',
      // Transaction inquiry patterns
      'what addresses are in',
      'who is in the group',
      'what addresses',
      'who are the receivers',
      'who gets the fees',
      'what percentage',
      'how much does each',
      'what are the splits',
      'show me the transaction',
      'what\'s in the transaction',
      'transaction details',
      'who\'s included'
    ];
    
    return onboardingQuestions.some(question => lowerMessage.includes(question));
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