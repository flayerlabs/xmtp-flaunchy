import { UserState } from "../types/UserState";
import { FlowContext } from "../types/FlowContext";
import { BaseFlow } from "./BaseFlow";
import { IntentClassifier, MessageIntent } from "./IntentClassifier";
import OpenAI from "openai";

export type FlowType = 'onboarding' | 'qa' | 'management' | 'coin_launch' | 'group_launch';

export interface FlowRegistry {
  onboarding: BaseFlow;
  qa: BaseFlow;
  management: BaseFlow;
  coin_launch: BaseFlow;
  group_launch: BaseFlow;
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
    
    console.log(`[FlowRouter] 🎯 ROUTING DECISION for: "${messageText}"`);
    console.log(`[FlowRouter] 📊 User State: status=${userState.status}, groups=${userState.groups.length}, onboarding=${!!userState.onboardingProgress}, management=${!!userState.managementProgress}, coinLaunch=${!!userState.coinLaunchProgress}, pendingTx=${!!userState.pendingTransaction}`);
    
    // Get intent classification upfront (we'll need it for multiple decisions)
    const intentResult = await this.intentClassifier.classifyIntent(messageText, userState, context.hasAttachment);
    console.log(`[FlowRouter] 🧠 Intent: ${intentResult.intent} (confidence: ${intentResult.confidence.toFixed(2)}) - ${intentResult.reasoning}`);
    
    // =============================================================================
    // PRIORITY 1: PENDING TRANSACTION HANDLING
    // If user has a pending transaction, they need to deal with it first
    // =============================================================================
    if (userState.pendingTransaction) {
      console.log(`[FlowRouter] 🔄 PRIORITY 1: Handling pending ${userState.pendingTransaction.type} transaction`);
      
      const isAboutTransaction = await this.isTransactionInquiry(context, messageText);
      if (isAboutTransaction) {
        const targetFlow = this.getFlowForPendingTransaction(userState);
        console.log(`[FlowRouter] ✅ P1 RESULT: Message about pending transaction → ${targetFlow}`);
        return targetFlow;
      } else {
        console.log(`[FlowRouter] ⏭️ P1 SKIP: Message not about pending transaction, continuing to next priority`);
      }
    }
    
    // =============================================================================
    // PRIORITY 2: QUESTIONS & INQUIRIES (ALWAYS OVERRIDE PROGRESS)
    // Users should always be able to ask questions regardless of their current flow
    // =============================================================================
    console.log(`[FlowRouter] ❓ PRIORITY 2: Checking for questions and inquiries`);
    
    const questionType = await this.detectQuestionType(context, messageText);
    if (questionType && intentResult.confidence > 0.7) {
      const targetFlow = questionType === 'informational' ? 'management' : 'qa';
      console.log(`[FlowRouter] ✅ P2 RESULT: ${questionType} question detected → ${targetFlow}`);
      return targetFlow;
    } else {
      console.log(`[FlowRouter] ⏭️ P2 SKIP: Not a high-confidence question (questionType=${questionType}, confidence=${intentResult.confidence.toFixed(2)})`);
    }
    
    // SPECIAL CASE: Management intent with high confidence should override onboarding
    // for informational queries about existing data
    if (intentResult.intent === 'management' && intentResult.confidence >= 0.9) {
      console.log(`[FlowRouter] 🎯 SPECIAL: High-confidence management intent overrides onboarding → management`);
      return 'management';
    }
    
    // =============================================================================
    // PRIORITY 3: ONBOARDING (ONLY FOR NEW/INCOMPLETE USERS)
    // New users or users with incomplete onboarding must complete it first
    // =============================================================================
    if (this.shouldStayInOnboarding(userState)) {
      console.log(`[FlowRouter] 🎓 PRIORITY 3: User needs onboarding`);
      
      // Check if this is an onboarding-related interaction
      const isOnboardingRelated = await this.isOnboardingRelatedInteraction(context, messageText);
      if (isOnboardingRelated) {
        console.log(`[FlowRouter] ✅ P3 RESULT: Onboarding-related interaction → onboarding`);
        return 'onboarding';
      } else {
        // Users who need onboarding should ALWAYS go to onboarding
        // The onboarding flow can handle any type of message and guide them appropriately
        console.log(`[FlowRouter] ✅ P3 RESULT: User needs onboarding → onboarding`);
        return 'onboarding';
      }
    } else {
      console.log(`[FlowRouter] ⏭️ P3 SKIP: User doesn't need onboarding (status=${userState.status}, hasProgress=${!!userState.onboardingProgress})`);
    }
    
    // =============================================================================
    // PRIORITY 4: ACTIVE FLOW CONTINUATION
    // If user has active progress, check if they want to continue or start fresh
    // =============================================================================
    const activeFlow = this.getActiveFlow(userState);
    if (activeFlow) {
      console.log(`[FlowRouter] 🔄 PRIORITY 4: User has active ${activeFlow} progress`);
      
      const shouldContinue = await this.shouldContinueActiveFlow(context, activeFlow);
      if (shouldContinue) {
        console.log(`[FlowRouter] ✅ P4 RESULT: Continuing active flow → ${activeFlow}`);
        return activeFlow;
      } else {
        // User wants to do something different - clear the active progress
        console.log(`[FlowRouter] 🧹 P4 CLEAR: User wants to do something different, clearing ${activeFlow} progress`);
        await this.clearActiveFlowProgress(context, activeFlow);
        console.log(`[FlowRouter] ⏭️ P4 CONTINUE: Proceeding to fresh intent routing`);
      }
    } else {
      console.log(`[FlowRouter] ⏭️ P4 SKIP: No active flow progress`);
    }
    
    // =============================================================================
    // PRIORITY 5: FRESH INTENT ROUTING
    // Route based on classified intent for users with no active progress
    // =============================================================================
    console.log(`[FlowRouter] 🎯 PRIORITY 5: Fresh intent routing`);
    const targetFlow = this.intentToFlowType(intentResult.intent, userState);
    console.log(`[FlowRouter] ✅ P5 RESULT: Intent-based routing → ${targetFlow}`);
    
    return targetFlow;
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
    // User needs onboarding if they don't have both groups AND coins
    const hasGroupsAndCoins = userState.groups.length > 0 && userState.coins.length > 0;
    
    // Stay in onboarding if:
    // 1. User is marked as new/onboarding, OR
    // 2. User doesn't have both groups and coins (regardless of status)
    return (userState.status === 'new' || userState.status === 'onboarding') || 
           !hasGroupsAndCoins;
  }

  private async isOnboardingRelatedInteraction(context: FlowContext, messageText: string): Promise<boolean> {
    // Check if this is an onboarding-related question
    const isOnboardingQuestion = await this.isOnboardingRelatedQuestion(context, messageText);
    if (isOnboardingQuestion) return true;
    
    // Check if this is a group creation response during onboarding
    const isGroupCreationResponse = await this.isGroupCreationResponseDuringOnboarding(context, messageText);
    if (isGroupCreationResponse) return true;
    
    return false;
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

  private async shouldContinueActiveFlow(context: FlowContext, activeFlow: FlowType): Promise<boolean> {
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
        return await this.isContinuingCoinLaunch(context, messageText);
        
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

  private async isTransactionInquiry(context: FlowContext, messageText: string): Promise<boolean> {
    const { openai, userState } = context;
    
    const transactionType = userState.pendingTransaction?.type === 'coin_creation' ? 'coin creation' : 'group creation';
    
    const prompt = `
      User has a pending ${transactionType} transaction and said: "${messageText}"
      
      Is this user interacting with their pending ${transactionType} transaction, or are they starting something completely new?
      
      ABOUT PENDING TRANSACTION (return "yes"):
      - Questions about transaction details: "who are the receivers?", "what addresses?", "show transaction"
      - Modification requests for current transaction: "add @alice to this", "change the percentage"
      - Cancellation of current transaction: "cancel", "stop", "abort", "nevermind"
      - Status inquiries about current transaction: "what's the status?", "is it ready?"
      - Questions about what they're creating: "who's in the group?", "what coin am I creating?"
      
      COMPLETELY NEW REQUEST (return "no"):
      - Starting a different type of creation: "create a group" (when pending is coin), "launch a coin" (when pending is group)
      - Clear new action requests: "let's start a new group", "I want to create a different group"
      - Different scope: "launch a group for everyone" vs pending individual coin
      - Explicit new beginnings: "actually, let's create a group instead"
      - Unrelated actions: "show my existing groups", "list my coins"
      
      Message: "${messageText}"
      
      Return ONLY:
      "yes" - if they're interacting with the pending ${transactionType} transaction
      "no" - if they're starting something completely new and unrelated
    `;

    const response = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.1,
      max_tokens: 10
    });

    return response.choices[0]?.message?.content?.trim()?.toLowerCase() === 'yes';
  }

  private async detectQuestionType(context: FlowContext, messageText: string): Promise<'capability' | 'informational' | null> {
    const { openai } = context;
    
    const prompt = `
      User said: "${messageText}"
      
      Classify this message into one of these categories:
      
      CAPABILITY QUESTIONS (return "capability"):
      - Questions about what's possible: "can I...", "do you support...", "is it possible..."
      - Questions about features: "what features...", "what can you do...", "what about..."
      - Questions about limitations: "can I switch chains?", "do you support sepolia?"
      - Questions about configuration options: "can I create a group with different fee splits?"
      - Hypothetical scenarios: "what if...", "is it possible to..."
      
      INFORMATIONAL QUERIES (return "informational"):
      - Requests to see existing data: "show my groups", "list my coins", "what groups do I have?"
      - Status inquiries: "who are the fee receivers?", "what's my group?", "show fee receivers"
      - Portfolio/balance requests: "my groups", "my coins", "show my portfolio"
      - Data listing: "list groups", "list coins", "show groups", "show coins"
      - Questions asking about current state: "what do I have?", "show me my...", "what are my..."
      - Possessive questions: "what groups do I have?", "what coins do I own?", "my groups?"
      
      ACTION REQUESTS (return "none"):
      - Commands to perform actions: "let's start a new group", "create a group", "launch a coin"
      - Imperative statements: "start a group for everyone", "create a group with alice"
      - Action declarations: "I want to create a group", "let's launch this"
      
      FLOW CONTINUATION (return "none"):
      - Providing requested data: "@alice", "alice.eth", "0x123...", "MyCoin (MCN)"
      - Confirming actions: "yes", "ok", "do it", "go ahead"
      - Responding to specific prompts: directly answering what the bot just asked for
      - Making selections: choosing from options the bot provided
      
      IMPORTANT: Questions like "what groups do I have?" are clearly INFORMATIONAL - they ask about existing data.
      
      Return ONLY:
      "capability" - if this is a capability question
      "informational" - if this is requesting existing data
      "none" - if this is an action request or flow continuation
    `;

    const response = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.1,
      max_tokens: 15
    });

    const result = response.choices[0]?.message?.content?.trim()?.toLowerCase();
    
    if (result === 'capability') return 'capability';
    if (result === 'informational') return 'informational';
    return null;
  }

  private async isGroupCreationResponseDuringOnboarding(context: FlowContext, messageText: string): Promise<boolean> {
    const { openai } = context;
    
    const prompt = `
      User is in onboarding flow and was asked about fee receivers for group creation.
      User said: "${messageText}"
      
      Is this user providing group creation details or responding to the group creation question? Look for:
      - "create a group for everyone"
      - "add everyone"
      - "let's create a group for everyone"
      - "awesome let's create a group for everyone"
      - Fee receiver specifications (@alice, alice.eth, 0x123...)
      - Percentage specifications ("me 80%, @alice 20%")
      - Group member references ("everyone in this chat")
      - Responses that indicate they want to proceed with group creation
      
      Return ONLY:
      "yes" - if they're providing group creation details/responses during onboarding
      "no" - if they're asking about something completely different
    `;

    const response = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.1,
      max_tokens: 10
    });

    return response.choices[0]?.message?.content?.trim()?.toLowerCase() === 'yes';
  }

  private async isOnboardingRelatedQuestion(context: FlowContext, messageText: string): Promise<boolean> {
    const { openai } = context;
    
    const prompt = `
      User is in onboarding and said: "${messageText}"
      
      Is this an onboarding-related question that should be answered within the onboarding flow?
      
      ONBOARDING-RELATED QUESTIONS (return "yes"):
      - Questions about fee receivers: "who are the fee receivers?", "what are fee receivers?", "who should receive?"
      - Questions about fee splitting: "how do fee receivers work?", "who gets the fees?", "how does fee splitting work?"
      - Questions about groups: "what is a group?", "how do groups work?", "what is group creation?"
      - Process questions: "how does this work?", "what do I need?", "what should I provide?"
      - Format questions: "how do I specify?", "what format?", "can you explain?"
      - Clarification: "I don't understand", "what does this mean?"
      - Transaction inquiries: "what addresses are in?", "who is in the group?", "who are the receivers?"
      - Transaction details: "what percentage?", "how much does each?", "what are the splits?"
      - Transaction status: "show me the transaction", "what's in the transaction?", "transaction details"
      
      OTHER QUESTIONS (return "no"):
      - Questions about existing data: "what groups do I have?", "show my groups"
      - Capability questions: "can I create groups?", "do you support?"
      - Action requests: "create a group", "start a group"
      - General questions: "what can you do?", "how does Flaunch work?"
      
      Return ONLY:
      "yes" - if this is an onboarding-related question
      "no" - if this is about something else
    `;

    const response = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.1,
      max_tokens: 10
    });

    return response.choices[0]?.message?.content?.trim()?.toLowerCase() === 'yes';
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

  // Helper method to register or update flows
  updateFlow(flowType: FlowType, flow: BaseFlow): void {
    this.flows[flowType] = flow;
  }

  // Get current flow for a user (useful for debugging)
  async getCurrentFlowType(userState: UserState, message: string, hasAttachment: boolean = false): Promise<FlowType> {
    const intentResult = await this.intentClassifier.classifyIntent(message, userState, hasAttachment);
    return this.intentToFlowType(intentResult.intent, userState);
  }

  private async isContinuingCoinLaunch(context: FlowContext, messageText: string): Promise<boolean> {
    const { openai, userState } = context;
    
    // Get recent conversation context to understand if user is responding to a request
    const progress = userState.coinLaunchProgress;
    let contextInfo = "";
    
    if (progress) {
      const coinData = progress.coinData || {};
      const missing = [];
      
      if (!coinData.name) missing.push('coin name');
      if (!coinData.ticker) missing.push('ticker');
      if (!coinData.image) missing.push('image');
      if (!progress.targetGroupId) missing.push('target group');
      
      if (missing.length > 0) {
        contextInfo = `\n\nIMPORTANT CONTEXT: User has ongoing coin launch progress missing: ${missing.join(', ')}. The agent likely recently asked for this missing information.`;
      }
    }
    
    const prompt = `
      User has an ongoing coin launch in progress and said: "${messageText}"${contextInfo}
      
      Is this message about continuing/progressing their existing coin launch? Look for:
      
      COIN LAUNCH CONTINUATION (return "yes"):
      - Status inquiries: "where are we at with the coin launch?", "what's the status?", "what do we still need?"
      - Launch commands: "launch", "launch it", "go ahead", "proceed", "launch now"
      - Providing missing data: coin names, tickers, images, group selections
      - Contract addresses (0x...) when target group is missing
      - Image URLs or attachments when image is missing
      - Token names/tickers when those are missing
      - Launch options questions: "what launch options do I have?", "what can I configure?"
      - Launch defaults questions: "what are the defaults?", "what are default settings?"
      - Future feature questions about launches: "can I do airdrops?", "what about whitelists?"
      - Launch parameter adjustments: market cap, duration, prebuy, buybacks
      
      DIFFERENT INTENT (return "no"):
      - Group creation: "create a group", "start a new group", "launch a group", "launch a group and add everyone"
      - Group management: "what groups do I have?", "list my groups", "show groups"
      - General greetings: "hey flaunchy!", "hello", "hi"
      - General questions: "how does this work?", "what can you do?"
      - Management tasks: "show my coins", "check balances"
      - Completely unrelated topics
      
      SPECIAL CASE: If the user message looks like it could be providing missing data (especially contract addresses, token names, or image URLs), strongly consider it as coin launch continuation.
      
      Return ONLY:
      "yes" - if continuing the coin launch
      "no" - if asking about something different
    `;

    const response = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.1,
      max_tokens: 10
    });

    return response.choices[0]?.message?.content?.trim()?.toLowerCase() === 'yes';
  }
} 