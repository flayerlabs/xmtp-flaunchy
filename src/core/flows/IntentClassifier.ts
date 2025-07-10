import OpenAI from "openai";
import { UserState } from "../types/UserState";
import { safeParseJSON } from "../utils/jsonUtils";

export type MessageIntent = 
  | 'coin_launch'     // Launch coin (automatically creates group if needed)
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
    // Early detection for image-only coin launches
    if (hasAttachment && (!message || message.trim().length < 20)) {
      // User uploaded an image with minimal text - likely coin launch
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
You are classifying user messages for a simplified crypto token launch bot.

USER CONTEXT:
${userContext}

USER MESSAGE: "${message}"${hasAttachment ? '\nHAS IMAGE ATTACHMENT: true' : ''}

SIMPLIFIED BOT ARCHITECTURE:
The bot is now a dedicated coin launcher that automatically splits fees between chat group members.
Users no longer create groups explicitly - they just launch coins and the bot handles group creation automatically.

INTENT OPTIONS:
1. coin_launch - User wants to launch a TOKEN/COIN (chat group group must be created first)
   Examples: 
   - Token specifications: "MyCoin (MCN)", "DOGE token", "Token ABC with $1000 market cap"
   - Basic coin requests: "launch a coin", "create a token", "flaunch DOGE"
   - Coin parameters: "Banana (BNAA) with $100 market cap and 0.77% premine"
   - Image uploads: User uploads image with minimal text (likely coin image)
   INDICATORS: "token", "coin", ticker symbols in parentheses like "(MCN)", specific coin names
   
2. management - User wants to view/manage existing coins or check chat group group
   Examples: "show my coins", "do I have coins?", "my portfolio", "what's our group?", "who gets fees?"
   
3. qa - General questions, help, or capability questions
   Examples: "how does this work?", "what are fees?", "explain how it works", "tell me about flaunchy"
   CAPABILITY QUESTIONS: "can I...", "do you support...", "is it possible...", "what about..."
   PERSONAL INFO: "what's my address?", "who am I?", "what address am I?"
   
4. confirmation - Confirming a previous request
   Examples: "yes", "ok", "do it", "yep", "sure", "go ahead", "let's do it"

CRITICAL CONTEXT:
- Each chat group has exactly ONE group that all users share
- First coin launch in a chat group creates the group for everyone
- All subsequent coins in that chat group use the same group
- If user has ongoing coin launch progress and provides coin details → coin_launch
- If user has management progress and continues that task → management
- Questions about existing data always override active flows → management
- General questions or capability inquiries → qa

CLASSIFICATION RULES:
1. INFORMATIONAL QUERIES (HIGHEST PRIORITY) - Questions about existing coins or chat group group → management
2. ACTIVE FLOW CONTINUATION - User continuing an active coin launch or management process
3. NEW COIN LAUNCH - User wants to launch a new token/coin → coin_launch
4. QUESTIONS - General questions, help, capabilities → qa
5. CONFIRMATIONS - "yes", "ok", etc. → confirmation

CRITICAL: Return your response in this exact format:

\`\`\`json
{...your JSON response here...}
\`\`\`

Respond ONLY with this JSON format:
{
  "intent": "coin_launch|management|qa|confirmation",
  "confidence": 0.1-1.0,
  "reasoning": "brief explanation focusing on simplified coin launcher workflow"
}`;
  }

  private buildUserContext(userState: UserState): string {
    const status = userState.status;
    const groupCount = userState.groups.length;
    const coinCount = userState.coins.length;
    
    let context = `Status: ${status}\n`;
    context += `Groups: ${groupCount}\n`;
    context += `Coins: ${coinCount}\n`;
    
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
      const parsed = safeParseJSON(content);
      
      // Validate the response
      const validIntents: MessageIntent[] = ['coin_launch', 'management', 'qa', 'confirmation'];
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
    // Simplified fallback: default to Q&A since the agent now explains how it works
    return {
      intent: 'qa',
      confidence: 0.5,
      reasoning: 'Fallback: Default to Q&A for explanation and help'
    };
  }


} 