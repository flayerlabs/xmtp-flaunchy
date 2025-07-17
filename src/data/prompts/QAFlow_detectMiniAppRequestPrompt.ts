export const QAFlow_detectMiniAppRequestPrompt = ({
  messageText,
}: {
  messageText: string;
}) => `Is this message asking to share the mini app? <message>"${messageText}"</message>
          
Look for patterns like:
- "share mini app"
- "share the mini app"
- "what's the mini-app link?"
- "share app"
- "share the app"
- "give me the mini app"
- "where is the mini app"
- "mini app url"
- "share mini"
- "mini app"

Answer only "yes" or "no".`;
