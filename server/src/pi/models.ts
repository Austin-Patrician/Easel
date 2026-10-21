import fs from "node:fs";
import path from "node:path";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { PI_AGENT_DIR, isConfigured, readEnv } from "../config.js";

type PiModel = NonNullable<ReturnType<ModelRuntime["getModel"]>>;

export interface PiModelInfo {
  id: string;
  label: string;
  provider: string;
  default: boolean;
}

const DIRECT_PROVIDER = "easel-direct";

function modelsPath(): string {
  return path.join(PI_AGENT_DIR, "models.json");
}

function authPath(): string {
  return path.join(PI_AGENT_DIR, "auth.json");
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
  if (!baseUrl || !modelId) return;

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
  providers[DIRECT_PROVIDER] = {
    ...previousObj,
    baseUrl,
    api: "openai-completions",
    apiKey: isConfigured(key) ? key : "easel-local",
    ...(Object.keys(headers).length ? { headers } : {}),
    models: [modelEntry],
  };
  data.providers = providers;
  fs.writeFileSync(file, JSON.stringify(data, null, 2), "utf8");
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
