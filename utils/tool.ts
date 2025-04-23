import type { Conversation } from "@xmtp/node-sdk";
import type OpenAI from "openai";
import type { ChatCompletionTool } from "openai/resources/chat/completions";
import { z } from "zod";
import type { Character } from "../types";
import { getCharacterResponse } from "./character";

type ZodObjectType = z.ZodObject<Record<string, z.ZodTypeAny>, "strip">;

type OpenAIFunctionParameters = {
  type: "object";
  properties: Record<
    string,
    | { type: string; description?: string }
    | { type: "array"; description?: string; items: { type: string } }
  >;
  required: string[];
};

export function zodToOpenAIParameters(
  schema: ZodObjectType,
): OpenAIFunctionParameters {
  const shape = schema._def.shape();
  const properties: Record<
    string,
    | { type: string; description?: string }
    | { type: "array"; description?: string; items: { type: string } }
  > = {};
  const required: string[] = [];

  for (const [key, value] of Object.entries(shape)) {
    if (!(value instanceof z.ZodType)) continue;

    let type = "string"; // default fallback
    let unwrappedType: z.ZodTypeAny = value;

    // Unwrap optional types to get the underlying type
    if (value instanceof z.ZodOptional) {
      unwrappedType = value.unwrap() as z.ZodTypeAny;
    } else {
      // If it's not optional, it's required
      required.push(key);
    }

    // Determine the type from the unwrapped value
    if (unwrappedType instanceof z.ZodString) type = "string";
    else if (unwrappedType instanceof z.ZodNumber) type = "number";
    else if (unwrappedType instanceof z.ZodBoolean) type = "boolean";
    else if (unwrappedType instanceof z.ZodArray) {
      type = "array";
      // Get the element type of the array
      const elementType = unwrappedType._def.type as z.ZodType;
      let itemType = "string"; // default
      if (elementType instanceof z.ZodString) itemType = "string";
      else if (elementType instanceof z.ZodNumber) itemType = "number";
      else if (elementType instanceof z.ZodBoolean) itemType = "boolean";

      properties[key] = {
        type,
        description: value.description,
        items: { type: itemType },
      } as { type: "array"; description?: string; items: { type: string } };
      continue;
    }

    properties[key] = {
      type,
      description: value.description,
    };
  }

  return {
    type: "object",
    properties,
    required,
  };
}

export const getTool = ({
  name,
  description,
  schema,
}: {
  name: string;
  description: string;
  schema: ZodObjectType;
}): ChatCompletionTool => {
  const parameters = zodToOpenAIParameters(schema);

  return {
    type: "function",
    function: {
      name,
      description,
      parameters,
    },
  };
};

export const invalidArgsResponse = async ({
  openai,
  character,
  conversation,
  validatedArgs,
}: {
  openai: OpenAI;
  character: Character;
  conversation: Conversation;
  validatedArgs: z.SafeParseError<unknown>;
}) => {
  const errorMessage = validatedArgs.error.errors
    .map((err) => `${err.path.join(".")}: ${err.message}`)
    .join(", ");

  const errorResponse = await getCharacterResponse({
    openai,
    character,
    prompt: `Tell the user their transaction failed due to invalid input: ${errorMessage}. Ask them to try again with valid values.`,
  });
  await conversation.send(errorResponse);
};
