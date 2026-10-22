import fs from "node:fs";
import path from "node:path";
import { getSupportedThinkingLevels } from "@earendil-works/pi-ai/models";
import { getBuiltinModels, getBuiltinProviders } from "@earendil-works/pi-ai/providers/all";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import {
  PI_AGENT_DIR,
  isConfigured,
  mask,
  readEnv,
  writeJson,
  type ThinkingLevel,
} from "../config.js";

type PiModel = NonNullable<ReturnType<ModelRuntime["getModel"]>>;

export interface PiModelInfo {
  id: string;
  label: string;
  provider: string;
  default: boolean;
  reasoning: boolean;
  thinkingLevels: ThinkingLevel[];
}

export const PI_PROVIDER_APIS = [
  "openai-completions",
  "openai-responses",
  "anthropic-messages",
  "google-generative-ai",
  "azure-openai-responses",
  "mistral-conversations",
  "bedrock-converse-stream",
  "openai-codex-responses",
  "google-vertex",
  "pi-messages",
] as const;

export interface PiProviderSummary {
  id: string;
  name: string;
  baseUrl: string;
  api: string;
  models: string[];
  keyMasked: string;
  managed: boolean;
}

export interface PiProviderInput {
  id: string;
  name?: string;
  baseUrl: string;
  api: string;
  apiKey?: string;
  models: string[];
}

export interface PiProviderModelsResult {
  baseUrl: string;
  models: string[];
  fetchedAt: number;
}

const DIRECT_PROVIDER = "easel-direct";
const PROVIDER_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const PROVIDER_APIS = new Set<string>(PI_PROVIDER_APIS);

function modelsPath(): string {
  return path.join(PI_AGENT_DIR, "models.json");
}

function authPath(): string {
  return path.join(PI_AGENT_DIR, "auth.json");
}

function removeManagedDirectProvider(): void {
  const file = modelsPath();
  if (!fs.existsSync(file)) return;
  let data: Record<string, unknown>;
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return;
    data = parsed as Record<string, unknown>;
  } catch {
    return;
  }
  const providers =
    data.providers && typeof data.providers === "object" && !Array.isArray(data.providers)
      ? (data.providers as Record<string, unknown>)
      : {};
  if (!Object.prototype.hasOwnProperty.call(providers, DIRECT_PROVIDER)) return;
  delete providers[DIRECT_PROVIDER];
  data.providers = providers;
  writeJson(file, data);
}

/**
 * Mirror Easel's independent model endpoint into pi's models.json.
 *
 * Pi already understands its built-in providers and their environment variables.
 * Easel's historical `.env` contract is `EASEL_DIRECT_API_*`; expose it as one
 * extra OpenAI-compatible provider so an existing installation keeps working.
 */
export function ensurePiModelsConfig(): void {
  const env = readEnv();
  const baseUrl = (env.EASEL_DIRECT_API_BASE_URL ?? "").trim().replace(/\/+$/, "");
  const modelId = (env.EASEL_DIRECT_API_MODEL ?? "").trim();
  if (!baseUrl || !modelId) {
    removeManagedDirectProvider();
    return;
  }

  fs.mkdirSync(PI_AGENT_DIR, { recursive: true });
  const file = modelsPath();
  let data: Record<string, unknown> = {};
  if (fs.existsSync(file)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) data = parsed;
    } catch {
      // A malformed user file must not be silently replaced: pi can still explain it.
      return;
    }
  }
  const providers =
    data.providers && typeof data.providers === "object" && !Array.isArray(data.providers)
      ? (data.providers as Record<string, unknown>)
      : {};
  const key = (env.EASEL_DIRECT_API_KEY ?? "").trim();
  const keyHeader = (env.EASEL_DIRECT_API_KEY_HEADER ?? "").trim();
  const previous = providers[DIRECT_PROVIDER];
  const previousObj =
    previous && typeof previous === "object" && !Array.isArray(previous)
      ? (previous as Record<string, unknown>)
      : {};
  const previousHeaders =
    previousObj.headers && typeof previousObj.headers === "object" && !Array.isArray(previousObj.headers)
      ? (previousObj.headers as Record<string, string>)
      : {};
  const headers = keyHeader && isConfigured(key) ? { ...previousHeaders, [keyHeader]: key } : {};
  const previousModels = Array.isArray(previousObj.models)
    ? (previousObj.models as Array<Record<string, unknown>>)
    : [];
  const modelEntry = { ...(previousModels.find((item) => item?.id === modelId) ?? {}), id: modelId, name: modelId };
  const next: Record<string, unknown> = {
    ...previousObj,
    baseUrl,
    api: "openai-completions",
    apiKey: isConfigured(key) ? key : "easel-local",
    models: [modelEntry],
  };
  if (Object.keys(headers).length) next.headers = headers;
  else delete next.headers;
  providers[DIRECT_PROVIDER] = next;
  data.providers = providers;
  if (!data.$schema) data.$schema = "https://pi.dev/schemas/models.schema.json";
  writeJson(file, data);
}

function readModelsDocument(): Record<string, unknown> {
  const file = modelsPath();
  if (!fs.existsSync(file)) return { providers: {} };
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    throw new Error(`pi 的 models.json 不是合法 JSON：${file}`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`pi 的 models.json 顶层必须是对象：${file}`);
  }
  const data = parsed as Record<string, unknown>;
  const providers = data.providers;
  if (providers !== undefined && (!providers || typeof providers !== "object" || Array.isArray(providers))) {
    throw new Error(`pi 的 models.json providers 必须是对象：${file}`);
  }
  if (!data.providers) data.providers = {};
  return data;
}

function providersObject(data: Record<string, unknown>): Record<string, Record<string, unknown>> {
  const providers = data.providers;
  if (!providers || typeof providers !== "object" || Array.isArray(providers)) return {};
  return providers as Record<string, Record<string, unknown>>;
}

function providerSummary(
  id: string,
  raw: Record<string, unknown>,
  managed: boolean,
): PiProviderSummary {
  const rawModels = Array.isArray(raw.models) ? raw.models : [];
  const models = rawModels
    .map((item) => (item && typeof item === "object" ? String((item as Record<string, unknown>).id ?? "").trim() : ""))
    .filter(Boolean);
  return {
    id,
    name: typeof raw.name === "string" && raw.name.trim() ? raw.name.trim() : id,
    baseUrl: typeof raw.baseUrl === "string" ? raw.baseUrl : "",
    api: typeof raw.api === "string" && raw.api.trim() ? raw.api.trim() : "openai-completions",
    models,
    keyMasked: mask(typeof raw.apiKey === "string" ? raw.apiKey : undefined),
    managed,
  };
}

export function piProviders(): PiProviderSummary[] {
  const data = readModelsDocument();
  return Object.entries(providersObject(data))
    .map(([id, raw]) => {
      const provider = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
      return providerSummary(id, provider, id === DIRECT_PROVIDER);
    })
    .sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
}

export function savePiProvider(input: PiProviderInput): PiProviderSummary {
  const id = String(input.id ?? "").trim();
  if (!PROVIDER_ID.test(id)) {
    throw new Error("供应商 ID 只能包含字母、数字、点、下划线和短横线（最多 64 个字符）");
  }
  if (id === DIRECT_PROVIDER) {
    throw new Error("easel-direct 由 .env 的 EASEL_DIRECT_API_* 管理，请使用其它供应商 ID");
  }
  const baseUrl = String(input.baseUrl ?? "").trim().replace(/\/+$/, "");
  try {
    const parsed = new URL(baseUrl);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw new Error("bad protocol");
  } catch {
    throw new Error("Base URL 必须是合法的 http(s) 地址");
  }
  const api = String(input.api ?? "").trim();
  if (!PROVIDER_APIS.has(api)) throw new Error(`不支持的 pi API 类型：${api || "（空）"}`);
  const models = [...new Set(
    (Array.isArray(input.models) ? input.models : [])
      .map((item) => String(item ?? "").trim())
      .filter(Boolean),
  )];
  if (!models.length) throw new Error("至少填写一个模型 ID");
  if (models.length > 100) throw new Error("单个供应商最多配置 100 个模型");
  const key = String(input.apiKey ?? "").trim();
  if (/[\r\n]/.test(key)) throw new Error("API Key 不能包含换行");
  const name = String(input.name ?? "").trim().slice(0, 80);

  const data = readModelsDocument();
  const providers = providersObject(data);
  const previousValue = providers[id];
  const previous =
    previousValue && typeof previousValue === "object" && !Array.isArray(previousValue) ? previousValue : {};
  const previousModels = Array.isArray(previous.models)
    ? (previous.models as Array<Record<string, unknown>>)
    : [];
  const modelEntries = models.map((modelId) => {
    const prior = previousModels.find((item) => item && String(item.id ?? "") === modelId);
    const priorName = typeof prior?.name === "string" && prior.name.trim() ? prior.name : modelId;
    return { ...(prior && typeof prior === "object" ? prior : {}), id: modelId, name: priorName };
  });
  const next: Record<string, unknown> = {
    ...previous,
    name: name || (typeof previous.name === "string" && previous.name.trim()) || id,
    baseUrl,
    api,
    models: modelEntries,
  };
  if (key) next.apiKey = key;
  providers[id] = next;
  data.providers = providers;
  if (!data.$schema) data.$schema = "https://pi.dev/schemas/models.schema.json";
  writeJson(modelsPath(), data);
  return providerSummary(id, next, false);
}

export function deletePiProvider(idInput: string): boolean {
  const id = String(idInput ?? "").trim();
  if (!PROVIDER_ID.test(id)) throw new Error("供应商 ID 无效");
  if (id === DIRECT_PROVIDER) {
    throw new Error("easel-direct 由 .env 管理，不能在这里删除");
  }
  const data = readModelsDocument();
  const providers = providersObject(data);
  if (!Object.prototype.hasOwnProperty.call(providers, id)) return false;
  delete providers[id];
  data.providers = providers;
  writeJson(modelsPath(), data);
  return true;
}

function expandApiKey(value: string): string {
  const raw = value.trim();
  if (!raw) return "";
  if (raw.startsWith("$")) return (readEnv()[raw.slice(1)] ?? "").trim();
  return raw;
}

/** Resolve the key stored in models.json for a saved provider (supports $ENV refs). */
export function savedPiProviderKey(idInput: string): string {
  const id = String(idInput ?? "").trim();
  if (!PROVIDER_ID.test(id)) return "";
  try {
    const raw = providersObject(readModelsDocument())[id];
    if (!raw) return "";
    return expandApiKey(typeof raw.apiKey === "string" ? raw.apiKey : "");
  } catch {
    return "";
  }
}

/**
 * Fetch the model catalog from a provider before it is saved.
 *
 * OpenAI-compatible and Anthropic endpoints expose GET /models; Google exposes
 * the same path with an API key query parameter. Providers without a portable
 * catalog endpoint ask the user to enter model IDs manually.
 */
export async function fetchPiProviderModels(input: {
  id?: string;
  baseUrl: string;
  api: string;
  apiKey?: string;
}): Promise<PiProviderModelsResult> {
  const baseUrl = String(input.baseUrl ?? "").trim().replace(/\/+$/, "");
  let url: URL;
  try {
    url = new URL(`${baseUrl}/models`);
    if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("bad protocol");
  } catch {
    throw new Error("Base URL 必须是合法的 http(s) 地址");
  }

  const api = String(input.api ?? "").trim();
  if (api === "azure-openai-responses") {
    throw new Error("Azure OpenAI 不支持自动拉取模型，请手动填写模型 ID");
  }
  if (api === "bedrock-converse-stream" || api === "google-vertex" || api === "pi-messages") {
    throw new Error(`该 API 类型（${api}）不支持自动拉取模型，请手动填写模型 ID`);
  }

  const key = expandApiKey(String(input.apiKey ?? "").trim()) || savedPiProviderKey(input.id ?? "");
  const headers: Record<string, string> = { Accept: "application/json" };
  if (api === "anthropic-messages") {
    if (key) headers["x-api-key"] = key;
    headers["anthropic-version"] = "2023-06-01";
  } else if (api === "google-generative-ai") {
    if (key) url.searchParams.set("key", key);
  } else if (key) {
    headers.Authorization = `Bearer ${key}`;
  }

  let response: Response;
  try {
    response = await fetch(url, {
      headers,
      signal: AbortSignal.timeout(20_000),
      redirect: "follow",
    });
  } catch (error) {
    throw new Error(`无法连接模型列表端点：${error instanceof Error ? error.message : String(error)}`);
  }
  if (!response.ok) {
    const hint = response.status === 401 || response.status === 403 ? "，请检查 API Key" : "";
    throw new Error(`模型列表请求失败：HTTP ${response.status}${hint}`);
  }

  const payload = (await response.json()) as unknown;
  const models = new Set<string>();
  const add = (value: unknown) => {
    if (typeof value === "string") {
      const id = value.trim().replace(/^models\//, "");
      if (id) models.add(id);
      return;
    }
    if (!value || typeof value !== "object" || Array.isArray(value)) return;
    const item = value as Record<string, unknown>;
    const id = item.id ?? item.name;
    if (typeof id === "string") {
      const normalized = id.trim().replace(/^models\//, "");
      if (normalized) models.add(normalized);
    }
  };
  if (Array.isArray(payload)) {
    payload.forEach(add);
  } else if (payload && typeof payload === "object") {
    const data = payload as Record<string, unknown>;
    if (Array.isArray(data.data)) data.data.forEach(add);
    if (Array.isArray(data.models)) data.models.forEach(add);
  }

  return {
    baseUrl,
    models: [...models].sort((a, b) => a.localeCompare(b)),
    fetchedAt: Date.now(),
  };
}

export async function createModelRuntime(): Promise<ModelRuntime> {
  ensurePiModelsConfig();
  return ModelRuntime.create({
    authPath: authPath(),
    modelsPath: modelsPath(),
    allowModelNetwork: false,
  });
}

export function resolveConfiguredModel(runtime: ModelRuntime, configured: string): PiModel | undefined {
  const value = configured.trim();
  if (!value) {
    const env = readEnv();
    const direct = (env.EASEL_DIRECT_API_MODEL ?? "").trim();
    if (direct) {
      const match = runtime.getModel(DIRECT_PROVIDER, direct);
      if (match) return match;
    }
    return undefined;
  }
  const slash = value.indexOf("/");
  if (slash <= 0) return undefined;
  return runtime.getModel(value.slice(0, slash), value.slice(slash + 1));
}

const BUILTIN_PROVIDER_IDS = new Set<string>(getBuiltinProviders());
const BUILTIN_PROVIDER_PRIORITY = [
  "deepseek",
  "zai",
  "zai-coding-cn",
  "opencode",
  "opencode-go",
  "openrouter",
  "anthropic",
  "openai",
  "google",
  "google-vertex",
  "mistral",
  "xai",
  "moonshotai",
  "moonshotai-cn",
  "minimax",
  "minimax-cn",
  "nvidia",
  "fireworks",
  "together",
  "huggingface",
  "cloudflare-workers-ai",
  "vercel-ai-gateway",
  "qwen-token-plan",
  "qwen-token-plan-cn",
  "qwen-token-plan-individual",
  "xiaomi",
];
const BUILTIN_PROVIDER_RANK = new Map(BUILTIN_PROVIDER_PRIORITY.map((id, index) => [id, index]));
const THINKING_COMPAT_KEYS = [
  "supportsReasoningEffort",
  "requiresThinkingAsText",
  "requiresReasoningContentOnAssistantMessages",
  "thinkingFormat",
  "chatTemplateKwargs",
  "chatTemplateArgs",
  "thinkingTokenBudgetField",
  "supportsThinkingTokenBudget",
] as const;

interface BuiltinCatalogEntry {
  provider: string;
  models: PiModel[];
}

let builtinCatalog: BuiltinCatalogEntry[] | undefined;

function builtinCatalogEntries(): BuiltinCatalogEntry[] {
  if (!builtinCatalog) {
    builtinCatalog = getBuiltinProviders()
      .map((provider) => ({
        provider,
        models: getBuiltinModels(provider) as PiModel[],
      }))
      .sort(
        (a, b) =>
          (BUILTIN_PROVIDER_RANK.get(a.provider) ?? Number.MAX_SAFE_INTEGER) -
            (BUILTIN_PROVIDER_RANK.get(b.provider) ?? Number.MAX_SAFE_INTEGER) ||
          a.provider.localeCompare(b.provider),
      );
  }
  return builtinCatalog;
}

function normalizedModelKey(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "");
}

function explicitReasoningSetting(provider: string, modelId: string): boolean | undefined {
  try {
    const raw = providersObject(readModelsDocument())[provider];
    const entries = Array.isArray(raw?.models) ? raw.models : [];
    const entry = entries.find(
      (item) =>
        item &&
        typeof item === "object" &&
        String((item as Record<string, unknown>).id ?? "") === modelId,
    );
    if (!entry || typeof entry !== "object") return undefined;
    const value = (entry as Record<string, unknown>).reasoning;
    return typeof value === "boolean" ? value : undefined;
  } catch {
    return undefined;
  }
}

function findBuiltinModel(model: PiModel): PiModel | undefined {
  const idKey = normalizedModelKey(model.id);
  const nameKey = normalizedModelKey(model.name);
  if (!idKey && !nameKey) return undefined;
  const catalog = builtinCatalogEntries();
  for (const sameApi of [true, false]) {
    for (const entry of catalog) {
      const candidates = entry.models.filter(
        (candidate) =>
          candidate.reasoning && (!sameApi || candidate.api === model.api),
      );
      const idMatch = idKey
        ? candidates.find((candidate) => normalizedModelKey(candidate.id) === idKey)
        : undefined;
      if (idMatch) return idMatch;
      const nameMatch = nameKey
        ? candidates.find((candidate) => normalizedModelKey(candidate.name) === nameKey)
        : undefined;
      if (nameMatch) return nameMatch;
    }
  }
  return undefined;
}

function mergeThinkingCompat(model: PiModel, builtin: PiModel): PiModel["compat"] {
  if (model.api !== "openai-completions") return model.compat;
  const source =
    builtin.compat && typeof builtin.compat === "object"
      ? (builtin.compat as Record<string, unknown>)
      : undefined;
  if (!source) return model.compat;
  const picked: Record<string, unknown> = {};
  for (const key of THINKING_COMPAT_KEYS) {
    if (source[key] !== undefined) picked[key] = source[key];
  }
  if (!Object.keys(picked).length) return model.compat;
  const base =
    model.compat && typeof model.compat === "object"
      ? (model.compat as Record<string, unknown>)
      : {};
  return { ...base, ...picked } as PiModel["compat"];
}

export function applyBuiltinCapabilities(model: PiModel): PiModel {
  if (BUILTIN_PROVIDER_IDS.has(model.provider)) return model;
  const explicit = explicitReasoningSetting(model.provider, model.id);
  if (explicit === false) return model;
  if (model.reasoning && model.thinkingLevelMap) return model;
  const builtin = findBuiltinModel(model);
  if (!builtin?.reasoning) return model;
  return {
    ...model,
    reasoning: true,
    thinkingLevelMap: model.thinkingLevelMap ?? builtin.thinkingLevelMap,
    compat: mergeThinkingCompat(model, builtin),
  } as PiModel;
}

export async function listModels(runtime: ModelRuntime): Promise<PiModelInfo[]> {
  const available = await runtime.getAvailable();
  const items = available.map((model) => {
    const effective = applyBuiltinCapabilities(model);
    return {
      id: `${effective.provider}/${effective.id}`,
      label: `${effective.name || effective.id} · ${effective.provider}`,
      provider: effective.provider,
      default: false,
      reasoning: effective.reasoning,
      thinkingLevels: getSupportedThinkingLevels(effective),
    };
  });
  items.sort((a, b) => a.label.localeCompare(b.label));
  if (items.length) items[0].default = true;
  return items;
}

export function modelRuntimePathHints(): { authPath: string; modelsPath: string } {
  return { authPath: authPath(), modelsPath: modelsPath() };
}
