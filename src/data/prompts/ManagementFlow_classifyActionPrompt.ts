export const ManagementFlow_classifyActionPrompt = ({
  messageText,
}: {
  messageText: string;
}) => `Classify this message into one of these actions: "${messageText}"

Actions:
- list_groups: Show user's groups, group info, "my groups", "show groups"
- list_coins: Show user's coins, coin info, "my coins", "show coins"  
- claim_fees: Claim/withdraw fees, "claim fees", "withdraw"
- check_fees: Check fee balances, "how much fees", "check balance"
- cancel_transaction: Cancel pending transaction, "cancel", "stop transaction"
- general_help: General help requests, "help", "what can you do"
- answer_question: Answer questions about the system, explain features

Answer with just the action name.`;
