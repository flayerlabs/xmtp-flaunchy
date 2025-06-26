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
        
        // Determine which flow created the pending transaction based on active progress
        if (userState.managementProgress) {
          console.log(`[FlowRouter] Pending transaction from management flow - staying in management`);
          return 'management';
        } else if (userState.onboardingProgress) {
          console.log(`[FlowRouter] Pending transaction from onboarding flow - staying in onboarding`);
          return 'onboarding';
        } else if (userState.coinLaunchProgress) {
          console.log(`[FlowRouter] Pending transaction from coin launch flow - staying in coin_launch`);
          return 'coin_launch';
        } else {
          // Fallback to status-based routing if no active progress
          if (userState.status === 'onboarding' || userState.status === 'new') {
            return 'onboarding';
          } else {
            return 'management';
          }
        }
      }
    }
    
    // PRIORITY 2: If user has ongoing management progress, keep them in management
    if (userState.managementProgress) {
      console.log(`[FlowRouter] User has ongoing management progress (${userState.managementProgress.action}, step: ${userState.managementProgress.step}) - keeping in management`);
      return 'management';
    }
    
    // PRIORITY 3: Check for explicit flow change requests before checking ongoing progress
    const intentResult = await this.intentClassifier.classifyIntent(messageText, userState, context.hasAttachment);
    const flowType = this.intentToFlowType(intentResult.intent, userState);
    
    console.log(`[FlowRouter] Intent: ${intentResult.intent} (confidence: ${intentResult.confidence.toFixed(2)}) - ${intentResult.reasoning}`);
    
    // If user explicitly wants to do something different with high confidence, respect that
    if (intentResult.confidence > 0.8 && intentResult.intent !== 'coin_launch') {
      // Check if they're explicitly requesting group creation while in coin launch
      if (userState.coinLaunchProgress && (intentResult.intent === 'management' || intentResult.intent === 'onboarding')) {
        const isGroupCreationRequest = await this.isExplicitGroupCreationRequest(context, messageText);
        if (isGroupCreationRequest) {
          console.log(`[FlowRouter] User explicitly wants to create a group while in coin_launch - switching to ${flowType}`);
          // Clear coin launch progress since they want to do something else
          await context.updateState({
            coinLaunchProgress: undefined
          });
          return flowType;
        }
      }
    }
    
    // PRIORITY 4: If user has ongoing coin launch progress, check if message is about continuing it
    if (userState.coinLaunchProgress) {
      const isContinuingCoinLaunch = await this.isContinuingCoinLaunch(context, messageText);
      if (isContinuingCoinLaunch) {
        console.log(`[FlowRouter] User has ongoing coin launch progress (step: ${userState.coinLaunchProgress.step}) - keeping in coin_launch`);
        return 'coin_launch';
      } else {
        console.log(`[FlowRouter] User has coin launch progress but message is about different intent - routing to ${flowType}`);
        return flowType;
      }
    }
    
    // OVERRIDE: Only keep user in onboarding if they have active onboarding AND the intent is onboarding-related
    if ((userState.status === 'onboarding' || userState.status === 'new') && userState.onboardingProgress) {
      
      // Check if this is an onboarding-related question that should stay in onboarding
      const isOnboardingQuestion = this.isOnboardingRelatedQuestion(messageText);
      
      if (isOnboardingQuestion) {
        console.log(`[FlowRouter] User in onboarding asking onboarding-related question - keeping in onboarding`);
        return 'onboarding';
      }
      
      // Special case: If user is providing group creation details during onboarding, keep them in onboarding
      // This includes phrases like "create a group for everyone", "add everyone", etc.
      const isGroupCreationResponse = await this.isGroupCreationResponseDuringOnboarding(context, messageText);
      if (isGroupCreationResponse) {
        console.log(`[FlowRouter] User providing group creation details during onboarding - keeping in onboarding`);
        return 'onboarding';
      }
      
      // CRITICAL: Check if user is requesting chain change during onboarding group creation
      // Even if it looks like "coin_launch" intent, it might be "launch on base sepolia" meaning "create group on base sepolia"
      const isChainChangeForGroupCreation = await this.isChainChangeForGroupCreation(context, messageText);
      if (isChainChangeForGroupCreation) {
        console.log(`[FlowRouter] User requesting chain change for group creation during onboarding - keeping in onboarding`);
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
      
      Is this user interacting with their pending transaction? Look for:
      - Questions about transaction details (addresses, receivers, amounts, etc.)
      - Requests to see transaction info
      - Questions about who's included
      - Asking about the group/coin being created
      - Cancellation requests ("cancel", "stop", "abort", "nevermind")
      - Chain/network change requests ("on base sepolia", "switch to mainnet", "use sepolia", "launch on base sepolia actually")
      - Modification requests ("add @alice", "include everyone", "remove someone")
      
      Return ONLY:
      "yes" - if they're interacting with the pending transaction in any way
      "no" - if they're asking about something completely unrelated to the transaction
    `;

    const response = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.1,
      max_tokens: 10
    });

    return response.choices[0]?.message?.content?.trim()?.toLowerCase() === 'yes';
  }

  private async isExplicitGroupCreationRequest(context: FlowContext, messageText: string): Promise<boolean> {
    const { openai } = context;
    
    const prompt = `
      User said: "${messageText}"
      
      Is this user explicitly requesting to create a new group? Look for clear group creation signals like:
      - "start a new group"
      - "create a group"
      - "I want to start a group"
      - "start a group for everyone"
      - "create a new group for everyone"
      - "I actually want to start a new group"
      
      Return ONLY:
      "yes" - if they're explicitly requesting group creation
      "no" - if they're not requesting group creation
    `;

    const response = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.1,
      max_tokens: 10
    });

    return response.choices[0]?.message?.content?.trim()?.toLowerCase() === 'yes';
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
  async getCurrentFlowType(userState: UserState, message: string, hasAttachment: boolean = false): Promise<FlowType> {
    const intentResult = await this.intentClassifier.classifyIntent(message, userState, hasAttachment);
    return this.intentToFlowType(intentResult.intent, userState);
  }

  private async isChainChangeForGroupCreation(context: FlowContext, messageText: string): Promise<boolean> {
    const { openai } = context;
    
    const prompt = `
      User is in onboarding flow creating a group and said: "${messageText}"
      
      Is this user requesting to change the blockchain/chain for their group creation? 
      This might look like coin launch intent but is actually about chain selection for group creation.
      
      Look for patterns like:
      - "launch on base sepolia" (meaning create group on base sepolia)
      - "oh launch on base sepolia <3"
      - "create on sepolia"
      - "use base sepolia"
      - "switch to sepolia"
      - "change to base sepolia"
      - "on base sepolia"
      - "let's do sepolia"
      - Any mention of chain/network switching during group creation
      
      Context: User is currently in group creation onboarding, not coin launching.
      
      Return ONLY:
      "yes" - if they're requesting chain change for group creation
      "no" - if they're requesting actual coin launch or something else
    `;

    const response = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.1,
      max_tokens: 10
    });

    return response.choices[0]?.message?.content?.trim()?.toLowerCase() === 'yes';
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
      - Launch parameter adjustments: market cap, duration, premine, buybacks
      
      DIFFERENT INTENT (return "no"):
      - Group management: "what groups do I have?", "list my groups", "show groups"
      - General greetings: "hey flaunchy!", "hello", "hi"
      - New group creation: "create a group", "start a new group"
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