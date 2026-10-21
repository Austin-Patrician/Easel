import { createModelRuntime, listModels } from "./pi/models.js";
import { harnessSettings, readEnv, saveHarnessSettings } from "./config.js";
import { saveEnvUpdates } from "./content.js";
import { isSet, mask } from "./domain.js";
import { runPython } from "./python.js";

interface RegistryKey {
  env: string;
  label: string;
  required: boolean;
  secret: boolean;
  aliases: string[];
  choices: string[];
}

interface RegistryProvider {
  id: string;
  name: string;
  keys: RegistryKey[];
}

interface RegistryGroup {
  label: string;
  settings: RegistryKey[];
  providers: RegistryProvider[];
}

type Registry = Record<string, RegistryGroup>;

const CHANNEL_GROUP: Record<string, string> = {
  image: "image",
  video: "video",
  music: "music",
  speech: "voice",
};

const GROUP_PRIMARY: Record<string, string> = {
  video: "VIDEO_PROVIDER",
  music: "MUSIC_PROVIDER",
  voice: "VOICE_PROVIDER",
};

let registryCache: { at: number; value: Registry } | undefined;

async function registry(): Promise<Registry> {
  if (registryCache && Date.now() - registryCache.at < 60_000) return registryCache.value;
  const code = [
    "import sys, json",
    "sys.path.insert(0, 'skills/shared/scripts')",
    "import model_registry as m",
    "print(json.dumps(m.MODEL_GROUPS, ensure_ascii=False))",
  ].join("\n");
  const result = await runPython(["-c", code], { timeoutMs: 15_000 });
  if (result.code !== 0) throw new Error(result.stderr.trim().split(/\r?\n/).pop() || "读取模型注册表失败");
  const value = JSON.parse(result.stdout.trim()) as Registry;
  registryCache = { at: Date.now(), value };
  return value;
}

function envValue(env: Record<string, string>, key: RegistryKey): string {
  const direct = env[key.env] ?? "";
  if (direct) return direct;
  for (const alias of key.aliases ?? []) {
    if (env[alias]) return env[alias];
  }
  return "";
}

function configured(env: Record<string, string>, key: RegistryKey): boolean {
  return isSet(envValue(env, key));
}

function baseKey(provider: RegistryProvider): RegistryKey | undefined {
  return provider.keys.find((key) => !key.secret && /(BASE|URL)/.test(key.env));
}

function modelKey(provider: RegistryProvider): RegistryKey | undefined {
  return provider.keys.find((key) => !key.secret && key.env.includes("MODEL"));
}

function editKeys(provider: RegistryProvider): RegistryKey[] {
  const base = baseKey(provider);
  const model = modelKey(provider);
  return provider.keys.filter((key) => key.required && key !== base && key !== model);
}

function mediaRows(spec: RegistryGroup, group: string, env: Record<string, string>): Array<Record<string, unknown>> {
  const chosen = String(env[GROUP_PRIMARY[group] ?? ""] ?? "").trim();
  return spec.providers.map((provider) => {
    const required = provider.keys.filter((key) => key.required);
    const base = baseKey(provider);
    const model = modelKey(provider);
    const secrets = editKeys(provider);
    const first = secrets[0];
    const second = secrets[1];
    return {
      slot: provider.id,
      order: 0,
      name: provider.name,
      sub: group,
      type: provider.id,
      model: model ? String(env[model.env] ?? "").trim() : "",
      baseUrl: base ? String(env[base.env] ?? "").trim() : "",
      keyMasked: first ? mask(envValue(env, first)) : "",
      role: group === "image" || chosen === provider.id ? "主" : "备",
      result: required.every((key) => configured(env, key)) ? "已配置" : "未配置",
      key2Label: second?.label ?? "",
      key2Masked: second?.secret ? mask(envValue(env, second)) : "",
      modelEditable: Boolean(model),
      baseEditable: Boolean(base),
      baseOptional: !base?.required,
      adv: provider.keys.some((key) => !key.required && key !== model),
      deletable: false,
    };
  });
}

function transcribeRows(env: Record<string, string>): Array<Record<string, unknown>> {
  return [
    {
      order: 0,
      name: "自带字幕",
      sub: "视频自带 SRT/VTT 时直接读",
      type: "脚本层",
      model: "—",
      baseUrl: "—",
      keyMasked: "—",
      role: "免配",
      result: "优先",
    },
    {
      slot: "siliconflow",
      order: 1,
      name: "siliconflow",
      sub: "硅基流动",
      type: "openai",
      model: "SenseVoiceSmall",
      baseUrl: "https://api.siliconflow.cn/v1",
      keyMasked: isSet(env.SILICONFLOW_API_KEY) ? mask(env.SILICONFLOW_API_KEY ?? "") : "",
      role: "主",
      result: isSet(env.SILICONFLOW_API_KEY) ? "已配置" : "缺 key",
      modelEditable: true,
      baseEditable: true,
    },
  ];
}

export async function modelChannels(): Promise<Record<string, unknown>> {
  const settings = harnessSettings();
  let models: Array<{ id: string; label: string }> = [];
  try {
    const runtime = await createModelRuntime();
    models = await listModels(runtime);
  } catch {
    models = [];
  }
  const selected = settings.models.pi || models[0]?.id || "";
  const configuredModel = Boolean(selected);
  const env = readEnv();
  const channels: Record<string, unknown> = {
    chat: {
      rows: [{
        slot: "pi",
        order: 1,
        name: "pi",
        sub: "唯一 Agent 底座 · TypeScript SDK",
        type: "pi",
        model: selected || "（未选择）",
        baseUrl: "pi agent dir",
        keyMasked: configuredModel ? "已配置" : "未配置",
        role: "主",
        result: configuredModel ? "✓ 已选择" : "待配置",
        modelEditable: true,
        baseEditable: false,
        deletable: false,
      }],
    },
    transcribe: { rows: transcribeRows(env) },
    image: { rows: [] },
    video: { rows: [] },
    music: { rows: [] },
    speech: { rows: [] },
  };
  try {
    const specs = await registry();
    for (const [channel, group] of Object.entries(CHANNEL_GROUP)) {
      channels[channel] = { rows: mediaRows(specs[group], group, env) };
    }
  } catch {
    // Keep the channels empty instead of failing the whole settings panel.
  }
  return {
    transport: "pi",
    channels,
    primary: selected ? `pi/${selected}` : "",
    models,
  };
}

export async function saveModelRows(
  channel: string,
  rows: Array<Record<string, unknown>>,
): Promise<{ ok: boolean; note?: string }> {
  if (channel === "chat") {
    const row = rows.find((item) => String(item.slot ?? "") === "pi") ?? rows[0];
    const model = String(row?.model ?? "").trim();
    if (model && model !== "（未选择）") saveHarnessSettings({ model });
    return { ok: true, note: "pi 模型已保存" };
  }
  if (channel === "transcribe") {
    const updates: Record<string, string> = {};
    for (const row of rows) {
      if (String(row.slot ?? "") !== "siliconflow") continue;
      const base = String(row.baseUrl ?? "").trim().replace(/\/+$/, "");
      const key = String(row.key ?? "").trim();
      if (base) updates.SILICONFLOW_BASE_URL = base;
      if (key) updates.SILICONFLOW_API_KEY = key;
    }
    if (!Object.keys(updates).length) throw new Error("没有可保存的改动（key 留空表示不改）");
    saveEnvUpdates(updates);
    return { ok: true, note: "语音转写配置已写入 .env" };
  }
  const group = CHANNEL_GROUP[channel];
  if (!group) throw new Error(`未知模型通道：${channel}`);
  const specs = await registry();
  const spec = specs[group];
  const byId = new Map(spec.providers.map((provider) => [provider.id, provider]));
  const env = readEnv();
  const updates: Record<string, string> = {};
  let primary = "";
  for (const row of rows) {
    const id = String(row.slot ?? "").trim();
    const provider = byId.get(id);
    if (!provider) throw new Error(`不认识的服务商：${id || "（空）"}`);
    const base = String(row.baseUrl ?? "").trim().replace(/\/+$/, "");
    const key = String(row.key ?? "").trim();
    const key2 = String(row.key2 ?? "").trim();
    const model = String(row.model ?? "").trim();
    if (base && !/^https?:\/\//i.test(base)) throw new Error(`${provider.name} 的根地址需是合法的 http(s):// 地址`);
    if (/\s/.test(key) || /\s/.test(key2)) throw new Error(`${provider.name} 的 Key 不能包含空白字符`);
    const baseField = baseKey(provider);
    const modelField = modelKey(provider);
    const secrets = editKeys(provider);
    if (base && baseField && !key && secrets.length && isSet(env[baseField.env])
      && base !== String(env[baseField.env] ?? "").trim().replace(/\/+$/, "")
      && isSet(envValue(env, secrets[0]))) {
      throw new Error(`更换${provider.name}的根地址时必须重新填写 Key`);
    }
    if (key && secrets[0]) updates[secrets[0].env] = key;
    if (key2 && secrets[1]) updates[secrets[1].env] = key2;
    if (model && modelField) updates[modelField.env] = model;
    if (base && baseField) updates[baseField.env] = base;
    if (row.primary === true) primary = id;
  }
  if (primary && GROUP_PRIMARY[group]) updates[GROUP_PRIMARY[group]] = primary;
  if (!Object.keys(updates).length) throw new Error("没有可保存的改动（key 留空表示不改）");
  saveEnvUpdates(updates);
  return { ok: true, note: "" };
}

export async function channelSelftest(channel: string): Promise<{
  channel: string;
  results: Array<{ baseUrl: string; ok: boolean; ms: number; detail?: string }>;
  testedAt: number;
}> {
  const payload = await modelChannels();
  const channels = payload.channels as Record<string, { rows: Array<Record<string, unknown>> }>;
  const rows = channel === "all"
    ? Object.values(channels).flatMap((item) => item.rows)
    : channels[channel]?.rows ?? [];
  const env = readEnv();
  const results: Array<{ baseUrl: string; ok: boolean; ms: number; detail?: string }> = [];
  for (const row of rows) {
    const base = String(row.baseUrl ?? "").trim().replace(/\/+$/, "");
    if (!/^https?:\/\//i.test(base) || /^(—|官方|（未配置）|本机|内建默认)$/.test(base)) continue;
    let key = "";
    if (row.slot === "siliconflow") key = String(env.SILICONFLOW_API_KEY ?? "");
    if (row.slot === "pi") key = String(env.EASEL_DIRECT_API_KEY ?? "");
    if (!key && row.slot) {
      try {
        const specs = await registry();
        const provider = Object.values(specs).flatMap((group) => group.providers).find((item) => item.id === row.slot);
        if (provider) key = String(envValue(env, editKeys(provider)[0] ?? provider.keys[0]) ?? "");
      } catch {
        // No registry: probe without a key.
      }
    }
    const started = Date.now();
    try {
      const headers: Record<string, string> = key ? { Authorization: `Bearer ${key}` } : {};
      // Xiaomi MiMo documents both Bearer (OpenAI SDK) and `api-key`; send both so
      // selftest works with the official endpoint and with compatible gateways.
      if (key && row.slot === "xiaomi-mimo") headers["api-key"] = key;
      const response = await fetch(`${base}/models`, {
        headers,
        signal: AbortSignal.timeout(12_000),
        redirect: "error",
      });
      results.push({
        baseUrl: base,
        ok: response.ok,
        ms: Date.now() - started,
        detail: response.ok ? undefined : `HTTP ${response.status}`,
      });
    } catch (error) {
      results.push({
        baseUrl: base,
        ok: false,
        ms: Date.now() - started,
        detail: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return { channel, results, testedAt: Date.now() };
}
