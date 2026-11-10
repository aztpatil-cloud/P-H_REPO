// Provider-neutral types. These are OUR formats; adapters translate to and from vendor formats.
// Nothing in this file (or outside src/providers/<adapter>/) may mention a vendor or model name.

export type Role = 'system' | 'user' | 'assistant' | 'tool';

export type Part =
  | { type: 'text'; text: string }
  | { type: 'tool_call'; id: string; name: string; args: Record<string, unknown> }
  | { type: 'tool_result'; callId: string; name: string; result: unknown };

export interface Message { role: Role; parts: Part[] }

/** The JSON-Schema subset every adapter must be able to translate. No $ref, oneOf, anyOf. */
export interface JsonSchema {
  type: 'object' | 'array' | 'string' | 'number' | 'integer' | 'boolean';
  description?: string;
  properties?: Record<string, JsonSchema>;
  required?: string[];
  items?: JsonSchema;
  enum?: Array<string | number>;
  nullable?: boolean;
}

export interface ToolDef { name: string; description: string; inputSchema: JsonSchema }
export interface ToolCall { id: string; name: string; args: Record<string, unknown> }

export interface ModelCapabilities {
  contextTokens: number;
  maxOutputTokens: number;
  structuredOutput: boolean;
  toolCalling: boolean;
  embeddings: boolean;
  /** true when hidden reasoning tokens are billed as output tokens */
  reasoningBilledAsOutput: boolean;
}

/** What the rest of the system passes around. providerModel is meaningful only to that provider's adapter. */
export interface ModelRef {
  registryId: string;
  provider: string;
  providerModel: string;
  capabilities: ModelCapabilities;
}

export interface GenerateRequest {
  model: ModelRef;
  messages: Message[];
  tools?: ToolDef[];
  outputSchema?: JsonSchema;
  maxOutputTokens: number;
  temperature?: number;
  /** Neutral knob; each adapter maps it or ignores it. */
  reasoningEffort?: 'low' | 'medium' | 'high';
  signal?: AbortSignal;
}

export type FinishReason = 'stop' | 'length' | 'tool_calls' | 'blocked' | 'error';

export interface Usage {
  inputTokens: number;
  /** Billed output tokens, INCLUDING reasoning tokens. */
  outputTokens: number;
  cachedInputTokens?: number;
  /** Informational subset of outputTokens. */
  reasoningTokens?: number;
}

export interface GenerateResult {
  text?: string;
  structured?: unknown;
  toolCalls: ToolCall[];
  finishReason: FinishReason;
  usage: Usage;
  latencyMs: number;
  /** transport/server retries performed */
  retries: number;
  /** invalid-structured-output attempts that were retried */
  schemaFailures: number;
}

export interface TokenCount { inputTokens: number; exact: boolean }

export interface EmbedRequest { model: ModelRef; inputs: string[]; purpose?: 'document' | 'query'; signal?: AbortSignal }
export interface EmbedResult { vectors: number[][]; dimension: number; usage: { inputTokens: number } }

export interface Price { inputUsdPerM: number; outputUsdPerM: number; cachedInputUsdPerM?: number }

/** What a provider says it offers, in neutral terms; used by the setup page so nobody types model names from memory. */
export interface AvailableModel { providerModel: string; displayName: string; contextTokens: number | null; maxOutputTokens: number | null; supportsGeneration: boolean; supportsEmbeddings: boolean }

export interface ModelProvider {
  listModels?(): Promise<AvailableModel[]>;
  readonly providerKey: string;
  generate(req: GenerateRequest): Promise<GenerateResult>;
  embed(req: EmbedRequest): Promise<EmbedResult>;
  countTokens(req: GenerateRequest): Promise<TokenCount>;
  getPrice(model: ModelRef, at: Date): Price;
}
