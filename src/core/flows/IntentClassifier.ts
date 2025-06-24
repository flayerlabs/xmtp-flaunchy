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
Classify the intent of this user message for a crypto token launch bot.

USER CONTEXT:
${userContext}

USER MESSAGE: "${message}"

INTENT OPTIONS:
1. onboarding - User wants to create their FIRST group (when they have 0 groups)
   Examples: "create a group", "launch a group", "set up a group", "launch a group for me and @alice", "help me get started", "I want to launch a token", "launch my first coin"
   
2. coin_launch - User wants to launch a coin into an existing group  
   Examples: "launch MyCoin (MCN)", "create new coin", "add coin to group", "launch DOGE into my group", "new token for my community"
   
3. management - User wants to view/manage existing groups/coins OR create ADDITIONAL groups (when they already have groups)
   Examples: "show my groups", "do I have coins?", "my portfolio", "group stats", "create another group", "launch a new group" (only for users with existing groups)
   
4. qa - General questions, help, or conversation
   Examples: "how does this work?", "what are fees?", "explain groups", "tell me about flaunchy", "what can you do?"
   
5. confirmation - Confirming a previous request
   Examples: "yes", "ok", "do it", "yep", "sure", "go ahead", "let's do it", "create it", "launch it"

CLASSIFICATION RULES (STRICTLY FOLLOW):

1. **FIRST GROUP CREATION** (Groups: 0):
   - Any mention of "group", "launch", "create" → onboarding
   - Examples: "launch a group", "create group", "group for me", "let's launch a group for me and 0x123"

2. **ADDITIONAL GROUP CREATION** (Groups: 1+):
   - Mentions of creating/launching groups → management
   - Examples: "create another group", "new group"

3. **COIN LAUNCH** (Groups: 1+):
   - Mentions coin name/ticker with launch intent → coin_launch
   - Examples: "launch MyCoin (MCN)", "create DOGE token"

4. **OTHER INTENTS**:
   - Questions about existing data → management
   - General help/questions → qa
   - Short confirmations → confirmation

⚠️ CRITICAL: Check Groups count first! 0 groups + group mention = onboarding

Respond ONLY with this JSON format:
{
  "intent": "onboarding|coin_launch|management|qa|confirmation",
  "confidence": 0.1-1.0,
  "reasoning": "brief explanation"
}`;
  }

  private buildUserContext(userState: UserState): string {
    const status = userState.status;
    const groupCount = userState.groups.length;
    const coinCount = userState.coins.length;
    
    let context = `Status: ${status}\n`;
    context += `Groups: ${groupCount} ${groupCount === 0 ? '← ZERO GROUPS (first group = onboarding)' : '← HAS GROUPS (additional groups = management)'}\n`;
    context += `Coins: ${coinCount}`;
    
    if (groupCount > 0) {
      const groupInfo = userState.groups.map(g => 
        `Group ${g.id.slice(-6)} (${g.coins.length} coins)`
      ).join(', ');
      context += `\nGroup details: ${groupInfo}`;
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
} 