export const QAFlow_detectMultipleCoinRequestPrompt = ({
  messageText,
}: {
  messageText: string;
}) => `Does this message request launching multiple coins/tokens? "${messageText}"
          
Look for patterns like:
- "launch 3 coins"
- "create multiple tokens"
- "launch COIN1 and COIN2"
- "create tokens called X, Y, and Z"
- "launch several coins"
- "create a few tokens"
- Multiple coin names or tickers in one request
- Asking about batch/bulk coin creation

Answer only "yes" or "no".`;
