export const QAFlow_detectStatusInquiryPrompt = ({
  messageText,
}: {
  messageText: string;
}) => `Is this message asking about the user's current status, progress, or pending transactions? "${messageText}"
          
Look for questions like:
- "do I have a group being created?"
- "what's my status?"
- "do I have any pending transactions?"
- "what groups do I have?"
- "what coins have I launched?"
- "am I in onboarding?"
- "what's happening with my transaction?"
- "where am I in the process?"
- "what's my current state?"
- "do I have anything pending?"

Answer only "yes" or "no".`;
