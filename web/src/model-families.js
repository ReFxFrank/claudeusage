// Pure model-family recognition (no JSX) so it can be unit-tested in Node.
// Classify any model string into a provider family; a model only appears in the
// UI if it's in the logs Pulse reads, so families light up strictly on use.

export function modelFamily(model) {
  const m = String(model || '').toLowerCase();
  if (/claude|anthropic|^fable|^opus|^sonnet|^haiku/.test(m)) return 'claude';
  if (/^gpt|^o\d|codex|chatgpt|davinci|^text-/.test(m)) return 'openai';
  if (/gemini|^gemma|palm|bison/.test(m)) return 'google';
  if (/deepseek/.test(m)) return 'deepseek';
  if (/llama|^meta/.test(m)) return 'meta';
  if (/grok/.test(m)) return 'xai';
  if (/qwen/.test(m)) return 'qwen';
  if (/mistral|mixtral|codestral|ministral/.test(m)) return 'mistral';
  if (/command|cohere/.test(m)) return 'cohere';
  return 'other';
}

export const FAMILY_META = {
  claude:   { label: 'Anthropic', color: '#D97757' },
  openai:   { label: 'OpenAI',    color: '#0E9C7E' },
  google:   { label: 'Google',    color: '#4285F4' },
  deepseek: { label: 'DeepSeek',  color: '#4D6BFE' },
  meta:     { label: 'Meta',      color: '#0668E1' },
  xai:      { label: 'xAI',       color: '#c7c9cc' },
  qwen:     { label: 'Qwen',      color: '#7A6FF0' },
  mistral:  { label: 'Mistral',   color: '#EE792F' },
  cohere:   { label: 'Cohere',    color: '#39A0A0' },
  other:    { label: 'Model',     color: '#8a8f98' },
};
