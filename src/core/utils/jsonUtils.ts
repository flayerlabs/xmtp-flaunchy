/**
 * Safely parse JSON from OpenAI responses that may contain markdown formatting
 * and additional text before/after the JSON block
 */
export function safeParseJSON<T = any>(content: string): T {
  if (!content || typeof content !== "string") {
    throw new Error("Invalid content provided for JSON parsing");
  }

  // First, try to extract JSON from markdown code blocks
  const jsonBlockRegex = /```(?:json)?\s*([\s\S]*?)\s*```/;
  const match = content.match(jsonBlockRegex);

  if (match) {
    // Found a code block, extract the JSON content
    const jsonContent = match[1].trim();
    try {
      return JSON.parse(jsonContent);
    } catch (error) {
      console.error("Failed to parse JSON from code block:", {
        original: content.substring(0, 200) + "...",
        extracted: jsonContent.substring(0, 200) + "...",
        error: error instanceof Error ? error.message : String(error),
      });
      throw new Error(
        `Failed to parse JSON from code block: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    }
  }

  // Fallback: try to parse the entire content as JSON (for cases without markdown)
  let cleanContent = content.trim();

  // Remove any remaining backticks at the start/end
  cleanContent = cleanContent.replace(/^`+|`+$/g, "");

  try {
    return JSON.parse(cleanContent);
  } catch (error) {
    // If that fails, try to find JSON-like content using heuristics
    const jsonStartRegex = /\{[\s\S]*\}/;
    const jsonMatch = cleanContent.match(jsonStartRegex);

    if (jsonMatch) {
      try {
        return JSON.parse(jsonMatch[0]);
      } catch (innerError) {
        // Still failed, give up
      }
    }

    console.error("Failed to parse JSON after all attempts:", {
      original: content.substring(0, 200) + "...",
      cleaned: cleanContent.substring(0, 200) + "...",
      error: error instanceof Error ? error.message : String(error),
    });
    throw new Error(
      `Failed to parse JSON response: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
  }
}

/**
 * Clean ticker symbol by removing "$" prefix if present
 * @param ticker - The ticker symbol to clean
 * @returns The cleaned ticker symbol without "$" prefix
 */
export function cleanTickerSymbol(ticker?: string | null): string | undefined {
  if (!ticker || typeof ticker !== "string") {
    return undefined;
  }

  // Remove leading "$" character if present
  const cleaned = ticker.startsWith("$") ? ticker.slice(1) : ticker;

  // Return undefined if the result is empty (was just "$")
  return cleaned.length > 0 ? cleaned : undefined;
}
