import { PendingTransaction } from "../../core/types/UserState";

export const ManagementFlow_modifyCoinTransactionPrompt = ({
  messageText,
  pendingTx,
}: {
  messageText: string;
  pendingTx: PendingTransaction;
}) =>
  `Extract coin launch parameter changes from this message:

Message: "${messageText}"

Current parameters:
- Starting Market Cap: $${pendingTx.launchParameters?.startingMarketCap || 1000}
- Fair Launch Duration: ${
    pendingTx.launchParameters?.fairLaunchDuration || 30
  } minutes
- Prebuy Amount: ${pendingTx.launchParameters?.premineAmount || 0}%
- Buyback Percentage: ${pendingTx.launchParameters?.buybackPercentage || 0}%

IMPORTANT TERMINOLOGY:
- "prebuy", "premine", "pre-buy", "pre-mine" → refers to premineAmount (tokens bought at launch, costs ETH)
- "buyback", "buy back", "automated buybacks" → refers to buybackPercentage (fee allocation for buybacks)

Return your response in this exact format:

\`\`\`json
{
  "startingMarketCap": number (if mentioned),
  "fairLaunchDuration": number (if mentioned, in minutes),
  "premineAmount": number (if mentioned, as percentage for prebuy/premine),
  "buybackPercentage": number (if mentioned, as percentage for buybacks)
}
\`\`\`

If no parameters are mentioned, return:

\`\`\`json
{}
\`\`\``;
