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
  isGroupForEveryone: boolean;
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
    
    // Single comprehensive log for routing context
    console.log(`[FlowRouter] 🎯 ROUTING "${messageText}" | Status: ${userState.status} | Groups: ${userState.groups.length} | Coins: ${userState.coins.length} | PendingTx: ${userState.pendingTransaction?.type || 'none'}`);
    
    // Unified detection - single API call for all routing decisions
    const detectionResult = await this.performUnifiedDetection(context, messageText);
    console.log(`[FlowRouter] 🔍 Detection: ${detectionResult.actionType} (${detectionResult.confidence.toFixed(2)}) | ${detectionResult.reasoning}`);
    
    // Add detection result to context so flows can use it without re-detecting
    context.detectionResult = detectionResult;
    
    // Priority 0: Greeting handling
    if (detectionResult.isGreeting) {
      if (this.shouldStayInOnboarding(userState)) {
        console.log(`[FlowRouter] ✅ Greeting + needs onboarding → onboarding`);
        return 'onboarding';
      } else {
        await this.handleCompletedUserGreeting(context);
        console.log(`[FlowRouter] ✅ Greeting + completed user → management`);
        return 'management';
      }
    }
    
    // Get intent classification for final routing decisions
    const intentResult = await this.intentClassifier.classifyIntent(messageText, userState, context.hasAttachment);
    
    // Priority 1: Pending transaction handling
    if (userState.pendingTransaction && detectionResult.isTransactionInquiry) {
      const targetFlow = this.getFlowForPendingTransaction(userState);
      console.log(`[FlowRouter] ✅ Pending transaction inquiry → ${targetFlow}`);
      return targetFlow;
    }
    
    // Priority 2: Invited user welcome
    if (userState.status === 'invited') {
      console.log(`[FlowRouter] ✅ Invited user → management`);
      return 'management';
    }

    // Priority 3: Immediate high-confidence actions
    if (detectionResult.isGroupForEveryone) {
      const targetFlow = userState.groups.length > 0 ? 'group_launch' : 'onboarding';
      console.log(`[FlowRouter] ✅ Group for everyone → ${targetFlow}`);
      return targetFlow;
    }

    if (detectionResult.questionType && intentResult.confidence > 0.7) {
      const targetFlow = detectionResult.questionType === 'informational' ? 'management' : 'qa';
      console.log(`[FlowRouter] ✅ High-confidence ${detectionResult.questionType} question → ${targetFlow}`);
      return targetFlow;
    }
    
    // Special cases: High-confidence intents that can override onboarding
    if (intentResult.intent === 'qa' && intentResult.confidence >= 0.9 && !this.shouldStayInOnboarding(userState)) {
      console.log(`[FlowRouter] ✅ High-confidence QA override → qa`);
      return 'qa';
    }
    
    if (intentResult.intent === 'management' && intentResult.confidence >= 0.9) {
      console.log(`[FlowRouter] ✅ High-confidence management override → management`);
      return 'management';
    }
    
    // Priority 3.5: Non-onboarding questions should go to QA (before forcing to onboarding)
    if ((detectionResult.actionType === 'inquiry' || detectionResult.actionType === 'other') && 
        !detectionResult.isOnboardingRelated) {
      console.log(`[FlowRouter] ✅ Non-onboarding ${detectionResult.actionType} → qa`);
      return 'qa';
    }
    
    // Priority 4: Onboarding for new/incomplete users
    if (this.shouldStayInOnboarding(userState)) {
      // Special case: Users with groups wanting to launch coins
      if (userState.groups.length > 0 && intentResult.intent === 'coin_launch' && intentResult.confidence >= 0.8) {
        console.log(`[FlowRouter] ✅ Onboarding user with groups + coin launch intent → coin_launch`);
        return 'coin_launch';
      }
      
      console.log(`[FlowRouter] ✅ User needs onboarding → onboarding`);
      return 'onboarding';
    }
    
    // Priority 5: Active flow continuation
    const activeFlow = this.getActiveFlow(userState);
    if (activeFlow) {
      const shouldContinue = await this.shouldContinueActiveFlow(context, activeFlow, detectionResult);
      if (shouldContinue) {
        console.log(`[FlowRouter] ✅ Continuing active ${activeFlow} flow`);
        return activeFlow;
      } else {
        console.log(`[FlowRouter] 🧹 Clearing ${activeFlow} progress, routing fresh`);
        await this.clearActiveFlowProgress(context, activeFlow);
      }
    }
    
    // Priority 6: Fresh intent routing
    const targetFlow = this.intentToFlowType(intentResult.intent, userState);
    console.log(`[FlowRouter] ✅ Fresh intent routing: ${intentResult.intent} → ${targetFlow}`);
    
    return targetFlow;
  }

  // =============================================================================
  // UNIFIED DETECTION SYSTEM - SINGLE API CALL FOR ALL ROUTING DECISIONS
  // =============================================================================
  
  private async performUnifiedDetection(context: FlowContext, messageText: string): Promise<UnifiedRoutingResult> {
    if (!messageText) {
      return this.getEmptyDetectionResult();
    }

    const { userState } = context;
    
    // Build context for the unified detection
    const userContext = this.buildUserContextForDetection(userState);
    const conversationContext = this.buildConversationContextForDetection(context);
    
    // Debug logging to see what context is being passed
    console.log("🔍 CONVERSATION CONTEXT DEBUG", {
      messageText,
      historyLength: context.conversationHistory?.length || 0,
      conversationContext: conversationContext.substring(0, 200) + "..."
    });
    
    const prompt = `
You are analyzing a user message for routing decisions in a crypto token launch bot conversation.

USER CONTEXT:
${userContext}

RECENT CONVERSATION:
${conversationContext}

CURRENT USER MESSAGE: "${messageText}"

CRITICAL INSTRUCTIONS:
1. ALWAYS consider the recent conversation context when analyzing the current message
2. If the current message is a clarification, correction, or follow-up to a previous exchange, interpret it in that context
3. Don't treat messages in isolation - use conversation flow to understand intent
4. Return your response in this exact format:

\`\`\`json
{...your JSON response here...}
\`\`\`

Analyze this message IN CONTEXT and return a JSON object with boolean flags for all possible routing scenarios:

{
  "isGreeting": boolean,
  "isTransactionInquiry": boolean,
  "isCancellation": boolean,
  "questionType": "capability" | "informational" | null,
  "isGroupForEveryone": boolean,
  "isAddEveryone": boolean,
  "isNewGroupCreation": boolean,
  "isGroupCreationResponse": boolean,
  "isAddToExistingGroup": boolean,
  "isCompleteGroupReplacement": boolean,
  "isOnboardingRelated": boolean,
  "isOnboardingQuestion": boolean,
  "isExistingReceiversInquiry": boolean,
  "isFeeSplitModification": boolean,
  "isPercentageUpdate": boolean,
  "isContinuingCoinLaunch": boolean,
  "isMultipleCoinRequest": boolean,
  "actionType": "create_group" | "launch_coin" | "modify_existing" | "inquiry" | "greeting" | "other",
  "confidence": 0.1-1.0,
  "reasoning": "brief explanation of the primary classification"
}

DETECTION RULES:

=== GREETINGS ===
isGreeting: true for simple greetings like "hi", "hello", "hey", "what's up", "good morning", bot mentions like "hey @flaunchy"

=== TRANSACTION RELATED ===
isTransactionInquiry: true if asking about pending transaction details, status, modifications
isCancellation: true for "cancel", "stop", "abort", "nevermind"

=== QUESTIONS ===
IMPORTANT: Consider conversation context when classifying questions!
questionType: 
- "capability" for "can I...", "do you support...", "is it possible...", "how do you make money?" 
- "informational" for "show my groups", "who are fee receivers", "what groups do I have"
- null for non-questions

CLARIFICATIONS & FOLLOW-UPS (CRITICAL - LOOK FOR THESE PATTERNS):
- If user says "Not me - you!" after asking "How do you make money?" → they are asking how the AGENT makes money → capability question with HIGH confidence (0.9+)
- "I meant..." or "Actually..." = continuation of previous intent  
- "You, not me" or similar = clarification/correction of previous question
- Short responses like "yes", "no", "ok" in response to agent questions = continuation

SPECIFIC EXAMPLE TO RECOGNIZE:
USER: "How do you make money?"
AGENT: [explains how users make money]
USER: "Not me - you!" 
→ This is clearly asking how the AGENT makes money → actionType: "inquiry", questionType: "capability", confidence: 0.9+

=== GROUP ACTIONS ===
isGroupForEveryone: true for "create group for everyone", "launch group for everyone", "add everyone", "group for everyone", "start group for everyone"
isAddEveryone: true for requests to include all chat members
isNewGroupCreation: true for "create another group", "new group", "additional group"
isGroupCreationResponse: true if providing group creation details during onboarding (usernames, addresses, percentages)
isAddToExistingGroup: true for "add @user", "include @person and @user" (small additions)
isCompleteGroupReplacement: true for messages specifying complete new group with multiple users and equal split

=== ONBOARDING ===
isOnboardingRelated: true if this relates to ongoing onboarding process
isOnboardingQuestion: true for questions about fee receivers, group creation process during onboarding
isExistingReceiversInquiry: true for "who are current receivers?", "show current group"

=== MODIFICATIONS ===
isFeeSplitModification: true for "change fee split", "modify fee distribution"
isPercentageUpdate: true for "give user X%", "set user to X%"

=== COIN LAUNCH ===
isContinuingCoinLaunch: true if continuing an active coin launch process
isMultipleCoinRequest: true for "launch multiple coins", "create several tokens"

=== ACTION TYPE ===
Classify the primary action (CONSIDER CONVERSATION CONTEXT):
- "create_group": Creating new groups
- "launch_coin": Launching tokens/coins
- "modify_existing": Modifying existing groups/coins
- "inquiry": Asking questions/requesting information (including clarifications and follow-ups)
- "greeting": Simple greetings
- "other": Everything else

CONTEXT-AWARE CLASSIFICATION (CRITICAL PATTERNS):
- PRIORITY: "Not me - you!" after "How do you make money?" → "inquiry" + "capability" + confidence 0.9+
- If current message is a clarification/correction of previous question → "inquiry"  
- If current message continues previous conversation thread → inherit intent from context
- "You, not me" or similar clarifications → "inquiry" with high confidence
- Short confirmations in response to agent → continuation of previous flow

DEBUGGING CHECK:
- Before classifying as "other", ask: "Is this a clarification of the previous message?"
- If user is correcting/clarifying who they're asking about → "inquiry" not "other"

IMPORTANT: Set confidence based on how clear the intent is (0.1-1.0). 
Use HIGH confidence (0.8+) for context-supported interpretations.
`;

    try {
      const response = await context.openai.chat.completions.create({
        model: 'gpt-4o-mini',
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.3, // Increased from 0.1 to allow better context interpretation
        max_tokens: 500
      });

      const content = response.choices[0]?.message?.content;
      if (!content) {
        return this.getEmptyDetectionResult();
      }

      const result = safeParseJSON<UnifiedRoutingResult>(content);
      
      // Validate and sanitize the result
      return this.validateDetectionResult(result);
      
    } catch (error) {
      console.error('[FlowRouter] Failed to perform unified detection:', error);
      return this.getEmptyDetectionResult();
    }
  }

  private buildUserContextForDetection(userState: UserState): string {
    const pendingTxInfo = userState.pendingTransaction ? 
      `Pending ${userState.pendingTransaction.type} transaction` : 'No pending transaction';
    
    return `
- Status: ${userState.status}
- Groups: ${userState.groups.length}
- Coins: ${userState.coins.length}
- Onboarding Progress: ${userState.onboardingProgress ? 'Yes' : 'No'}
- Management Progress: ${userState.managementProgress ? 'Yes' : 'No'}
- Coin Launch Progress: ${userState.coinLaunchProgress ? 'Yes' : 'No'}
- ${pendingTxInfo}
`;
  }

  private buildConversationContextForDetection(context: FlowContext): string {
    // Get the last few messages for context (excluding the current message)
    const recentMessages = context.conversationHistory?.slice(0, 6) || [];
    
    if (recentMessages.length === 0) {
      return "No recent conversation history.";
    }

    const agentInboxId = context.client.inboxId;
    const conversationLines = recentMessages.map((msg, index) => {
      const isAgent = msg.senderInboxId === agentInboxId;
      const sender = isAgent ? "AGENT" : "USER";
      const content = this.extractMessageTextForContext(msg);
      const timestamp = new Date(msg.sentAt).toLocaleTimeString();
      
      return `${sender} (${timestamp}): ${content}`;
    }).reverse(); // Reverse to show chronological order (oldest to newest)

    return conversationLines.join('\n');
  }

  private extractMessageTextForContext(message: any): string {
    // Extract text content from message for context
    if (typeof message.content === 'string') {
      return message.content.substring(0, 100); // Limit length
    }
    
    // Handle reply messages
    if (message.content?.content && typeof message.content.content === 'string') {
      return message.content.content.substring(0, 100);
    }
    
    return '[NON-TEXT]';
  }

  private getEmptyDetectionResult(): UnifiedRoutingResult {
    return {
      isGreeting: false,
      isTransactionInquiry: false,
      isCancellation: false,
      questionType: null,
      isGroupForEveryone: false,
      isAddEveryone: false,
      isNewGroupCreation: false,
      isGroupCreationResponse: false,
      isAddToExistingGroup: false,
      isCompleteGroupReplacement: false,
      isOnboardingRelated: false,
      isOnboardingQuestion: false,
      isExistingReceiversInquiry: false,
      isFeeSplitModification: false,
      isPercentageUpdate: false,
      isContinuingCoinLaunch: false,
      isMultipleCoinRequest: false,
      actionType: 'other',
      confidence: 0.5,
      reasoning: 'Empty or failed detection'
    };
  }

  private validateDetectionResult(result: any): UnifiedRoutingResult {
    // Ensure all required fields exist with proper types
    const validated: UnifiedRoutingResult = {
      isGreeting: Boolean(result.isGreeting),
      isTransactionInquiry: Boolean(result.isTransactionInquiry),
      isCancellation: Boolean(result.isCancellation),
      questionType: ['capability', 'informational'].includes(result.questionType) ? result.questionType : null,
      isGroupForEveryone: Boolean(result.isGroupForEveryone),
      isAddEveryone: Boolean(result.isAddEveryone),
      isNewGroupCreation: Boolean(result.isNewGroupCreation),
      isGroupCreationResponse: Boolean(result.isGroupCreationResponse),
      isAddToExistingGroup: Boolean(result.isAddToExistingGroup),
      isCompleteGroupReplacement: Boolean(result.isCompleteGroupReplacement),
      isOnboardingRelated: Boolean(result.isOnboardingRelated),
      isOnboardingQuestion: Boolean(result.isOnboardingQuestion),
      isExistingReceiversInquiry: Boolean(result.isExistingReceiversInquiry),
      isFeeSplitModification: Boolean(result.isFeeSplitModification),
      isPercentageUpdate: Boolean(result.isPercentageUpdate),
      isContinuingCoinLaunch: Boolean(result.isContinuingCoinLaunch),
      isMultipleCoinRequest: Boolean(result.isMultipleCoinRequest),
      actionType: ['create_group', 'launch_coin', 'modify_existing', 'inquiry', 'greeting', 'other'].includes(result.actionType) 
        ? result.actionType : 'other',
      confidence: Math.max(0.1, Math.min(1.0, Number(result.confidence) || 0.5)),
      reasoning: String(result.reasoning || 'No reasoning provided')
    };

    return validated;
  }

  // =============================================================================
  // HELPER METHODS FOR CLEAN PRIORITY LOGIC
  // =============================================================================

  private getFlowForPendingTransaction(userState: UserState): FlowType {
    const txType = userState.pendingTransaction!.type;
    
    if (txType === 'group_creation') {
      // Group creation transaction - route based on who created it
      if (userState.onboardingProgress && userState.status === 'onboarding') {
        return 'onboarding';
      } else {
        return 'management';
      }
    } else if (txType === 'coin_creation') {
      // Coin creation transaction - route based on who created it
      if (userState.coinLaunchProgress) {
        return 'coin_launch';
      } else if (userState.onboardingProgress && userState.status === 'onboarding') {
        return 'onboarding';
      } else {
        return 'management';
      }
    }
    
    // Fallback
    return 'management';
  }

  private shouldStayInOnboarding(userState: UserState): boolean {
    // If user is marked as active, they've completed onboarding - don't route to onboarding
    if (userState.status === 'active') {
      return false;
    }
    
    // Invited users get a special welcome message, but don't need full onboarding
    // They already have groups/coins from being added to groups
    if (userState.status === 'invited') {
      return false;
    }
    
    // User needs onboarding if they don't have both groups AND coins
    const hasGroupsAndCoins = userState.groups.length > 0 && userState.coins.length > 0;
    
    // Stay in onboarding if:
    // 1. User is marked as new/onboarding AND
    // 2. User doesn't have both groups and coins
    return (userState.status === 'new' || userState.status === 'onboarding') && 
           !hasGroupsAndCoins;
  }

  private getActiveFlow(userState: UserState): FlowType | null {
    // Check for active progress in order of priority
    if (userState.managementProgress) {
      // If management progress is for group creation and user has existing groups,
      // route to group_launch flow instead of management
      if (userState.managementProgress.action === 'creating_group' && userState.groups.length > 0) {
        return 'group_launch';
      }
      return 'management';
    }
    if (userState.coinLaunchProgress) return 'coin_launch';
    
    return null;
  }

  private async shouldContinueActiveFlow(context: FlowContext, activeFlow: FlowType, detectionResult: UnifiedRoutingResult): Promise<boolean> {
    const { messageText } = context;
    
    switch (activeFlow) {
      case 'management':
        // For management flow, assume continuation unless it's clearly a different intent
        // Management flow handles many different actions, so it's flexible
        return true;
        
      case 'group_launch':
        // For group launch, assume continuation (similar to management)
        // Group launch flow handles the group creation process
        return true;
        
      case 'coin_launch':
        // For coin launch, check if user wants to continue with the coin launch
        return await this.isContinuingCoinLaunch(context, messageText, detectionResult);
        
      default:
        return true;
    }
  }

  private async clearActiveFlowProgress(context: FlowContext, activeFlow: FlowType): Promise<void> {
    switch (activeFlow) {
      case 'management':
        await context.updateState({ managementProgress: undefined });
        break;
      case 'group_launch':
        await context.updateState({ managementProgress: undefined });
        break;
      case 'coin_launch':
        await context.updateState({ coinLaunchProgress: undefined });
        break;
    }
  }









  private intentToFlowType(intent: MessageIntent, userState?: UserState): FlowType {
    switch (intent) {
      case 'onboarding':
        return 'onboarding';
      case 'coin_launch':
        return 'coin_launch';
      case 'group_launch':
        return 'group_launch';
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



  private async handleCompletedUserGreeting(context: FlowContext): Promise<void> {
    const { userState } = context;
    
    // Build suggestions based on what the user can do
    let suggestions = [];
    
    if (userState.groups.length > 0) {
      suggestions.push("launch coins into your groups");
      suggestions.push("create additional groups");
      suggestions.push("check your group stats");
    }
    
    if (userState.coins.length > 0) {
      suggestions.push("view your portfolio");
      suggestions.push("check trading activity");
    }
    
    // Always offer general help
    suggestions.push("ask questions about how everything works");
    
    const suggestionText = suggestions.length > 0 ? 
      ` here's what you can do:\n• ${suggestions.join('\n• ')}` : 
      ` ask me anything about groups and coin launches!`;

    const response = `hey there!${suggestionText}`;
    
    await context.sendResponse(response);
  }

  // Helper method to register or update flows
  updateFlow(flowType: FlowType, flow: BaseFlow): void {
    this.flows[flowType] = flow;
  }

  // Get current flow for a user (useful for debugging)
  async getCurrentFlowType(userState: UserState, message: string, hasAttachment: boolean = false): Promise<FlowType> {
    const intentResult = await this.intentClassifier.classifyIntent(message, userState, hasAttachment);
    return this.intentToFlowType(intentResult.intent, userState);
  }

  private async isContinuingCoinLaunch(context: FlowContext, messageText: string, detectionResult: UnifiedRoutingResult): Promise<boolean> {
    // Use unified detection result instead of separate API call
    return detectionResult.isContinuingCoinLaunch;
  }


} 