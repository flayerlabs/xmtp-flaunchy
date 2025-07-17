export const FlowRouter_detectMultipleIntentsPrompt = ({
  messageText,
  status,
  groupCount,
  coinCount,
  pendingTxType,
}: {
  messageText: string;
  status: string;
  groupCount: number;
  coinCount: number;
  pendingTxType: string;
}) => `Analyze this message for ALL intents (not just one):

MESSAGE: <message>"${messageText}"</message>

USER CONTEXT:
- Status: ${status}
- Groups: ${groupCount}
- Coins: ${coinCount}  
- Pending Transaction: ${pendingTxType}

DETECT ALL INTENTS in order of importance:

PRIMARY INTENT (most important):

CRITICAL: VIEW/STATUS REQUESTS vs LAUNCH REQUESTS
These are STATUS INQUIRIES (→ inquiry), NOT coin launches:
- "what are my coins", "list my coins", "show my coins"
- "what coins do I have", "do I have any coins", "my coin portfolio"
- "what's my group", "show my group", "group info"
- "what's my status", "how many coins", "portfolio"
- "show me", "list", "display", "view" + [coins/groups/status]
- "share mini app", "share the mini app", "mini app link", "mini app url"

COIN LAUNCH PATTERNS (→ coin_launch):
These patterns indicate NEW coin creation:
- "Name (TICKER)" format: "Test (TEST)", "Dogecoin (DOGE)", "MyCoin (MCN)"
- "Token/Coin name ticker" format: "Token TEST", "Coin DOGE", "Launch MyCoin"  
- "Create/Launch token/coin" with name/ticker: "create token Test", "launch coin DOGE"
- Single words that could be coin names: "Ethereum", "Bitcoin", "Solana"
- Ticker symbols: "TEST", "DOGE", "BTC"
- "launch", "create", "flaunch" + coin details
- Image uploads with minimal text (likely coin images)

ACTIONS (classify based on patterns above):
1. inquiry: Status questions, viewing existing data, "what/show/list/display" requests
2. coin_launch: Token/coin creation patterns (creates chat group automatically if needed)
3. modify_existing: Modifying coin parameters or pending transactions

MANAGEMENT:
4. cancel, management: Managing existing coins or viewing chat group

SOCIAL:
5. greeting: Social interactions

CONTEXT-AWARE CLASSIFICATION:
- Chat group model: each chat group has exactly ONE group shared by everyone
- Coin launch patterns always → coin_launch (creates group automatically if first coin in chat)
- Questions about existing coins or chat group group → inquiry

SECONDARY INTENTS (also in the message):
- Any other intents that should be handled after the primary

FLAGS (detect these patterns):
- isTransactionInquiry: Asking about pending transactions/status
- isStatusInquiry: "what are my", "list my", "show my", "do I have", "what's my status", "what coins", "what's our group", "my portfolio", "view", "display", "share mini app", "mini app"

Return JSON:
\`\`\`json
{
  "primaryIntent": {
    "type": "action|question|management|social",
    "action": "coin_launch|modify_existing|inquiry|greeting|cancel|management|other",
    "confidence": 0.0-1.0,
    "reasoning": "why this is primary"
  },
  "secondaryIntents": [
    {
      "type": "action|question|management|social", 
      "action": "...",
      "confidence": 0.0-1.0
    }
  ],
  "flags": {
    "isTransactionInquiry": boolean,
    "isStatusInquiry": boolean
  }
}
\`\`\`
`;
