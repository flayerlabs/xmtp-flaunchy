export const QAFlow_detectGroupsOrCoinsQueryPrompt = ({
  messageText,
}: {
  messageText: string;
}) => `Is this message specifically asking about groups or coins/tokens? "${messageText}"
          
Look for patterns like but not limited to:
- "list my groups"
- "show my groups"
- "what groups do I have"
- "what are my groups"
- "my groups"
- "list my coins"
- "show my coins"
- "what coins do I have"
- "what are my coins"
- "my coins"
- "what tokens do I have"
- "what are my tokens"
- "my tokens"
- "show my holdings"
- "what coins are in this group"
- "what coins are in the group"
- "what's in this group"
- "what's in the group"
- "coins in this group"
- "coins in the group"
- "show coins in this group"
- "list coins in this group"
- "what coins does this group have"
- "what tokens are in this group"
- "what tokens are in the group"
- "group coins"
- "group tokens"
- "this group's coins"
- "this group's tokens"

Answer only "yes" or "no".`;
