export const ManagementFlow_isTransactionStatusQuestionPrompt = ({
  messageText,
}: {
  messageText: string;
}) => `Is this message asking about transaction status or pending transactions?

Message: "${messageText}"

Look for questions like:
- "do I have a pending transaction?"
- "do I have an existing transaction?"
- "what's my transaction status?"
- "is there a transaction waiting?"
- "any pending transactions?"
- "transaction status?"

Answer only "yes" or "no".`;
