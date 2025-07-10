import { UserState } from "../types/UserState";
import { FlowContext } from "../types/FlowContext";
import { BaseFlow } from "./BaseFlow";
import { IntentClassifier, MessageIntent } from "./IntentClassifier";
import { safeParseJSON } from "../utils/jsonUtils";
import OpenAI from "openai";

export type FlowType = 'onboarding' | 'qa' | 'management' | 'coin_launch' | 'group_launch';

export interface FlowRegistry {
  onboarding: BaseFlow;
  qa: BaseFlow;
  management: BaseFlow;
  coin_launch: BaseFlow;
  group_launch: BaseFlow;
}

export interface UnifiedRoutingResult {
  // Greeting detection
  isGreeting: boolean;
  
  // Transaction-related
  isTransactionInquiry: boolean;
  isCancellation: boolean;
  
  // Question classification
  questionType: 'capability' | 'informational' | null;
  
  // Group-related detections
  isAddEveryone: boolean;
  isNewGroupCreation: boolean;
  isGroupCreationResponse: boolean;
  isAddToExistingGroup: boolean;
  isCompleteGroupReplacement: boolean;
  
  // Onboarding-related
  isOnboardingRelated: boolean;
  isOnboardingQuestion: boolean;
  isExistingReceiversInquiry: boolean;
  
  // Fee/percentage modifications
  isFeeSplitModification: boolean;
  isPercentageUpdate: boolean;
  
  // Coin launch related
  isContinuingCoinLaunch: boolean;
  isMultipleCoinRequest: boolean;
  
  // Action classification
  actionType: 'create_group' | 'launch_coin' | 'modify_existing' | 'inquiry' | 'greeting' | 'other';
  confidence: number;
  reasoning: string;
}

export interface MultiIntentResult {
  primaryIntent: {
    type: 'action' | 'question' | 'management' | 'social' | 'other';
    action: 'create_group' | 'launch_coin' | 'modify_existing' | 'inquiry' | 'greeting' | 'cancel' | 'management' | 'other';
    confidence: number;
    reasoning: string;
  };
  secondaryIntents: Array<{
    type: 'action' | 'question' | 'management' | 'social' | 'other';
    action: 'create_group' | 'launch_coin' | 'modify_existing' | 'inquiry' | 'greeting' | 'cancel' | 'management' | 'other';
    confidence: number;
  }>;
  flags: {
    isGreeting: boolean;
    isTransactionInquiry: boolean;
    isCancellation: boolean;
    isAddEveryone: boolean; // Consolidated: covers "everyone", "all of us", "create group for everyone", etc.
    isOnboardingRelated: boolean;
    isStatusInquiry: boolean;
  };
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

    try {
      // 1. Detect ALL intents in the message
      const multiIntentResult = await this.detectMultipleIntents(context);
      
      // 2. Determine primary flow based on primary intent
      const primaryFlow = this.getPrimaryFlow(multiIntentResult, context.userState);
      
      // 3. Add multi-intent result to context so flows can handle secondary intents
      context.multiIntentResult = multiIntentResult;
      
      // Enhanced logging with all detection details
      console.log(`[FlowRouter] 🎯 Primary: ${multiIntentResult.primaryIntent.action} (${multiIntentResult.primaryIntent.confidence.toFixed(2)}) → ${primaryFlow} | Secondary: [${multiIntentResult.secondaryIntents.map(s => `${s.action}(${s.confidence.toFixed(2)})`).join(', ')}]`);
      console.log(`[FlowRouter] 🏷️  Flags: ${Object.entries(multiIntentResult.flags).filter(([_, value]) => value).map(([key, _]) => key).join(', ') || 'none'}`);
      
      // 4. Process with primary flow
      const flow = this.flows[primaryFlow];
      await flow.processMessage(context);
      
    } catch (error) {
      console.error(`[FlowRouter] Error:`, error);
      await context.sendResponse("sorry, something went wrong. please try again or type 'help' for assistance.");
    }
  }

  /**
   * Detect all intents in a message using a single API call
   */
  private async detectMultipleIntents(context: FlowContext): Promise<MultiIntentResult> {
    const { messageText, userState } = context;
    
    if (!messageText.trim()) {
      return {
        primaryIntent: { type: 'other', action: 'other', confidence: 0.1, reasoning: 'Empty message' },
        secondaryIntents: [],
        flags: {
          isGreeting: false,
          isTransactionInquiry: false,
          isCancellation: false,
          isAddEveryone: false,
          isOnboardingRelated: false,
          isStatusInquiry: false
        }
      };
    }

    console.log(`[FlowRouter] 🔍 Analyzing: "${messageText}" | Status: ${userState.status} | Groups: ${userState.groups.length} | Coins: ${userState.coins.length} | PendingTx: ${userState.pendingTransaction?.type || 'none'}`);

    try {
      const response = await context.openai.chat.completions.create({
        model: 'gpt-4o-mini',
        messages: [{
          role: 'user',
          content: `Analyze this message for ALL intents (not just one):

MESSAGE: "${messageText}"

USER CONTEXT:
- Status: ${userState.status}
- Groups: ${userState.groups.length}
- Coins: ${userState.coins.length}  
- Pending Transaction: ${userState.pendingTransaction?.type || 'none'}

DETECT ALL INTENTS in order of importance:

PRIMARY INTENT (most important):
1. ACTIONS: create_group, launch_coin, modify_existing (removing/adding people, changing fees)
2. QUESTIONS: inquiry (status questions, how-tos, what groups do I have?)
3. MANAGEMENT: cancel, management (managing existing groups/coins)
4. SOCIAL: greeting

SECONDARY INTENTS (also in the message):
- Any other intents that should be handled after the primary

FLAGS (detect these patterns):
- isGreeting: Contains greeting words
- isTransactionInquiry: Asking about pending transactions/status
- isCancellation: Wants to cancel something  
- isAddEveryone: "everyone", "all of us", "all members", "create group for everyone", "add everyone" (be tolerant of typos like "ebeyrone" for "everyone")
- isOnboardingRelated: Related to first-time setup
- isStatusInquiry: "do I have", "what's my status", "what groups"

Return JSON:
\`\`\`json
{
  "primaryIntent": {
    "type": "action|question|management|social",
    "action": "create_group|launch_coin|modify_existing|inquiry|greeting|cancel|management|other",
    "confidence": 0.0-1.0,
    "reasoning": "why this is primary"
  },
  "secondaryIntents": [
    {
      "type": "action|question|management|social", 
      "action": "...",
      "confidence": 0.0-1.0
    }
  ],
  "flags": {
    "isGreeting": boolean,
    "isTransactionInquiry": boolean,
    "isCancellation": boolean,
    "isAddEveryone": boolean,
    "isOnboardingRelated": boolean,
    "isStatusInquiry": boolean
  }
}
\`\`\`
        `,
        }],
        temperature: 0.1,
        max_tokens: 800
      });

      const content = response.choices[0]?.message?.content?.trim();
      if (!content) {
        throw new Error('No response from LLM');
      }

      // Extract JSON from response
      const jsonMatch = content.match(/```json\n([\s\S]*?)\n```/);
      if (!jsonMatch) {
        throw new Error('No JSON found in response');
      }

      const result = JSON.parse(jsonMatch[1]);
      
      // Validate and sanitize result
      return this.validateMultiIntentResult(result);
      
    } catch (error) {
      console.error('[FlowRouter] Failed to detect intents:', error);
      
      // Fallback: basic intent detection
      return {
        primaryIntent: { 
          type: 'question', 
          action: 'inquiry', 
          confidence: 0.5, 
          reasoning: 'Fallback due to detection error' 
        },
        secondaryIntents: [],
        flags: {
          isGreeting: messageText.toLowerCase().includes('hey') || messageText.toLowerCase().includes('hello'),
          isTransactionInquiry: messageText.toLowerCase().includes('transaction') || messageText.toLowerCase().includes('pending'),
          isCancellation: messageText.toLowerCase().includes('cancel'),
          isAddEveryone: messageText.toLowerCase().includes('everyone'),
          isOnboardingRelated: false,
          isStatusInquiry: messageText.toLowerCase().includes('do i have') || messageText.toLowerCase().includes('status')
        }
      };
    }
  }

  /**
   * Validate and sanitize multi-intent result
   */
  private validateMultiIntentResult(result: any): MultiIntentResult {
    const validTypes = ['action', 'question', 'management', 'social', 'other'];
    const validActions = ['create_group', 'launch_coin', 'modify_existing', 'inquiry', 'greeting', 'cancel', 'management', 'other'];

    return {
      primaryIntent: {
        type: validTypes.includes(result.primaryIntent?.type) ? result.primaryIntent.type : 'question',
        action: validActions.includes(result.primaryIntent?.action) ? result.primaryIntent.action : 'other',
        confidence: Math.max(0.1, Math.min(1.0, Number(result.primaryIntent?.confidence) || 0.5)),
        reasoning: String(result.primaryIntent?.reasoning || 'No reasoning provided')
      },
      secondaryIntents: (result.secondaryIntents || []).map((intent: any) => ({
        type: validTypes.includes(intent.type) ? intent.type : 'question',
        action: validActions.includes(intent.action) ? intent.action : 'other',
        confidence: Math.max(0.1, Math.min(1.0, Number(intent.confidence) || 0.3))
      })),
      flags: {
        isGreeting: Boolean(result.flags?.isGreeting),
        isTransactionInquiry: Boolean(result.flags?.isTransactionInquiry),
        isCancellation: Boolean(result.flags?.isCancellation),
        isAddEveryone: Boolean(result.flags?.isAddEveryone),
        isOnboardingRelated: Boolean(result.flags?.isOnboardingRelated),
        isStatusInquiry: Boolean(result.flags?.isStatusInquiry)
      }
    };
  }

  /**
   * Determine primary flow based on primary intent and user state
   */
  private getPrimaryFlow(multiIntentResult: MultiIntentResult, userState: UserState): FlowType {
    const { primaryIntent, flags } = multiIntentResult;
    
    // CLEAN PRIORITY LOGIC BASED ON USER INTENT

    // Priority 1: High-confidence status inquiries always go to QA
    if (primaryIntent.action === 'inquiry' && 
        (flags.isStatusInquiry || flags.isTransactionInquiry) && 
        primaryIntent.confidence >= 0.7) {
      console.log(`[FlowRouter] ✅ Status inquiry → qa`);
      return 'qa';
    }

    // Priority 2: Action intents (what user wants to DO)
    if (primaryIntent.type === 'action') {
      switch (primaryIntent.action) {
        case 'create_group':
          // Route based on user's current state
          if (userState.groups.length === 0) {
            console.log(`[FlowRouter] ✅ Create first group → onboarding`);
            return 'onboarding';
          } else {
            console.log(`[FlowRouter] ✅ Create additional group → group_launch`);
            return 'group_launch';
          }
          
        case 'launch_coin':
          if (userState.groups.length === 0) {
            console.log(`[FlowRouter] ✅ Launch coin (no groups) → onboarding`);
            return 'onboarding';
          } else {
            console.log(`[FlowRouter] ✅ Launch coin → coin_launch`);
            return 'coin_launch';
          }
          
        case 'modify_existing':
          // Handle modifications in the appropriate context
          if (userState.pendingTransaction) {
            if (userState.pendingTransaction.type === 'group_creation') {
              const targetFlow = userState.status === 'onboarding' ? 'onboarding' : 'management';
              console.log(`[FlowRouter] ✅ Modify pending group → ${targetFlow}`);
              return targetFlow;
            } else if (userState.pendingTransaction.type === 'coin_creation') {
              console.log(`[FlowRouter] ✅ Modify pending coin → coin_launch`);
              return 'coin_launch';
            }
          }
          console.log(`[FlowRouter] ✅ Modify existing → management`);
          return 'management';
      }
    }

    // Priority 3: Questions (what user wants to KNOW)
    if (primaryIntent.type === 'question') {
      console.log(`[FlowRouter] ✅ Question → qa`);
      return 'qa';
    }

    // Priority 4: Management tasks
    if (primaryIntent.type === 'management' || primaryIntent.action === 'cancel') {
      console.log(`[FlowRouter] ✅ Management → management`);
      return 'management';
    }

    // Priority 5: Social/Greetings - route based on user needs
    if (primaryIntent.type === 'social' || primaryIntent.action === 'greeting') {
      if (this.shouldStayInOnboarding(userState)) {
        console.log(`[FlowRouter] ✅ Greeting + needs onboarding → onboarding`);
        return 'onboarding';
      } else {
        console.log(`[FlowRouter] ✅ Greeting + completed user → management`);
        return 'management';
      }
    }

    // Priority 6: Other/Unknown intents - route based on user state
    if (primaryIntent.type === 'other' || primaryIntent.action === 'other') {
      if (this.shouldStayInOnboarding(userState)) {
        console.log(`[FlowRouter] ✅ Other + needs onboarding → onboarding`);
        return 'onboarding';
      } else {
        console.log(`[FlowRouter] ✅ Other + completed user → qa`);
        return 'qa';
      }
    }

    // Priority 7: Fallback - route based on user state
    if (this.shouldStayInOnboarding(userState)) {
      console.log(`[FlowRouter] ✅ Fallback + needs onboarding → onboarding`);
      return 'onboarding';
    } else {
      console.log(`[FlowRouter] ✅ Fallback → qa`);
      return 'qa';
    }
  }

  // =============================================================================
  // HELPER METHODS
  // =============================================================================

  /**
   * Determines if user should stay in onboarding flow
   */
  private shouldStayInOnboarding(userState: UserState): boolean {
    // User is in onboarding status
    if (userState.status === 'onboarding') {
      return true;
    }

    // User has no groups and no onboarding progress
    if (userState.groups.length === 0 && !userState.onboardingProgress) {
      return true;
    }

    // User has partial onboarding progress but no completed groups
    if (userState.onboardingProgress && 
        userState.onboardingProgress.step !== 'completed' && 
        userState.groups.length === 0) {
      return true;
    }

    return false;
  }

  /**
   * Update a flow in the registry
   */
  updateFlow(flowType: FlowType, flow: BaseFlow): void {
    this.flows[flowType] = flow;
  }

  /**
   * Get current flow type for a user (for compatibility)
   */
  async getCurrentFlowType(userState: UserState, message: string, hasAttachment: boolean = false): Promise<FlowType> {
    // Create a minimal context for detection
    const context = {
      userState,
      messageText: message,
      hasAttachment
    } as FlowContext;

    const multiIntentResult = await this.detectMultipleIntents(context);
    return this.getPrimaryFlow(multiIntentResult, userState);
  }
} 