export const QAFlow_handleGeneralQuestionPrompt = ({
  messageText,
  coinsCount,
  groupsCount,
}: {
  messageText: string;
  coinsCount: number;
  groupsCount: number;
}) => `
User asked: <message>"${messageText}"</message>

This is a GENERAL question about using the system (not about your capabilities).

SIMPLIFIED WORKFLOW TO EXPLAIN:
"Launch coins with me and you'll split the trading fees with everyone in this chat group. Tag me @flaunchy or reply to my messages to interact."

Provide helpful guidance about:
- Coin launching with automatic group creation
- Fee splitting mechanisms (automatic for everyone in chat)
- Trading and fair launches
- No complex setup needed - just launch coins

IMPORTANT: Emphasize the simplicity - users just need to launch coins and everything else is handled automatically.

If the user has some question about THEIR coins or groups, only then refer to this user information:
<user-info>
- Has ${coinsCount} coins
- Has ${groupsCount} groups
</user-info>

FORMATTING REQUIREMENTS:
- Use \n to separate different concepts and create line breaks
- Break up long explanations into multiple paragraphs
- Use bullet points or numbered lists when appropriate
- Make the response easy to read and scan, but keep it short and concise
- DON'T use markdown (like **bold** or *italic*)

Use your character's voice but prioritize brevity and helpfulness.`;
