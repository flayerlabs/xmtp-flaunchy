// Coin launch details extraction template for coin launch flow
export const coinLaunchExtractionTemplate = `
# COIN LAUNCH EXTRACTION TASK
CRITICAL: Return your response in this exact format:

\`\`\`json
{...your JSON response here...}
\`\`\`

You must return ONLY a valid JSON object. NO conversation, NO explanation, NO extra text.

EXTRACTION RULES

TOKEN DETAILS EXTRACTION

Name and Ticker Extraction Priority:

Pattern 1: Key-Value format (HIGHEST PRIORITY)
- "Name: YouTube" → name: "YouTube", ticker: null
- "Ticker: YTBE" → name: null, ticker: "YTBE"
- "Name: Test Token" → name: "Test Token", ticker: null
- "Ticker: TEST" → name: null, ticker: "TEST"
- "Ticker and Name Test" → name: "Test", ticker: "TEST"
- "Name and Ticker Test" → name: "Test", ticker: "TEST"

Pattern 2: "Name (TICKER)" format
- "Timer (TIME)" → name: "Timer", ticker: "TIME"
- "Launch Timer (TIME)" → name: "Timer", ticker: "TIME" (remove "Launch" prefix)
- "Space Coin (SPACE)" → name: "Space Coin", ticker: "SPACE"

Pattern 3: "Launch/Create [called/named] Name"
- "Launch token called Moonshot" → name: "Moonshot", ticker: "MOON" (generate)
- "Create token named Solar" → name: "Solar", ticker: "SOLR" (generate)

Pattern 4: "Launch Name" (without called/named)
- "Launch Moonshot" → name: "Moonshot", ticker: "MOON" (generate)
- "Launch Space Token" → name: "Space Token", ticker: "SPTK" (generate)

Pattern 5: Ticker only
- "Launch ticker DOGE" → name: "DOGE", ticker: "DOGE"
- "Create MOON token" → name: "MOON", ticker: "MOON"

Image Extraction:
- Look for image URLs in the message context
- Accept IPFS URLs (ipfs://...) and HTTPS URLs (https://...)
- If attachment is present, set image to "attachment_provided"
- IMPORTANT: If only an image attachment is provided (no text), this is still valid coin launch information
- Return null if no valid image found

TARGET GROUP EXTRACTION

Look for group/contract address references:
1. Full contract addresses: "0x1234567890abcdef..." (40 hex characters after 0x)
2. Shortened addresses: "0x1234...abcd" format
3. Group references: "into group 0x...", "launch into 0x...", "use group 0x..."
4. Direct address mentions: any 0x followed by hex characters
5. Group names: Look for "into [GroupName]", "launch into [GroupName]", "use [GroupName]"
   - Examples: "into Zenith Pack 50", "launch into Alpha Squad 247", "use Static Lab 876"
   - Group names are typically in format: "[Adjective] [Noun] [Number]"
   - Extract the full group name including spaces and numbers

LAUNCH PARAMETERS EXTRACTION

Market Cap:
- Look for: "market cap", "mcap", "starting cap", "$1000", "1k", etc.
- Extract numeric values and convert k/K to thousands
- Clamp between $100 and $10,000

Duration:
- Look for: "fair launch duration", "launch time", "30 minutes", "1 hour", etc.
- Convert hours to minutes, clamp between 1-60 minutes

Prebuy/Premine:
- Look for: "prebuy", "premine", "pre-buy", "pre-mine" with percentages
- These refer to tokens bought at launch (costs ETH)
- Extract percentage values, clamp between 0-100%
- Map to premineAmount field

Buybacks:
- Look for: "buyback", "buy back", "automated buybacks", "auto buyback" with percentages  
- These refer to automated buybacks from trading fees (affects fee allocation)
- Extract percentage values, clamp between 0-100%
- Map to buybackPercentage field

IMPORTANT: "prebuy" and "premine" always refer to tokens bought at launch, NOT buybacks!

INPUT DATA
Current Message: {{message}}
{{#if hasAttachment}}
Has Attachment: true
Attachment Type: {{attachmentType}}
{{/if}}
{{#if imageUrl}}
Image URL: {{imageUrl}}
{{/if}}

REQUIRED OUTPUT FORMAT
Return ONLY this JSON structure:

{
  "tokenDetails": {
    "name": "string or null",
    "ticker": "string or null", 
    "image": "string or null"
  },
  "targetGroup": "string or null",
  "launchParameters": {
    "startingMarketCap": number_or_null,
    "fairLaunchDuration": number_or_null,
    "premineAmount": number_or_null,
    "buybackPercentage": number_or_null
  }
}

Examples:

Key-value format (most common):
"Name: YouTube" →
{
  "tokenDetails": {"name": "YouTube", "ticker": null, "image": null},
  "targetGroup": null,
  "launchParameters": {"startingMarketCap": null, "fairLaunchDuration": null, "premineAmount": null, "buybackPercentage": null}
}

"Ticker: YTBE" →
{
  "tokenDetails": {"name": null, "ticker": "YTBE", "image": null},
  "targetGroup": null,
  "launchParameters": {"startingMarketCap": null, "fairLaunchDuration": null, "premineAmount": null, "buybackPercentage": null}
}

Full launch command:
"launch nobi (NOBI) into 0xfdb02c98d215ee60e19822a42dee9e6c26fe7394" →
{
  "tokenDetails": {"name": "nobi", "ticker": "NOBI", "image": null},
  "targetGroup": "0xfdb02c98d215ee60e19822a42dee9e6c26fe7394",
  "launchParameters": {"startingMarketCap": null, "fairLaunchDuration": null, "premineAmount": null, "buybackPercentage": null}
}

Token with parameters:
"Launch DogeCoin (DOGE) with $5000 market cap and 45 minute fair launch" →
{
  "tokenDetails": {"name": "DogeCoin", "ticker": "DOGE", "image": null},
  "targetGroup": null,
  "launchParameters": {"startingMarketCap": 5000, "fairLaunchDuration": 45, "premineAmount": null, "buybackPercentage": null}
}

Token with group name:
"launch Caps (CAPS) into Zenith Pack 50" →
{
  "tokenDetails": {"name": "Caps", "ticker": "CAPS", "image": null},
  "targetGroup": "Zenith Pack 50",
  "launchParameters": {"startingMarketCap": null, "fairLaunchDuration": null, "premineAmount": null, "buybackPercentage": null}
}

Group selection only:
"use group 0x1234567890abcdef1234567890abcdef12345678" →
{
  "tokenDetails": {"name": null, "ticker": null, "image": null},
  "targetGroup": "0x1234567890abcdef1234567890abcdef12345678",
  "launchParameters": {"startingMarketCap": null, "fairLaunchDuration": null, "premineAmount": null, "buybackPercentage": null}
}

Image only (with attachment):
"" (empty message with image attachment) →
{
  "tokenDetails": {"name": null, "ticker": null, "image": "attachment_provided"},
  "targetGroup": null,
  "launchParameters": {"startingMarketCap": null, "fairLaunchDuration": null, "premineAmount": null, "buybackPercentage": null}
}

Extract coin launch details from the current message now:
`;

// Helper function to use the template
export function createCoinLaunchExtractionPrompt(context: {
  message: string;
  hasAttachment?: boolean;
  attachmentType?: string;
  imageUrl?: string;
}): string {
  let prompt = coinLaunchExtractionTemplate;

  // Replace template variables
  prompt = prompt.replace("{{message}}", context.message);

  if (context.hasAttachment) {
    prompt = prompt.replace("{{#if hasAttachment}}", "").replace("{{/if}}", "");
    prompt = prompt.replace(
      "{{attachmentType}}",
      context.attachmentType || "unknown"
    );
  } else {
    // Remove the attachment section
    prompt = prompt.replace(/{{#if hasAttachment}}[\s\S]*?{{\/if}}/g, "");
  }

  if (context.imageUrl) {
    prompt = prompt.replace("{{#if imageUrl}}", "").replace("{{/if}}", "");
    prompt = prompt.replace("{{imageUrl}}", context.imageUrl);
  } else {
    // Remove the image URL section
    prompt = prompt.replace(/{{#if imageUrl}}[\s\S]*?{{\/if}}/g, "");
  }

  return prompt;
}

// Type for the coin launch extraction result
export interface CoinLaunchExtractionResult {
  tokenDetails: {
    name: string | null;
    ticker: string | null;
    image: string | null;
  };
  targetGroup: string | null;
  launchParameters: {
    startingMarketCap: number | null;
    fairLaunchDuration: number | null;
    premineAmount: number | null;
    buybackPercentage: number | null;
  };
}
