import { FlowContext } from "../types/FlowContext";

export class LLMResponse {
  // send prompt and get a response from the LLM
  public static async getResponse({
    context,
    prompt,
    max_tokens,
  }: {
    context: FlowContext;
    prompt: string;
    max_tokens?: number;
  }): Promise<string | undefined> {
    const response = await context.openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [{ role: "user", content: prompt }],
      temperature: 0.1,
      max_tokens,
    });

    return response.choices[0]?.message?.content?.trim();
  }
}
