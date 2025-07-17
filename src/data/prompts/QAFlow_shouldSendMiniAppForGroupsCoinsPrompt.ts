export const QAFlow_shouldSendMiniAppForGroupsCoinsPrompt = ({
  messageText,
  groupsCount,
  coinsCount,
}: {
  messageText: string;
  groupsCount: number;
  coinsCount: number;
}) => `The user asked: <message>"${messageText}"</message>

User has:
- ${groupsCount} groups
- ${coinsCount} coins

Should I send the mini app link (https://mini.flaunch.gg) as a separate message? The mini app allows users to see detailed information about their coins, groups, and earned and more detailed views.

Send the mini app link if:
- User is asking anything about their groups or coins
- User has groups or coins and wants to see more details
- User is asking about earned fees, stats, or analytics
- User wants to see visual information about their holdings

Don't send the mini app link if:
- User has no groups or coins (nothing to view in mini app)

Answer only "yes" or "no".`;
