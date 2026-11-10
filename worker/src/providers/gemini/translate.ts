// ALL vendor-specific shapes live in this folder. Nothing else in the codebase may import from here
// except src/providers/index.ts (the composition root).
import type { FinishReason, GenerateRequest, JsonSchema, Message, ToolCall, Usage } from '../types';

type GPart = Record<string, unknown>;
export interface GContent { role: 'user' | 'model'; parts: GPart[] }

const TYPE_MAP: Record<JsonSchema['type'], string> = {
  object: 'OBJECT', array: 'ARRAY', string: 'STRING', number: 'NUMBER', integer: 'INTEGER', boolean: 'BOOLEAN',
};

export function toGeminiSchema(s: JsonSchema): Record<string, unknown> {
  const out: Record<string, unknown> = { type: TYPE_MAP[s.type] };
  if (s.description) out.description = s.description;
  if (s.nullable) out.nullable = true;
  if (s.enum) out.enum = s.enum.map(String);
  if (s.items) out.items = toGeminiSchema(s.items);
  if (s.properties) {
    out.properties = Object.fromEntries(Object.entries(s.properties).map(([k, v]) => [k, toGeminiSchema(v)]));
    if (s.required?.length) out.required = s.required;
  }
  return out;
}

export function toGeminiContents(messages: Message[]): { systemInstruction?: { parts: GPart[] }; contents: GContent[] } {
  const system: GPart[] = [];
  const contents: GContent[] = [];
  for (const m of messages) {
    if (m.role === 'system') {
      for (const p of m.parts) if (p.type === 'text') system.push({ text: p.text });
      continue;
    }
    const parts: GPart[] = [];
    for (const p of m.parts) {
      if (p.type === 'text') parts.push({ text: p.text });
      else if (p.type === 'tool_call') parts.push({ functionCall: { name: p.name, args: p.args } });
      else parts.push({
        functionResponse: {
          name: p.name,
          response: typeof p.result === 'object' && p.result !== null && !Array.isArray(p.result) ? p.result : { result: p.result },
        },
      });
    }
    const role: GContent['role'] = m.role === 'assistant' ? 'model' : 'user';   // tool results travel as user turns
    const last = contents[contents.length - 1];
    if (last && last.role === role) last.parts.push(...parts); else contents.push({ role, parts });
  }
  return { systemInstruction: system.length ? { parts: system } : undefined, contents };
}

export function buildGenerateBody(req: GenerateRequest): Record<string, unknown> {
  const { systemInstruction, contents } = toGeminiContents(req.messages);
  const generationConfig: Record<string, unknown> = { maxOutputTokens: req.maxOutputTokens };
  if (req.temperature !== undefined) generationConfig.temperature = req.temperature;
  if (req.outputSchema) {
    generationConfig.responseMimeType = 'application/json';
    generationConfig.responseSchema = toGeminiSchema(req.outputSchema);
  }
  // reasoningEffort is intentionally NOT mapped yet: the knob differs between model generations and an
  // unsupported field is a hard 400. Revisit at the first live conformance run.
  const body: Record<string, unknown> = { contents, generationConfig };
  if (systemInstruction) body.systemInstruction = systemInstruction;
  if (req.tools?.length) {
    body.tools = [{ functionDeclarations: req.tools.map(t => ({ name: t.name, description: t.description, parameters: toGeminiSchema(t.inputSchema) })) }];
  }
  return body;
}

const BLOCKED = new Set(['SAFETY', 'RECITATION', 'BLOCKLIST', 'PROHIBITED_CONTENT', 'SPII', 'IMAGE_SAFETY']);

export function parseGenerateResponse(json: any, nextId: () => string): {
  text?: string; toolCalls: ToolCall[]; finishReason: FinishReason; usage: Usage;
} {
  const u = json?.usageMetadata ?? {};
  const reasoning = u.thoughtsTokenCount ?? 0;
  const usage: Usage = {
    inputTokens: u.promptTokenCount ?? 0,
    outputTokens: (u.candidatesTokenCount ?? 0) + reasoning,   // reasoning tokens are billed as output
    cachedInputTokens: u.cachedContentTokenCount ?? 0,
    reasoningTokens: reasoning,
  };
  if (json?.promptFeedback?.blockReason) return { toolCalls: [], finishReason: 'blocked', usage };
  const cand = json?.candidates?.[0];
  if (!cand) return { toolCalls: [], finishReason: 'error', usage };
  const parts: GPart[] = cand.content?.parts ?? [];
  const textParts = parts.filter(p => typeof p.text === 'string' && !p.thought).map(p => p.text as string);
  const toolCalls: ToolCall[] = parts
    .filter(p => p.functionCall)
    .map(p => { const fc = p.functionCall as { id?: string; name: string; args?: Record<string, unknown> };
      return { id: fc.id ?? nextId(), name: fc.name, args: fc.args ?? {} }; });
  const fr: string = cand.finishReason ?? 'STOP';
  let finishReason: FinishReason;
  if (BLOCKED.has(fr)) finishReason = 'blocked';
  else if (fr === 'MAX_TOKENS') finishReason = 'length';
  else if (fr === 'STOP') finishReason = toolCalls.length ? 'tool_calls' : 'stop';
  else finishReason = 'error';
  return { text: textParts.length ? textParts.join('') : undefined, toolCalls, finishReason, usage };
}
