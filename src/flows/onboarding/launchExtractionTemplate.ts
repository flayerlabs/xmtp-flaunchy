// Combined launch details extraction template for onboarding flow
export const launchDetailsExtractionTemplate = `
# LAUNCH DETAILS EXTRACTION TASK
You must return ONLY a valid JSON object. NO conversation, NO explanation, NO extra text.

EXTRACTION RULES

TOKEN DETAILS EXTRACTION

Name and Ticker Extraction Priority:

Pattern 1: "Name (TICKER)" format
- "Timer (TIME)" → name: "Timer", ticker: "TIME"
- "Launch Timer (TIME)" → name: "Timer", ticker: "TIME" (remove "Launch" prefix)
- "Space Coin (SPACE)" → name: "Space Coin", ticker: "SPACE"

Pattern 2: "Launch/Create [called/named] Name"
- "Launch token called Moonshot" → name: "Moonshot", ticker: "MOON" (generate)
- "Create token named Solar" → name: "Solar", ticker: "SOLR" (generate)

Pattern 3: "Launch Name" (without called/named)
- "Launch Moonshot" → name: "Moonshot", ticker: "MOON" (generate)
- "Launch Space Token" → name: "Space Token", ticker: "SPTK" (generate)

Pattern 4: Ticker only
- "Launch ticker DOGE" → name: "DOGE", ticker: "DOGE"
- "Create MOON token" → name: "MOON", ticker: "MOON"

Image Extraction:
- Look for image URLs in the message context
- Accept IPFS URLs (ipfs://...) and HTTPS URLs (https://...)
- If attachment is present, set image to "attachment_provided"
- IMPORTANT: If only an image attachment is provided (no text), this is still valid coin launch information
- Return null if no valid image found

FEE RECEIVER EXTRACTION

Look for:
1. Usernames (starting with @), ENS names (.eth), wallet addresses (0x...)
2. Self-references: "me", "myself", "my address", "use my username", "just me" → mark as SELF_REFERENCE
3. Equal split indicators: "equal", "split equally", "same for everyone", etc.
4. Percentage splits: "alice 30%", "@bob 25%", "charlie.eth 40%", etc.
5. Multiple users: comma-separated or "and" separated lists

IMPORTANT: If no usernames/addresses/splits are found, set feeReceivers to null. Do not hallucinate.

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
  "feeReceivers": {
    "receivers": [
      {
        "identifier": "username_or_address_or_SELF_REFERENCE",
        "percentage": number_or_null,
        "type": "username|ens|address|self"
      }
    ] || null,
    "splitType": "equal|percentage|self_only" || null,
    "confidence": number_0_to_1
  }
}

Examples:

Token only:
"Launch DogeCoin (DOGE)" →
{
  "tokenDetails": {"name": "DogeCoin", "ticker": "DOGE", "image": null},
  "feeReceivers": {"receivers": null, "splitType": null, "confidence": 0}
}

Token + Fee Receivers:
"Launch Timer (TIME) and split fees with @alice and me" →
{
  "tokenDetails": {"name": "Timer", "ticker": "TIME", "image": null},
  "feeReceivers": {
    "receivers": [
      {"identifier": "@alice", "percentage": null, "type": "username"},
      {"identifier": "SELF_REFERENCE", "percentage": null, "type": "self"}
    ],
    "splitType": "equal",
    "confidence": 0.9
  }
}

Fee Receivers only:
"split with @bob 60% and me 40%" →
{
  "tokenDetails": {"name": null, "ticker": null, "image": null},
  "feeReceivers": {
    "receivers": [
      {"identifier": "@bob", "percentage": 60, "type": "username"},
      {"identifier": "SELF_REFERENCE", "percentage": 40, "type": "self"}
    ],
    "splitType": "percentage",
    "confidence": 0.9
  }
}

Image only (with attachment):
"" (empty message with image attachment) →
{
  "tokenDetails": {"name": null, "ticker": null, "image": "attachment_provided"},
  "feeReceivers": {"receivers": null, "splitType": null, "confidence": 0}
}

Extract launch details from the current message now:
`;

// Helper function to use the template
export function createLaunchExtractionPrompt(context: {
  message: string;
  hasAttachment?: boolean;
  attachmentType?: string;
  imageUrl?: string;
}): string {
  let prompt = launchDetailsExtractionTemplate;
  
  // Replace template variables
  prompt = prompt.replace('{{message}}', context.message);
  
  if (context.hasAttachment) {
    prompt = prompt.replace('{{#if hasAttachment}}', '').replace('{{/if}}', '');
    prompt = prompt.replace('{{attachmentType}}', context.attachmentType || 'unknown');
  } else {
    // Remove the attachment section
    prompt = prompt.replace(/{{#if hasAttachment}}[\s\S]*?{{\/if}}/g, '');
  }
  
  if (context.imageUrl) {
    prompt = prompt.replace('{{#if imageUrl}}', '').replace('{{/if}}', '');
    prompt = prompt.replace('{{imageUrl}}', context.imageUrl);
  } else {
    // Remove the image URL section
    prompt = prompt.replace(/{{#if imageUrl}}[\s\S]*?{{\/if}}/g, '');
  }
  
  return prompt;
}

// Type for the combined extraction result
export interface LaunchExtractionResult {
  tokenDetails: {
    name: string | null;
    ticker: string | null;
    image: string | null;
  };
  feeReceivers: {
    receivers: Array<{
      identifier: string;
      percentage: number | null;
      type: 'username' | 'ens' | 'address' | 'self';
    }> | null;
    splitType: 'equal' | 'percentage' | 'self_only' | null;
    confidence: number;
  };
} 