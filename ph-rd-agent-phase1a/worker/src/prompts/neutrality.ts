// The one allow-listed place that names vendors/models: it exists to FORBID them in prompt files.
// Prompt files are written by the R&D Intelligence Architect and must work on any model.
export interface NeutralityRule { code: string; pattern: RegExp; message: string; severity: 'error' | 'warning' }

export const NEUTRALITY_RULES: NeutralityRule[] = [
  { code: 'vendor_name', severity: 'error', pattern: /\b(gemini|gpt-?\d[\w.-]*|chatgpt|openai|anthropic|claude|llama[- ]?\d*|mistral)\b/i,
    message: 'mentions a specific vendor or model; prompt files must be provider-neutral' },
  { code: 'chat_template_token', severity: 'error', pattern: /(<\|[a-z_]+\|>|\[\/?INST\]|<<\/?SYS>>|<start_of_turn>|<end_of_turn>|<\/?s>)/i,
    message: 'contains a provider chat-template token' },
  { code: 'tool_syntax', severity: 'error', pattern: /(<function_calls>|<tool_use>|"tool_calls"\s*:|functionCall|function_call\b)/i,
    message: 'contains provider tool/function-calling syntax; tools are defined by the platform' },
  { code: 'json_mode_instruction', severity: 'warning', pattern: /\b(json mode|response_format|responseMimeType|respond (?:only )?(?:in|with) json)\b/i,
    message: 'instructs a JSON output mode; the platform enforces the output schema, so this is unnecessary' },
];
