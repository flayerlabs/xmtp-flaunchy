import OpenAI from "openai";
import { UserState } from "../types/UserState";

export type MessageIntent = 
  | 'onboarding'      // First group creation, new user setup
  | 'coin_launch'     // Launch coin into existing group
  | 'group_launch'    // Create additional groups (for existing users)
  | 'management'      // Query/manage existing groups/coins
  | 'qa'              // General questions, help, conversation
  | 'confirmation';   // Confirming previous agent request

export interface IntentResult {
  intent: MessageIntent;
  confidence: number;
  reasoning: string;
}

export class IntentClassifier {
  constructor(private openai: OpenAI) {}

  async classifyIntent(message: string, userState: UserState, hasAttachment: boolean = false): Promise<IntentResult> {
    // Early detection for image-only coin launches (but not during onboarding)
    if (hasAttachment && userState.groups.length > 0 && (!message || message.trim().length < 20) && 
        userState.status !== 'onboarding' && !userState.onboardingProgress) {
      // User has groups and uploaded an image with minimal text - likely coin launch
      return {
        intent: 'coin_launch',
        confidence: 0.9,
        reasoning: 'Image attachment with minimal text detected - likely coin launch information'
      };
    }

    // First check if user has ongoing management progress
    if (userState.managementProgress && userState.managementProgress.action === 'creating_group') {
      return {
        intent: 'management',
        confidence: 0.95,
        reasoning: 'User has ongoing group creation progress - continuing with management flow'
      };
    }

    // Note: Removed explicit group creation pre-check to let LLM handle question vs action distinction

    const prompt = this.buildClassificationPrompt(message, userState, hasAttachment);
    
    try {
      const response = await this.openai.chat.completions.create({
        model: 'gpt-3.5-turbo', // Lightweight model for speed
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.1, // Low temperature for consistent classification
        max_tokens: 150,
      });

      const content = response.choices[0]?.message?.content?.trim();
      if (!content) {
        return this.getFallbackIntent(userState);
      }

      return this.parseIntentResponse(content, userState);
    } catch (error) {
      console.error('Intent classification failed:', error);
      return this.getFallbackIntent(userState);
    }
  }

  private buildClassificationPrompt(message: string, userState: UserState, hasAttachment: boolean = false): string {
    const userContext = this.buildUserContext(userState);
    
    return `
You are classifying user messages in an ongoing conversation with a crypto token launch bot.

USER CONTEXT:
${userContext}

USER MESSAGE: "${message}"${hasAttachment ? '\nHAS IMAGE ATTACHMENT: true' : ''}

CRITICAL CONTEXT RULES (READ CAREFULLY):

CONVERSATIONAL FLOW CONTINUATION (HIGHEST PRIORITY):
- If user is actively in a flow (onboarding/management progress exists), assume they are responding to the bot's request
- If bot just asked for fee receivers and user provides usernames/addresses → CONTINUE CURRENT FLOW
- If bot just asked for coin details and user provides name/ticker → CONTINUE CURRENT FLOW  
- If bot just asked for confirmation and user confirms → CONTINUE CURRENT FLOW

ONBOARDING CONTINUATION SIGNALS:
- User has onboardingProgress AND provides: usernames, addresses, ENS names, "me and X", fee split info → onboarding
- User has onboardingProgress AND provides coin details: coin names, tickers, images → onboarding (NOT coin_launch!)
- Examples: "split between me and alice", "me and @bob 50/50", "alice.eth and charlie.eth", "0x123... and 0x456..."
- Coin details examples: "Token TOKIE", "launch MyCoin (MCN)", "create DOGE with image.jpg" → onboarding if user is in onboarding

INFORMATIONAL QUERIES (HIGHEST PRIORITY):
- Questions about existing groups/coins: "who are fee receivers?", "show my groups", "what's my group?", "show fee receivers"
- These are ALWAYS management, even if user is in active onboarding/management flows
- Override any active flow when user asks for information about existing data

GROUP CREATION SIGNALS (HIGH PRIORITY):
- Explicit group creation requests: "launch a group", "create a group", "group for everyone", "add everyone"
- These should route to appropriate flow (onboarding for first group, management for additional groups)
- "Add everyone" requests should be detected regardless of current flow state

MANAGEMENT CONTINUATION SIGNALS:
- User has managementProgress AND continues that task → management

INTENT OPTIONS:
1. onboarding - User wants to create their FIRST group (when they have 0 groups) OR continue their current onboarding process
   Examples: "create a group", "launch a group", "set up a group", "launch a group for me and @alice", "launch a group for everyone here", "help me get started"
   CONTINUATION: If user is in onboarding and provides fee receivers, coin details, or continues the process → onboarding
   GROUP CREATION: If user mentions "group" + "everyone", this is group creation with "add everyone" functionality
   CRITICAL: If user has existing groups (Groups > 0), group creation is MANAGEMENT, not onboarding
   
2. coin_launch - User wants to launch a TOKEN/COIN into an existing group  
   Examples: "launch MyCoin (MCN)", "create new coin", "add coin to group", "launch DOGE into my group", "flaunch a token", "launch a token into group", "I want to launch a token into [group name]"
   CRITICAL TOKEN INDICATORS: "token", "coin", ticker symbols in parentheses like "(MCN)", "(DOGE)", specific coin names
   COIN SPECIFICATIONS: Token specifications with parameters: "Banana (BNAA) with $100 market cap and 0.77% premine", "MyCoin (MCN) $5000 market cap", "DOGE token with 10% prebuy", "create Token (TOK) with $1000 starting cap"
   IMAGE ONLY: If user uploads an image attachment with minimal/no text, this is coin launch information
   LAUNCH PARAMETERS: Messages containing market cap, premine/prebuy percentages, launch parameters
   CRITICAL: "launch a token" = coin_launch, "launch a group" = group creation
   
3. group_launch - User wants to create ADDITIONAL groups (when they already have groups)
   Examples: "start a new group", "create a group for everyone", "let's create another group", "launch a group", "launch a group and add everyone"
   CRITICAL: If user has Groups > 0, ALL group creation requests are group_launch, not onboarding
   
4. management - User wants to view/manage existing groups/coins (but NOT create new groups)
   Examples: "show my groups", "do I have coins?", "my portfolio", "group stats", "who are the fee receivers?", "what's my group?", "show fee receivers"
   
5. qa - General questions, help, conversation, capability questions, or hypothetical scenarios
   Examples: "how does this work?", "what are fees?", "explain groups", "tell me about flaunchy"
   CAPABILITY/HYPOTHETICAL QUESTIONS: "can I create a group with different fee splits?", "do you support custom splits?", "is it possible to have unequal splits?", "can I make a group where one person gets more?", "what about groups with custom percentages?", "do you allow different fee structures?"
   CHAIN QUESTIONS: "can I switch chains?", "do you support other networks?", "can I launch on sepolia?", "what about ethereum mainnet?" → These are capability questions about unsupported features
   IMPORTANT: Any question seeking information about capabilities or asking "what if" scenarios should be qa, NOT action flows
   
6. confirmation - Confirming a previous request
   Examples: "yes", "ok", "do it", "yep", "sure", "go ahead", "let's do it"

CLASSIFICATION PRIORITY ORDER:
1. CAPABILITY/HYPOTHETICAL QUESTIONS - Questions about what's possible, supported features, or hypothetical scenarios → qa
2. INFORMATIONAL QUERIES - Questions about existing groups/coins override active flows (e.g., "who are fee receivers?", "show my groups")
3. GROUP CREATION SIGNALS - Explicit group creation or "add everyone" requests override current step
4. ACTIVE FLOW CONTINUATION - Is user continuing an active onboarding/management process?
5. NEW INTENT DETECTION - If no active flow, what is the user trying to do?

CRITICAL: DISTINGUISH QUESTIONS FROM ACTIONS
- QUESTIONS seek information/understanding: "can I...", "do you support...", "is it possible...", "what about...", "how about..."
- ACTIONS request execution: "create...", "make...", "start...", "launch...", "i want to..."
- Questions with group-related words are STILL QUESTIONS → qa
- Only clear action statements should trigger group creation flows



CRITICAL EXAMPLES - QUESTIONS VS ACTIONS:
QUESTIONS (seeking information) → qa:
- "can I create a group with different fee splits for each receiver?" = qa (asking about capability)
- "do you support custom fee splits?" = qa (asking about features)
- "is it possible to have unequal splits?" = qa (asking about possibility)
- "can I make a group where one person gets more?" = qa (asking what's allowed)
- "what about groups with custom percentages?" = qa (asking about options)
- "do you allow different fee structures?" = qa (asking about support)
- "can I switch chains?" = qa (asking about unsupported feature)
- "do you support sepolia?" = qa (asking about unsupported network)
- "what about ethereum mainnet?" = qa (asking about unsupported network)

ACTIONS (requesting execution) → onboarding/group_launch/management/coin_launch:
- "create a group with different fee splits" = onboarding (if 0 groups) OR group_launch (if has groups)
- "make a group" = onboarding (if 0 groups) OR group_launch (if has groups)
- "start a group" = onboarding (if 0 groups) OR group_launch (if has groups)
- "i want to create a group" = onboarding (if 0 groups) OR group_launch (if has groups)
- User in onboarding + "split between me and alice" = onboarding (continuing fee receiver setup)
- User in onboarding + "MyCoin (MCN)" = onboarding (providing coin details)  
- User in onboarding + "launch Token TOKIE into that group" = onboarding (providing coin details during onboarding!)
- User with 0 groups + "create group" = onboarding (first group)
- User with groups + "create group" = group_launch (additional group)
- User with groups + "start a new group for everyone" = group_launch (additional group creation)
- User with groups + "launch a group and add everyone" = group_launch (additional group creation)
- User with groups + "show my groups" = management (viewing existing)
- User in onboarding + "who are the fee receivers?" = management (asking about existing group info, NOT continuing onboarding)
- User in onboarding + "what's my group?" = management (asking about existing group info)
- User in onboarding + "show fee receivers" = management (asking about existing group info)
- User in onboarding + "launch a group for everyone here" = onboarding (group creation with add everyone, NOT coin launch!)
- User in onboarding + "create a group for everyone" = onboarding (group creation with add everyone)
- User with groups + uploads image with no/minimal text = coin_launch (image-only coin launch information)
- User with groups + "" (empty message) with image attachment = coin_launch (providing coin image)
- User with groups + "Banana (BNAA) with $100 market cap and 0.77% premine" = coin_launch (coin specification with parameters)
- User with groups + "MyCoin (MCN) $5000 market cap" = coin_launch (coin specification with market cap)
- User with groups + "DOGE token with 10% prebuy" = coin_launch (coin specification with prebuy)
- User with groups + "I would like to flaunch a token into [group name]" = coin_launch (explicit token launch request)
- User with groups + "launch a token into my group" = coin_launch (token launch, NOT group creation)
- User with groups + "create a token" = coin_launch (token creation)
- User with groups + "launch a coin" = coin_launch (coin launch)
- User with groups + "flaunch a token" = coin_launch (token launch with "flaunch" terminology)

CRITICAL DISTINCTION - TOKEN vs GROUP:
- "launch a TOKEN" = coin_launch (creating/launching a cryptocurrency token)
- "launch a GROUP" = group_launch (creating a new fee-splitting group)
- "flaunch a token" = coin_launch (platform-specific term for token launch)
- "create a coin" = coin_launch (cryptocurrency creation)
- "create a group" = group_launch (fee group creation)

Respond ONLY with this JSON format:
{
  "intent": "onboarding|coin_launch|group_launch|management|qa|confirmation",
  "confidence": 0.1-1.0,
  "reasoning": "brief explanation focusing on flow continuation vs new intent"
}`;
  }

  private buildUserContext(userState: UserState): string {
    const status = userState.status;
    const groupCount = userState.groups.length;
    const coinCount = userState.coins.length;
    
    let context = `Status: ${status}\n`;
    context += `Groups: ${groupCount} ${groupCount === 0 ? '← ZERO GROUPS (first group = onboarding)' : '← HAS GROUPS (additional groups = management)'}\n`;
    context += `Coins: ${coinCount}\n`;
    
    // Add onboarding progress context
    if (userState.onboardingProgress) {
      context += `ONBOARDING IN PROGRESS: Step ${userState.onboardingProgress.step}\n`;
      if (userState.onboardingProgress.splitData?.receivers) {
        context += `- Already has fee receivers configured\n`;
      }
      
      // CRITICAL: Only include coin data context when user is actively in coin creation steps
      // Don't include it during group creation to avoid misleading the intent classifier
      if (userState.onboardingProgress.coinData && 
          (userState.onboardingProgress.step === 'coin_creation' || 
           userState.onboardingProgress.step === 'username_collection')) {
        const coinData = userState.onboardingProgress.coinData;
        context += `- Coin data: name=${coinData.name || 'missing'}, ticker=${coinData.ticker || 'missing'}, image=${coinData.image ? 'provided' : 'missing'}\n`;
      }
    }
    
    // Add pending transaction context  
    if (userState.pendingTransaction) {
      context += `PENDING TRANSACTION: ${userState.pendingTransaction.type} on ${userState.pendingTransaction.network}\n`;
    }
    
    // Add management progress context
    if (userState.managementProgress) {
      context += `MANAGEMENT IN PROGRESS: ${userState.managementProgress.action} (${userState.managementProgress.step})\n`;
    }
    
    // Add coin launch progress context (this is when user is actively launching coins)
    if (userState.coinLaunchProgress) {
      context += `COIN LAUNCH IN PROGRESS: Step ${userState.coinLaunchProgress.step}\n`;
      if (userState.coinLaunchProgress.coinData) {
        const coinData = userState.coinLaunchProgress.coinData;
        context += `- Active coin launch: name=${coinData.name || 'missing'}, ticker=${coinData.ticker || 'missing'}, image=${coinData.image ? 'provided' : 'missing'}\n`;
      }
    }
    
    if (groupCount > 0) {
      const groupInfo = userState.groups.map(g => 
        `${g.id.slice(0, 6)}...${g.id.slice(-4)} (${g.coins.length} coins)`
      ).join(', ');
      context += `Group details: ${groupInfo}`;
    }
    
    return context;
  }

  private parseIntentResponse(content: string, userState: UserState): IntentResult {
    try {
      const parsed = JSON.parse(content);
      
      // Validate the response
      const validIntents: MessageIntent[] = ['onboarding', 'coin_launch', 'group_launch', 'management', 'qa', 'confirmation'];
      if (!validIntents.includes(parsed.intent)) {
        console.warn('Invalid intent returned:', parsed.intent);
        return this.getFallbackIntent(userState);
      }
      
      // Ensure confidence is within bounds
      const confidence = Math.max(0.1, Math.min(1.0, parsed.confidence || 0.5));
      
      return {
        intent: parsed.intent,
        confidence,
        reasoning: parsed.reasoning || 'No reasoning provided'
      };
    } catch (error) {
      console.error('Failed to parse intent response:', content, error);
      return this.getFallbackIntent(userState);
    }
  }

  private getFallbackIntent(userState: UserState): IntentResult {
    // Fallback logic based on user state
    if (userState.status === 'new' || userState.status === 'onboarding') {
      return {
        intent: 'onboarding',
        confidence: 0.7,
        reasoning: 'Fallback: User is new or in onboarding'
      };
    }
    
    return {
      intent: 'qa',
      confidence: 0.5,
      reasoning: 'Fallback: Default to Q&A for active users'
    };
  }


} 