import type OpenAI from "openai";
import type { Character } from "../types";

// Character context generation helper
export function generateCharacterContext(character: Character): string {
  const selectedBio = character.bio
    .sort(() => 0.5 - Math.random())
    .slice(0, 3)
    .join(" ");
  const selectedLore = character.lore
    .sort(() => 0.5 - Math.random())
    .slice(0, 10)
    .join("\n");
  const selectedAdjective =
    character.adjectives[
      Math.floor(Math.random() * character.adjectives.length)
    ];
  const topicsString = `${character.name} is interested in ${character.topics.slice(0, 5).join(", ")}`;
  const styleDirections = [
    ...character.style.all,
    ...character.style.chat,
  ].join("\n");
  const messageExamples = character.messageExamples
    .sort(() => 0.5 - Math.random())
    .slice(0, 5)
    .map((ex) => ex.map((msg) => `${msg.user}: ${msg.content.text}`).join("\n"))
    .join("\n\n");

  return `
    # Character Profile
    Name: ${character.name}
    Bio: ${selectedBio}
    Personality: ${selectedAdjective}
    Interests: ${topicsString}

    # Background Lore
    ${selectedLore}

    # Style Guidelines
    ${styleDirections}

    # Example Conversations
    ${messageExamples}
  `;
}

// OpenAI interaction helpers
export async function getCharacterResponse({
  openai,
  character,
  prompt,
}: {
  openai: OpenAI;
  character: Character;
  prompt: string;
}): Promise<string> {
  const response = await openai.chat.completions.create({
    model: "gpt-4o",
    messages: [
      { role: "system", content: generateCharacterContext(character) },
      { role: "user", content: prompt },
    ],
  });
  return response.choices[0]?.message?.content || prompt;
}
