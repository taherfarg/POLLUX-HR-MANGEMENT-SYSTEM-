import { GoogleGenAI, type Content } from '@google/genai';
import { env } from '../../config/env';

/**
 * The one place the assistant talks to Gemini. Kept behind a small function
 * type so tests can stand in a scripted model and exercise every tool, every
 * permission and the whole loop without a key or a network.
 */

export interface ModelTool {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface ModelRequest {
  systemInstruction: string;
  contents: Content[];
  tools: ModelTool[];
}

export interface ModelReply {
  /** The model's turn as it gave it, to send back on the next round. */
  content: Content;
  functionCalls: { id?: string; name: string; args: Record<string, unknown> }[];
  text: string;
}

export type AssistantModel = (request: ModelRequest) => Promise<ModelReply>;

let override: AssistantModel | null = null;
let client: GoogleGenAI | null = null;

const gemini: AssistantModel = async (request) => {
  client ??= new GoogleGenAI({ apiKey: env.GOOGLE_API_KEY });
  const response = await client.models.generateContent({
    model: env.GOOGLE_AI_MODEL,
    contents: request.contents,
    config: {
      systemInstruction: request.systemInstruction,
      // The last round goes without tools, so the model has to answer.
      ...(request.tools.length
        ? {
            tools: [
              {
                functionDeclarations: request.tools.map((tool) => ({
                  name: tool.name,
                  description: tool.description,
                  parametersJsonSchema: tool.parameters,
                })),
              },
            ],
          }
        : {}),
      // Facts from tools, not invention: keep it steady.
      temperature: 0.2,
      maxOutputTokens: 4096,
      // Enough thinking to turn "last week" into dates and pick the right tool.
      thinkingConfig: { thinkingBudget: 1024 },
    },
  });
  return {
    content: response.candidates?.[0]?.content ?? { role: 'model', parts: [] },
    functionCalls: (response.functionCalls ?? []).map((call) => ({
      id: call.id,
      name: call.name ?? '',
      args: (call.args ?? {}) as Record<string, unknown>,
    })),
    text: response.text ?? '',
  };
};

/** The model in use, or null when no Google key is configured. */
export function assistantModel(): AssistantModel | null {
  if (override) return override;
  return env.GOOGLE_API_KEY ? gemini : null;
}

/** Tests only: replace the model with a scripted one, or restore with null. */
export function setAssistantModel(model: AssistantModel | null): void {
  override = model;
}
