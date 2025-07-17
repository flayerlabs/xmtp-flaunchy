export const ManagementFlow_isMessageAboutPendingTransactionPrompt = ({
  transactionContext,
  messageText,
}: {
  transactionContext: string;
  messageText: string;
}) => `${transactionContext}Is this message about that pending transaction?

Message: "${messageText}"

Consider the message about the pending transaction if it:
- Contains words like "update", "change", "modify", "set", "adjust", "fix"
- Mentions specific transaction parameters (market cap, duration, prebuy, premine, buyback, etc.)
- Asks about transaction status or details
- Wants to cancel the transaction
- References signing or confirming
- Asks about coin details that are part of the transaction
- Asks about launch parameters or settings
- Contains phrases like "please update", "change to", "set to", "make it"

FOR GROUP CREATION transactions, ALSO consider it about the transaction if it:
- Contains words like "add", "include", "append", "remove", "exclude"
- Mentions adding/removing people, usernames, or addresses
- References group members or fee receivers
- Contains phrases like "add @username", "include everyone", "can you add"

ESPECIALLY if the message mentions:
- "prebuy", "premine", "market cap", "duration", "buyback" with values or percentages
- "update the [parameter] to [value]"
- "change [parameter]"
- "add @username" or "include [person]"

Do NOT consider it about the transaction if it's:
- Asking about existing/completed groups or coins
- General questions about capabilities
- Completely unrelated requests

Answer only "yes" or "no".`;
