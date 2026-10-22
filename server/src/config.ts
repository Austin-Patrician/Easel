import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

export const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
export const WEB_DIR = path.join(PROJECT_ROOT, "web");
export const STATIC_DIR = path.join(WEB_DIR, "static");
export const REACT_DIR = path.join(WEB_DIR, "frontend", "dist");
export const PROFILES_DIR = path.join(PROJECT_ROOT, "profiles");
export const SKILLS_DIR = path.join(PROJECT_ROOT, "skills");
export const OUTPUTS_DIR = path.join(PROJECT_ROOT, "outputs");
export const ENV_FILE = path.join(PROJECT_ROOT, ".env");
export const HARNESS_CONFIG = path.join(OUTPUTS_DIR, "_harness", "config.json");
export const PI_STATE_DIR = path.join(OUTPUTS_DIR, "_pi");
export const PI_SESSION_DIR = path.join(PI_STATE_DIR, "sessions");
export const PI_BINDING_DIR = path.join(PI_STATE_DIR, "bindings");
export const PI_TURN_DIR = path.join(PI_STATE_DIR, "turns");
export const PI_JOB_DIR = path.join(PI_STATE_DIR, "jobs");
export const PI_AGENT_DIR = process.env.EASEL_PI_AGENT_DIR
  ? path.resolve(process.env.EASEL_PI_AGENT_DIR.replace(/^~(?=$|\/)/, os.homedir()))
  : path.join(os.homedir(), ".pi", "agent");

export const DEFAULT_SANDBOX = "workspace-write" as const;
export const SANDBOXES = new Set(["read-only", "workspace-write"]);
export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

export type Sandbox = "read-only" | "workspace-write";
export type ThinkingLevel = (typeof THINKING_LEVELS)[number];

export interface HarnessSettings {
  runtime: "pi";
  models: Record<string, string>;
  sandbox: Sandbox;
  thinking: ThinkingLevel | "";
}

export function normalizeThinkingLevel(value: unknown): ThinkingLevel | "" | undefined {
  if (value === undefined || value === null) return undefined;
  const text = String(value).trim();
  if (!text) return "";
  return (THINKING_LEVELS as readonly string[]).includes(text) ? text as ThinkingLevel : undefined;
}

export class ConfigError extends Error {}

export function ensureDirs(): void {
  for (const dir of [PI_STATE_DIR, PI_SESSION_DIR, PI_BINDING_DIR, PI_TURN_DIR, PI_JOB_DIR]) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

export function readJson<T = unknown>(file: string): T | undefined {
  if (!fs.existsSync(file)) return undefined;
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as T;
  } catch {
    return undefined;
  }
}

export function readJsonStrict<T = unknown>(file: string): T | undefined {
  if (!fs.existsSync(file)) return undefined;
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as T;
  } catch (error) {
    throw new ConfigError(`本地文件格式损坏：${path.relative(PROJECT_ROOT, file)}`) as Error;
  }
}

export function writeJson(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.${crypto.randomBytes(4).toString("hex")}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(value, null, 2), "utf8");
  fs.renameSync(temporary, file);
}

export function readEnv(): Record<string, string> {
  const result: Record<string, string> = {};
  if (fs.existsSync(ENV_FILE)) {
    for (const line of fs.readFileSync(ENV_FILE, "utf8").split(/\r?\n/)) {
      const stripped = line.trim();
      if (!stripped || stripped.startsWith("#") || !stripped.includes("=")) continue;
      const index = stripped.indexOf("=");
      const key = stripped.slice(0, index).trim();
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
      result[key] = stripped.slice(index + 1).trim().replace(/^['"]|['"]$/g, "");
    }
  }
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) result[key] = value;
  }
  return result;
}

export function isConfigured(value: string | undefined): boolean {
  if (!value || !value.trim()) return false;
  return !/replace_me|your[-_]?api[-_]?key|^xxx$|^\.{3}$|^<.*>$/i.test(value.trim());
}

export function mask(value: string | undefined): string {
  const raw = (value ?? "").trim();
  if (!raw) return "";
  return raw.length <= 4 ? "••••" : `••••${raw.slice(-4)}`;
}

export function harnessSettings(): HarnessSettings {
  const raw = readJsonStrict<Record<string, unknown>>(HARNESS_CONFIG) ?? {};
  const models = raw.models && typeof raw.models === "object" ? (raw.models as Record<string, unknown>) : {};
  const configuredModel = typeof models.pi === "string" ? models.pi.slice(0, 240) : "";
  const fallbackModel = typeof raw.model === "string" ? raw.model.slice(0, 240) : "";
  const sandbox = raw.sandbox === "read-only" ? "read-only" : DEFAULT_SANDBOX;
  const thinking = normalizeThinkingLevel(raw.thinking) ?? "";
  return {
    runtime: "pi",
    models: { pi: configuredModel || fallbackModel },
    sandbox,
    thinking,
  };
}

export function saveHarnessSettings(patch: { model?: string; sandbox?: string; thinking?: string }): HarnessSettings {
  const current = harnessSettings();
  const model = typeof patch.model === "string" ? patch.model.trim().slice(0, 240) : current.models.pi;
  if (model && /[\r\n]/.test(model)) throw new ConfigError("模型标识不能包含换行符");
  const sandbox = patch.sandbox ?? current.sandbox;
  if (!SANDBOXES.has(sandbox)) throw new ConfigError("Agent 权限设置无效，只允许只读或工作区写入");
  const thinking = patch.thinking === undefined ? current.thinking : normalizeThinkingLevel(patch.thinking);
  if (thinking === undefined) throw new ConfigError("思考深度无效");
  const next: HarnessSettings = {
    runtime: "pi",
    models: { pi: model },
    sandbox: sandbox as Sandbox,
    thinking,
  };
  writeJson(HARNESS_CONFIG, next);
  return next;
}

export function bindingPath(sessionKey: string): string {
  const digest = crypto.createHash("sha256").update(sessionKey).digest("hex");
  return path.join(PI_BINDING_DIR, `${digest}.json`);
}

export interface SessionBinding {
  runtime: "pi";
  sessionFile: string;
  sessionKey: string;
  createdAt: number;
}

export function readBinding(sessionKey: string): SessionBinding | undefined {
  const value = readJsonStrict<SessionBinding>(bindingPath(sessionKey));
  if (!value) return undefined;
  if (value.runtime !== "pi" || typeof value.sessionFile !== "string" || !value.sessionFile) {
    throw new ConfigError("Agent 会话记录格式无效，不会自动重置历史");
  }
  return value;
}

export function writeBinding(sessionKey: string, sessionFile: string): SessionBinding {
  const previous = readBinding(sessionKey);
  if (previous && previous.sessionFile !== sessionFile) {
    throw new ConfigError("pi 返回了不同的原生会话文件，不会替换已有历史");
  }
  const value: SessionBinding = {
    runtime: "pi",
    sessionFile,
    sessionKey,
    createdAt: previous?.createdAt ?? Date.now(),
  };
  writeJson(bindingPath(sessionKey), value);
  return value;
}

export function deleteBinding(sessionKey: string): boolean {
  const file = bindingPath(sessionKey);
  if (!fs.existsSync(file)) return false;
  fs.unlinkSync(file);
  return true;
}

export function turnFile(sessionKey: string): string {
  return path.join(PI_TURN_DIR, `${crypto.createHash("sha256").update(`web:${sessionKey}`).digest("hex")}.json`);
}

export function jobEventFile(turnId: string): string {
  return path.join(PI_JOB_DIR, `${turnId.replace(/[^a-zA-Z0-9_.-]/g, "_")}.jsonl`);
}

export function scrubSecrets(text: string): string {
  let out = text;
  for (const [key, value] of Object.entries(readEnv())) {
    const raw = value.trim();
    if (raw.length < 8 || !/KEY|TOKEN|SECRET|PASSWORD|COOKIE/i.test(key)) continue;
    out = out.split(raw).join(mask(raw));
  }
  return out;
}

export function validPersonaName(name: string): boolean {
  return (
    typeof name === "string" &&
    name.length > 0 &&
    !name.startsWith(".") &&
    !name.startsWith("_") &&
    !/[/\\:]/.test(name) &&
    !/[\u0000-\u001f]/.test(name)
  );
}
