import { FlowContext } from '../types/FlowContext';

/**
 * Detects if the user wants to add everyone/all members to a group
 * Uses LLM for accurate detection with typo tolerance
 */
export async function detectAddEveryone(context: FlowContext, messageText?: string): Promise<boolean> {
  // Use provided messageText or extract from context
  const text = messageText || (context.message.content as string);
  if (!text) return false;

  // Check FlowRouter multi-intent flags first (fast path)
  if (context.multiIntentResult?.flags?.isAddEveryone) {
    console.log(`[AddEveryoneDetector] ✅ Everyone detected via FlowRouter flags`);
    return true;
  }

  // Use LLM for accurate detection with typo tolerance
  try {
    const response = await context.openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [{
        role: 'user',
        content: `Does this message request to include ALL group chat members (even with typos)? "${text}" 
        
        Look for requests like:
        - "everyone" (including typos like "ebeyrone", "eveyrone", "everone")
        - "for everyone" 
        - "all members"
        - "include everyone"
        - "everyone in the chat"
        - "add everyone"
        - "create a group for everyone"
        - "launch a group for everyone"
        - "start a group for everyone"
        - "make a group for everyone"
        - "set up a group for everyone"
        - "flaunchy create a group for everyone"
        - "group for everyone"
        - "everyone in this chat"
        - "all of us"
        - "all people here"
        - "launch group for everyone"
        - "create group for everyone"
        - "and everyone" (as follow-up)
        - "and everybody"
        
        IMPORTANT: Be tolerant of typos! "ebeyrone" should be detected as "everyone".
        
        Answer only "yes" or "no".`
      }],
      temperature: 0.1,
      max_tokens: 5
    });

    const result = response.choices[0]?.message?.content?.trim().toLowerCase() === 'yes';
    
    console.log(`[AddEveryoneDetector] ${result ? '✅' : '❌'} Everyone detection result: ${result}`);
    return result;
    
  } catch (error) {
    console.error('[AddEveryoneDetector] Failed to detect add everyone intent:', error);
    return false;
  }
} 