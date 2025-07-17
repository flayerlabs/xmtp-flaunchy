export const ManagementFlow_classifyTransactionIntentPrompt = ({
  messageText,
}: {
  messageText: string;
}) => `Classify this transaction-related message:

Message: "${messageText}"

Categories:
- cancel: User wants to cancel/stop the transaction
- modify: User wants to add/change/update transaction details
- inquiry: User is asking about transaction status/details

Respond with only: cancel, modify, or inquiry`;
