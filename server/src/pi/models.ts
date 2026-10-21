import fs from "node:fs";
import path from "node:path";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { PI_AGENT_DIR, isConfigured, mask, readEnv, writeJson } from "../config.js";

type PiModel = NonNullable<ReturnType<ModelRuntime["getModel"]>>;

export interface PiModelInfo {
  id: string;
  label: string;
  provider: string;
  default: boolean;
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

export async function listModels(runtime: ModelRuntime): Promise<PiModelInfo[]> {
  const available = await runtime.getAvailable();
  const items = available.map((model) => ({
    id: `${model.provider}/${model.id}`,
    label: `${model.name || model.id} · ${model.provider}`,
    provider: model.provider,
    default: false,
  }));
  items.sort((a, b) => a.label.localeCompare(b.label));
  if (items.length) items[0].default = true;
  return items;
}

export function modelRuntimePathHints(): { authPath: string; modelsPath: string } {
  return { authPath: authPath(), modelsPath: modelsPath() };
}
