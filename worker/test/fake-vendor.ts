// A tiny stand-in for the vendor's HTTP API. It implements just enough behaviour to exercise the adapter
// translation end to end. It is NOT proof the real service behaves this way: the live run is.
export function synth(s: any): any {
  const t = String(s.type).toLowerCase();                       // the adapter sends the vendor's upper-case type names
  if (t === 'object') return Object.fromEntries(Object.entries(s.properties ?? {}).map(([k, v]) => [k, synth(v)]));
  if (t === 'array') return [synth(s.items)]; if (s.enum) return s.enum[0];
  return ({ string: 'x', integer: 1, number: 1.5, boolean: true } as any)[t] ?? 'x';
}
export function fakeVendor(validKey = 'good-key') {
  return (async (url: string, init: any) => {
    if (init.headers['x-goog-api-key'] !== validKey) return new Response(JSON.stringify({ error: { code: 400, message: 'API key not valid. Please pass a valid API key.', status: 'INVALID_ARGUMENT' } }), { status: 400 });
    const body = JSON.parse(init.body); const flat = JSON.stringify(body.contents ?? ''); const chars = flat.length + JSON.stringify(body.systemInstruction ?? '').length;
    const tokens = Math.ceil(chars / 4) + 5;
    if (url.endsWith(':countTokens')) return new Response(JSON.stringify({ totalTokens: tokens }));
    if (url.endsWith(':batchEmbedContents')) return new Response(JSON.stringify({ embeddings: body.requests.map(() => ({ values: [0.1, 0.2, 0.3, 0.4] })) }));
    const usage = { promptTokenCount: tokens, candidatesTokenCount: 10 };
    const reply = (parts: any[], finishReason = 'STOP') => new Response(JSON.stringify({ candidates: [{ content: { parts }, finishReason }], usageMetadata: usage }));
    const sys = JSON.stringify(body.systemInstruction ?? '');
    if (flat.includes('functionResponse')) return reply([{ text: 'The number is 3.14159.' }]);
    if (body.tools && /use the get_number tool/i.test(flat)) return reply([{ functionCall: { name: 'get_number', args: { topic: 'pi' } } }]);
    if (body.generationConfig?.responseSchema) return reply([{ text: JSON.stringify(synth(body.generationConfig.responseSchema)) }]);
    if (/BANANA/.test(sys)) return reply([{ text: 'BANANA' }]);
    if (body.generationConfig?.maxOutputTokens <= 32) return reply([{ text: 'Rivers begin' }], 'MAX_TOKENS');
    return reply([{ text: 'Hello there!' }]);
  }) as unknown as typeof fetch;
}
