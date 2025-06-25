import OpenAI from "openai";
import { UserState } from "../types/UserState";

export type MessageIntent = 
  | 'onboarding'      // First group creation, new user setup
  | 'coin_launch'     // Launch coin into existing group
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

  async classifyIntent(message: string, userState: UserState): Promise<IntentResult> {
    // First check if user has ongoing management progress
    if (userState.managementProgress && userState.managementProgress.action === 'creating_group') {
      return {
        intent: 'management',
        confidence: 0.95,
        reasoning: 'User has ongoing group creation progress - continuing with management flow'
      };
    }

    // Pre-check for explicit group creation keywords to avoid misclassification
    const explicitGroupCreation = this.isExplicitGroupCreation(message);
    if (explicitGroupCreation) {
      const hasGroups = userState.groups.length > 0;
      return {
        intent: hasGroups ? 'management' : 'onboarding',
        confidence: 0.95,
        reasoning: `Explicit group creation request detected: "${message}" - routing to ${hasGroups ? 'management (additional group)' : 'onboarding (first group)'}`
      };
    }

    const prompt = this.buildClassificationPrompt(message, userState);
    
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

  private buildClassificationPrompt(message: string, userState: UserState): string {
    const userContext = this.buildUserContext(userState);
    
    return `
You are classifying user messages in an ongoing conversation with a crypto token launch bot.

USER CONTEXT:
${userContext}

USER MESSAGE: "${message}"

CRITICAL CONTEXT RULES (READ CAREFULLY):

🔄 **CONVERSATIONAL FLOW CONTINUATION** (HIGHEST PRIORITY):
- If user is actively in a flow (onboarding/management progress exists), assume they are responding to the bot's request
- If bot just asked for fee receivers and user provides usernames/addresses → CONTINUE CURRENT FLOW
- If bot just asked for coin details and user provides name/ticker → CONTINUE CURRENT FLOW  
- If bot just asked for confirmation and user confirms → CONTINUE CURRENT FLOW

📋 **ONBOARDING CONTINUATION SIGNALS**:
- User has onboardingProgress AND provides: usernames, addresses, ENS names, "me and X", fee split info → onboarding
- User has onboardingProgress AND mentions chain preference: "on sepolia", "use mainnet", "switch to base" → onboarding
- User has onboardingProgress AND provides coin details: coin names, tickers, images → onboarding (NOT coin_launch!)
- Examples: "split between me and alice", "me and @bob 50/50", "alice.eth and charlie.eth", "0x123... and 0x456..."
- Chain switching examples: "actually let's launch on sepolia", "use base mainnet", "switch to testnet"
- Coin details examples: "Token TOKIE", "launch MyCoin (MCN)", "create DOGE with image.jpg" → onboarding if user is in onboarding

📋 **INFORMATIONAL QUERIES** (HIGHEST PRIORITY):
- Questions about existing groups/coins: "who are fee receivers?", "show my groups", "what's my group?", "show fee receivers"
- These are ALWAYS management, even if user is in active onboarding/management flows
- Override any active flow when user asks for information about existing data

📋 **GROUP CREATION SIGNALS** (HIGH PRIORITY):
- Explicit group creation requests: "launch a group", "create a group", "group for everyone", "add everyone"
- These should route to appropriate flow (onboarding for first group, management for additional groups)
- "Add everyone" requests should be detected regardless of current flow state

📋 **MANAGEMENT CONTINUATION SIGNALS**:
- User has managementProgress AND continues that task → management

INTENT OPTIONS:
1. onboarding - User wants to create their FIRST group (when they have 0 groups) OR continue their current onboarding process
   Examples: "create a group", "launch a group", "set up a group", "launch a group for me and @alice", "launch a group for everyone here", "help me get started"
   CONTINUATION: If user is in onboarding and provides fee receivers, coin details, or continues the process → onboarding
   GROUP CREATION: If user mentions "group" + "everyone", this is group creation with "add everyone" functionality
   
2. coin_launch - User wants to launch a coin into an existing group  
   Examples: "launch MyCoin (MCN)", "create new coin", "add coin to group", "launch DOGE into my group"
   
3. management - User wants to view/manage existing groups/coins OR create ADDITIONAL groups (when they already have groups)
   Examples: "show my groups", "do I have coins?", "my portfolio", "group stats", "create another group", "who are the fee receivers?", "what's my group?", "show fee receivers"
   
4. qa - General questions, help, or conversation
   Examples: "how does this work?", "what are fees?", "explain groups", "tell me about flaunchy"
   
5. confirmation - Confirming a previous request
   Examples: "yes", "ok", "do it", "yep", "sure", "go ahead", "let's do it"

CLASSIFICATION PRIORITY ORDER:
1. **INFORMATIONAL QUERIES** - Questions about existing groups/coins override active flows (e.g., "who are fee receivers?", "show my groups")
2. **GROUP CREATION SIGNALS** - Explicit group creation or "add everyone" requests override current step
3. **ACTIVE FLOW CONTINUATION** - Is user continuing an active onboarding/management process?
4. **NEW INTENT DETECTION** - If no active flow, what is the user trying to do?

🔗 **CHAIN SWITCHING DETECTION** (VERY IMPORTANT):
- If user is in active onboarding/management AND mentions chains → CONTINUE CURRENT FLOW
- Chain keywords: "sepolia", "mainnet", "base", "testnet", "ethereum"
- Chain switching phrases: "let's launch on X", "use X network", "switch to X", "actually X", "on X instead"
- These are NOT coin launches - they are chain preferences during existing flows!

⚠️ **CRITICAL EXAMPLES**:
- User in onboarding + "split between me and alice" = onboarding (continuing fee receiver setup)
- User in onboarding + "MyCoin (MCN)" = onboarding (providing coin details)  
- User in onboarding + "launch Token TOKIE into that group" = onboarding (providing coin details during onboarding!)
- User in onboarding + "actually let's launch on sepolia" = onboarding (chain switching, NOT coin launch!)
- User in onboarding + "switch to base sepolia and launch there" = onboarding (chain switching during onboarding!)
- User with 0 groups + "create group" = onboarding (first group)
- User with groups + "show my groups" = management (viewing existing)
- User in onboarding + "who are the fee receivers?" = management (asking about existing group info, NOT continuing onboarding)
- User in onboarding + "what's my group?" = management (asking about existing group info)
- User in onboarding + "show fee receivers" = management (asking about existing group info)
- User in onboarding + "launch a group for everyone here" = onboarding (group creation with add everyone, NOT coin launch!)
- User in onboarding + "create a group for everyone" = onboarding (group creation with add everyone)

Respond ONLY with this JSON format:
{
  "intent": "onboarding|coin_launch|management|qa|confirmation",
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
      if (userState.onboardingProgress.coinData) {
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
    
    if (groupCount > 0) {
      const groupInfo = userState.groups.map(g => 
        `Group ${g.id.slice(-6)} (${g.coins.length} coins)`
      ).join(', ');
      context += `Group details: ${groupInfo}`;
    }
    
    return context;
  }

  private parseIntentResponse(content: string, userState: UserState): IntentResult {
    try {
      const parsed = JSON.parse(content);
      
      // Validate the response
      const validIntents: MessageIntent[] = ['onboarding', 'coin_launch', 'management', 'qa', 'confirmation'];
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

  private isExplicitGroupCreation(message: string): boolean {
    const lowerMessage = message.toLowerCase();
    
    // Explicit group creation phrases
    const groupCreationPhrases = [
      'create a group',
      'create group',
      'start a group',
      'start group',
      'make a group',
      'make group',
      'set up a group',
      'set up group',
      'launch a group',
      'launch group',
      'new group',
      'another group',
      'additional group',
      'group for',
      'group with',
      'i want to create a group',
      'i want to start a group',
      'i want to make a group',
      'i want a group',
      'let\'s create a group',
      'let\'s start a group',
      'let\'s make a group',
      'can you create a group',
      'can you start a group',
      'help me create a group',
      'help me start a group'
    ];
    
    // Check if message contains explicit group creation phrases
    const hasGroupCreationPhrase = groupCreationPhrases.some(phrase => lowerMessage.includes(phrase));
    
    // Additional check: contains "group" and creation verbs but NOT coin-specific words
    const hasGroup = lowerMessage.includes('group');
    const hasCreationVerb = ['create', 'start', 'make', 'launch', 'set up', 'new'].some(verb => lowerMessage.includes(verb));
    const hasCoinWords = ['coin', 'token', 'ticker', 'symbol'].some(word => lowerMessage.includes(word));
    
    return hasGroupCreationPhrase || (hasGroup && hasCreationVerb && !hasCoinWords);
  }
} 