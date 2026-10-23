export interface ProviderIconModel {
  id?: string;
  provider?: string;
  label?: string;
}

export interface ProviderIcon {
  src: string;
  mono: boolean;
  name: string;
}

interface IconEntry {
  file: string;
  mono?: boolean;
}

const BASE = '/provider-icons';

const ICONS: Record<string, IconEntry> = {
  deepseek: { file: 'deepseek-color.svg' },
  zhipu: { file: 'zhipu-color.svg' },
  zai: { file: 'zai.svg', mono: true },
  openai: { file: 'openai.svg', mono: true },
  anthropic: { file: 'anthropic.svg', mono: true },
  gemini: { file: 'gemini-color.svg' },
  xai: { file: 'grok.svg', mono: true },
  groq: { file: 'groq.svg', mono: true },
  mistral: { file: 'mistral-color.svg' },
  kimi: { file: 'kimi-color.svg' },
  moonshot: { file: 'moonshot.svg', mono: true },
  minimax: { file: 'minimax-color.svg' },
  xiaomi: { file: 'xiaomimimo.svg', mono: true },
  bytedance: { file: 'bytedance-color.svg' },
  volcengine: { file: 'volcengine-color.svg' },
  qwen: { file: 'qwen-color.svg' },
  bailian: { file: 'bailian-color.svg' },
  hunyuan: { file: 'hunyuan-color.svg' },
  stepfun: { file: 'stepfun.svg', mono: true },
  longcat: { file: 'longcat-color.svg', mono: true },
  kling: { file: 'kling-color.svg' },
  jimeng: { file: 'jimeng-color.svg' },
  antling: { file: 'ant-ling.svg' },
  openrouter: { file: 'openrouter.svg', mono: true },
  opencode: { file: 'opencode.svg', mono: true },
  ollama: { file: 'ollama.svg', mono: true },
  huggingface: { file: 'huggingface-color.svg' },
  azure: { file: 'azure-color.svg' },
  bedrock: { file: 'amazon-bedrock.png' },
  cloudflare: { file: 'cloudflare-color.svg' },
  workersai: { file: 'workersai-color.svg' },
  vercel: { file: 'vercel.svg', mono: true },
  nvidia: { file: 'nvidia-color.svg' },
  cerebras: { file: 'cerebras-color.svg', mono: true },
  fireworks: { file: 'fireworks-color.svg' },
  together: { file: 'together-color.svg' },
  baai: { file: 'baai.svg', mono: true },
  copilot: { file: 'copilot-color.svg' },
};

const RULES: { icon: string; pattern: RegExp }[] = [
  { icon: 'deepseek', pattern: /deepseek/ },
  { icon: 'kimi', pattern: /(?:kimi|moonshot)/ },
  { icon: 'xiaomi', pattern: /(?:xiaomi|xiaomimimo|\bmimo\b)/ },
  { icon: 'zhipu', pattern: /(?:zhipu|chatglm|\bglm\b|glm-)/ },
  { icon: 'zai', pattern: /(?:z-?ai|zai-)/ },
  { icon: 'qwen', pattern: /(?:qwen|qwq|tongyi|dashscope)/ },
  { icon: 'bailian', pattern: /(?:bailian|aliyun|alibaba)/ },
  { icon: 'minimax', pattern: /(?:minimax|abab)/ },
  { icon: 'bytedance', pattern: /(?:bytedance|doubao|seedream|seed)/ },
  { icon: 'volcengine', pattern: /(?:volcengine|volc-|\bark\b)/ },
  { icon: 'hunyuan', pattern: /hunyuan/ },
  { icon: 'stepfun', pattern: /stepfun/ },
  { icon: 'longcat', pattern: /longcat/ },
  { icon: 'kling', pattern: /kling/ },
  { icon: 'jimeng', pattern: /jimeng/ },
  { icon: 'antling', pattern: /ant-?ling/ },
  { icon: 'opencode', pattern: /opencode/ },
  { icon: 'openrouter', pattern: /openrouter/ },
  { icon: 'openai', pattern: /(?:openai|chatgpt|\bgpt\b|gpt-|codex|\bo[1-4](?:-|$))/ },
  { icon: 'anthropic', pattern: /(?:anthropic|claude)/ },
  { icon: 'gemini', pattern: /(?:gemini|google|vertex|palm)/ },
  { icon: 'xai', pattern: /(?:grok|\bxai\b|x-ai)/ },
  { icon: 'groq', pattern: /groq/ },
  { icon: 'mistral', pattern: /(?:mistral|mixtral|codestral|magistral)/ },
  { icon: 'azure', pattern: /azure/ },
  { icon: 'bedrock', pattern: /(?:bedrock|amazon|aws)/ },
  { icon: 'cloudflare', pattern: /cloudflare/ },
  { icon: 'workersai', pattern: /(?:workersai|workers-ai)/ },
  { icon: 'vercel', pattern: /vercel/ },
  { icon: 'nvidia', pattern: /nvidia/ },
  { icon: 'cerebras', pattern: /cerebras/ },
  { icon: 'fireworks', pattern: /fireworks/ },
  { icon: 'together', pattern: /together/ },
  { icon: 'huggingface', pattern: /(?:huggingface|hf\.co|\bhf\b)/ },
  { icon: 'ollama', pattern: /ollama/ },
  { icon: 'baai', pattern: /\bbaai\b/ },
  { icon: 'copilot', pattern: /copilot/ },
];

function iconEntry(name: string): ProviderIcon | null {
  const entry = ICONS[name];
  if (!entry) return null;
  return { src: `${BASE}/${entry.file}`, mono: entry.mono === true, name };
}

export function providerIconFor(model?: ProviderIconModel | string | null): ProviderIcon | null {
  if (!model) return null;
  const values = typeof model === 'string'
    ? [model]
    : [model.id, model.provider, model.label];
  const haystack = values.filter(Boolean).join(' ').toLowerCase();
  if (!haystack) return null;

  for (const rule of RULES) {
    if (rule.pattern.test(haystack)) return iconEntry(rule.icon);
  }
  return null;
}
