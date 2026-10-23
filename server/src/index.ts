import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import express, { type NextFunction, type Request, type Response } from "express";
import multer from "multer";
import * as yauzl from "yauzl";
import {
  DEFAULT_SANDBOX,
  ENV_FILE,
  OUTPUTS_DIR,
  PI_STATE_DIR,
  PROJECT_ROOT,
  REACT_DIR,
  SKILLS_DIR,
  STATIC_DIR,
  bindingPath,
  deleteBinding,
  ensureDirs,
  harnessSettings,
  normalizeThinkingLevel,
  readBinding,
  readEnv,
  readJson,
  saveHarnessSettings,
  turnFile,
  writeJson,
} from "./config.js";
import {
  UPLOAD_EXTS,
  deleteOutput,
  deletePersona,
  envStatus,
  fileKind,
  findSkill,
  listPersonas,
  loadProfileText,
  outputContent,
  outputTree,
  personaFiles,
  safeOutputFile,
  safeOutputTarget,
  saveEnvUpdates,
  savePersonaFile,
  skillDetail,
  skillList,
} from "./content.js";
import { readJsonStrict } from "./config.js";
import { answerQuestion, installHostBridge, questionStatus, setTurnApproval } from "./pi/host.js";
import {
  PI_PROVIDER_APIS,
  createModelRuntime,
  deletePiProvider,
  fetchPiProviderModels,
  listModels,
  modelRuntimePathHints,
  piProviders,
  savePiProvider,
} from "./pi/models.js";
import { runChatTurn, stopTurn, type AttachmentRef } from "./pi/chat.js";
import { JobWriter, appendJobEvent, jobExists, readJob, readLastTurn, reconstructTurn, saveLastTurn } from "./jobs.js";
import { channelSelftest, modelChannels, saveModelRows } from "./model-channels.js";
import { HttpError } from "./http.js";
import { accountsRouter } from "./routes/accounts.js";
import { calendarRouter } from "./routes/calendar.js";
import { profileRouter } from "./routes/profile.js";
import { publishingRouter } from "./routes/publishing.js";

const app = express();
app.disable("x-powered-by");
app.use(express.json({ limit: "4mb" }));
app.use(express.urlencoded({ extended: true, limit: "4mb" }));

const PORT = Number(process.env.EASEL_PORT ?? 7860);
const HOST = process.env.EASEL_HOST ?? "127.0.0.1";
const MAX_UPLOAD_MB = 50;
const TMP_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "easel-upload-"));
// Jobs whose POST /api/chat/stream request is still being served by this
// process. A persisted job without a terminal event and without an entry here
// was orphaned by a restart/crash and must not heartbeat forever.
const activeChatTurns = new Set<string>();

function wrap(fn: (req: Request, res: Response, next: NextFunction) => unknown) {
  return (req: Request, res: Response, next: NextFunction) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}

function fail(message: string, status = 400): never {
  throw new HttpError(status, message);
}

function pythonExecutable(): string {
  const venv = path.join(PROJECT_ROOT, ".venv", process.platform === "win32" ? "Scripts/python.exe" : "bin/python");
  if (fs.existsSync(venv)) return venv;
  return process.platform === "win32" ? "python" : "python3";
}

function proxyEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  env.EASEL_ROOT ??= PROJECT_ROOT;
  if (process.env.EASEL_PROXY) {
    env.http_proxy ??= process.env.EASEL_PROXY;
    env.https_proxy ??= process.env.EASEL_PROXY;
  }
  env.no_proxy ??=
    "localhost,127.0.0.1,10.*,*.xiaohongshu.com,*.devops.xiaohongshu.com,*.douyin.com,*.kuaishou.com,*.zhihu.com,*.bilibili.com,*.weixin.qq.com,*.qq.com";
  return env;
}

function param(req: Request, name: string): string {
  return String(req.params[name] ?? "");
}

function sessionId(value: unknown): string {
  const text = String(value ?? "").trim();
  if (!text || text.length > 256) fail("无效的会话标识", 400);
  return text;
}

function turnId(value: unknown): string {
  const text = String(value ?? "").trim();
  if (text && /^[A-Za-z0-9_.-]{1,120}$/.test(text)) return text;
  return crypto.randomUUID().replace(/-/g, "");
}

function attachmentScope(id: string): string {
  return crypto.createHash("sha256").update(id).digest("hex").slice(0, 20);
}

function attachmentId(scope: string, rel: string): string {
  return crypto.createHash("sha256").update(`${scope}\0${rel}`).digest("hex").slice(0, 24);
}

function fileExt(name: string): string {
  return path.extname(name).toLowerCase();
}

function uniqueTarget(dir: string, filename: string): string {
  const base = path.basename(filename || "file");
  let target = path.join(dir, base);
  if (!fs.existsSync(target)) return target;
  const parsed = path.parse(base);
  for (let index = 2; ; index += 1) {
    target = path.join(dir, `${parsed.name} (${index})${parsed.ext}`);
    if (!fs.existsSync(target)) return target;
  }
}

function writeSse(res: Response, event: string, data: string, id?: number): void {
  if (res.writableEnded || res.destroyed) return;
  try {
    if (id !== undefined) res.write(`id: ${id}\n`);
    res.write(`event: ${event}\ndata: ${data}\n\n`);
  } catch {
    // The browser disconnected; the run keeps writing its durable job log.
  }
}

function sseHeaders(res: Response): void {
  res.status(200);
  res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders?.();
}

function encodeEventData(kind: string, text?: string, extra?: Record<string, unknown>): string {
  if (kind === "question") return JSON.stringify(extra ?? {});
  if (kind === "done") return JSON.stringify(extra ?? {});
  return JSON.stringify(text ?? "");
}

async function oneShot(message: string, persona?: string, prefix = "oneshot"): Promise<string> {
  const sessionKey = `web-${prefix}-${crypto.randomUUID()}`;
  const errors: string[] = [];
  const text = await runChatTurn({
    sessionKey,
    prompt: message,
    persona,
    turnId: crypto.randomUUID().replace(/-/g, ""),
    emit: (kind, value) => {
      if (kind === "error" && value) errors.push(value);
    },
  });
  if (errors.length) throw new HttpError(502, errors[0]);
  return text;
}

function settingsPayload() {
  const settings = harnessSettings();
  return {
    runtime: "pi",
    models: settings.models,
    sandbox: settings.sandbox,
    thinking: settings.thinking,
    locked: false,
    agents: [
      {
        id: "pi",
        label: "Pi（TypeScript SDK）",
        protocol: "in-process SDK",
        installed: true,
        install_hint: "pi 已内置于 Easel；模型登录使用 `pi`，或在设置页维护 pi 的 models.json / .env 的 EASEL_DIRECT_API_*。",
      },
    ],
  };
}

app.get("/api/status", wrap(async (_req, res) => {
  let ready = true;
  try {
    const runtime = await createModelRuntime();
    const available = await runtime.getAvailable();
    ready = available.length > 0;
  } catch {
    ready = false;
  }
  res.json({
    ready,
    transport: "pi",
    runtime: "pi",
    skills: skillList(),
    personas: listPersonas(),
  });
}));

app.get("/api/settings/bootstrap", wrap(async (_req, res) => {
  const modelRuntime = await createModelRuntime();
  const available = await modelRuntime.getAvailable();
  const configured = available.length > 0;
  let warnings: unknown[] = [];
  try {
    const report = readJson<Record<string, unknown>>(path.join(OUTPUTS_DIR, "_install", "last-install.json"));
    warnings = Array.isArray(report?.warnings) ? report!.warnings : [];
  } catch {
    warnings = [];
  }
  res.json({
    modelConfigured: configured,
    envKeyOk: configured,
    routeOk: configured,
    routeDetail: configured
      ? "pi 模型已就绪"
      : "pi 还没有可用模型。运行 `pi` 完成 /login，或在设置页添加 pi 供应商 / 配置 .env 的 EASEL_DIRECT_API_*。",
    installWarnings: warnings,
    runtime: "pi",
  });
}));

app.get("/api/settings/harness", wrap(async (_req, res) => {
  res.json(settingsPayload());
}));

app.post("/api/settings/harness", wrap(async (req, res) => {
  const body = (req.body ?? {}) as Record<string, unknown>;
  if (body.runtime !== undefined && body.runtime !== "pi") {
    fail("pi 是唯一 Agent 底座，不能切换到其它 runtime", 409);
  }
  const model = body.model === undefined ? "" : String(body.model);
  const sandbox = body.sandbox === undefined ? undefined : String(body.sandbox);
  const thinking = body.thinking === undefined ? undefined : String(body.thinking);
  saveHarnessSettings({ model, sandbox, thinking });
  res.json(settingsPayload());
}));

app.post("/api/settings/harness/models/:runtime", wrap(async (req, res) => {
  if (param(req, "runtime") !== "pi") fail("pi 是唯一 Agent 底座", 409);
  const runtime = await createModelRuntime();
  res.json({ runtime: "pi", models: await listModels(runtime) });
}));

function piProviderPayload() {
  return {
    providers: piProviders(),
    apis: PI_PROVIDER_APIS,
    ...modelRuntimePathHints(),
  };
}

app.get("/api/settings/pi/providers", wrap(async (_req, res) => {
  await createModelRuntime();
  res.json(piProviderPayload());
}));

app.post("/api/settings/pi/providers", wrap(async (req, res) => {
  const body = (req.body ?? {}) as Record<string, unknown>;
  let provider;
  try {
    provider = savePiProvider({
      id: String(body.id ?? ""),
      name: body.name === undefined ? undefined : String(body.name),
      baseUrl: String(body.baseUrl ?? ""),
      api: String(body.api ?? ""),
      apiKey: body.apiKey === undefined ? undefined : String(body.apiKey),
      models: Array.isArray(body.models) ? body.models.map((item) => String(item)) : [],
    });
  } catch (error) {
    fail(error instanceof Error ? error.message : "保存 pi 供应商失败");
  }
  const runtime = await createModelRuntime();
  res.json({
    ok: true,
    provider,
    ...piProviderPayload(),
    models: await listModels(runtime),
  });
}));

app.post("/api/settings/pi/providers/models", wrap(async (req, res) => {
  const body = (req.body ?? {}) as Record<string, unknown>;
  try {
    res.json(await fetchPiProviderModels({
      id: body.id === undefined ? "" : String(body.id),
      baseUrl: String(body.baseUrl ?? ""),
      api: String(body.api ?? ""),
      apiKey: body.apiKey === undefined ? "" : String(body.apiKey),
    }));
  } catch (error) {
    fail(error instanceof Error ? error.message : "拉取模型列表失败");
  }
}));

app.delete("/api/settings/pi/providers/:id", wrap(async (req, res) => {
  let removed = false;
  try {
    removed = deletePiProvider(param(req, "id"));
  } catch (error) {
    fail(error instanceof Error ? error.message : "删除 pi 供应商失败");
  }
  if (!removed) fail("供应商不存在", 404);
  const runtime = await createModelRuntime();
  res.json({
    ok: true,
    ...piProviderPayload(),
    models: await listModels(runtime),
  });
}));

app.get("/api/settings/models", wrap(async (_req, res) => {
  res.json(await modelChannels());
}));

app.post("/api/settings/chat/transport", wrap(async (req, res) => {
  const transport = String((req.body ?? {}).transport ?? "");
  if (transport !== "pi") fail("聊天传输固定为 pi，没有其它回退路径", 409);
  res.json(await modelChannels());
}));

app.post("/api/settings/models/save", wrap(async (req, res) => {
  const body = (req.body ?? {}) as Record<string, unknown>;
  const channel = String(body.channel ?? "chat");
  const rows = Array.isArray(body.rows) ? (body.rows as Array<Record<string, unknown>>) : [];
  let saved: { ok: boolean; note?: string };
  try {
    saved = await saveModelRows(channel, rows);
  } catch (error) {
    fail(error instanceof Error ? error.message : "保存模型配置失败");
  }
  const payload = await modelChannels();
  res.json({ ...saved, ...payload });
}));

app.post("/api/settings/models/selftest", wrap(async (req, res) => {
  res.json(await channelSelftest(String((req.body ?? {}).channel ?? "chat")));
}));

app.post("/api/settings/models/available", wrap(async (req, res) => {
  const body = (req.body ?? {}) as Record<string, unknown>;
  const base = String(body.baseUrl ?? "").trim().replace(/\/+$/, "");
  const slot = String(body.slot ?? "").trim();
  let key = String(body.key ?? "").trim();
  if (!key && slot) {
    const env = readEnv();
    const saved = ({
      siliconflow: {
        key: env.SILICONFLOW_API_KEY,
        base: env.SILICONFLOW_BASE_URL || "https://api.siliconflow.cn/v1",
      },
      "xiaomi-mimo": {
        key: env.MIMO_API_KEY,
        base: env.MIMO_BASE_URL || "https://api.xiaomimimo.com/v1",
      },
    } as Record<string, { key?: string; base?: string }>)[slot];
    if (saved && base === String(saved.base ?? "").trim().replace(/\/+$/, "")) {
      key = String(saved.key ?? "").trim();
    }
  }
  if (!/^https?:\/\//i.test(base)) fail("Base URL 必须是 http(s) 地址");
  try {
    const headers: Record<string, string> = { Accept: "application/json" };
    if (key) {
      headers.Authorization = `Bearer ${key}`;
      if (slot === "xiaomi-mimo") headers["api-key"] = key;
    }
    const response = await fetch(`${base}/models`, {
      headers,
      signal: AbortSignal.timeout(20000),
    });
    if (!response.ok) fail(`模型列表请求失败：HTTP ${response.status}`, 502);
    const payload = (await response.json()) as { data?: Array<{ id?: string }> };
    const models = (payload.data ?? []).map((item) => String(item.id ?? "")).filter(Boolean).sort();
    res.json({ baseUrl: base, models, fetchedAt: Date.now() });
  } catch (error) {
    if (error instanceof HttpError) throw error;
    fail(`拉取模型失败：${error instanceof Error ? error.message : String(error)}`, 502);
  }
}));

app.get("/api/personas", wrap(async (_req, res) => {
  res.json(listPersonas());
}));

app.get("/api/persona/:name", wrap(async (req, res) => {
  const text = loadProfileText(param(req, "name"));
  if (!text) fail("画像不存在", 404);
  res.json({ name: param(req, "name"), content: text });
}));

app.get("/api/persona/:name/files", wrap(async (req, res) => {
  const data = personaFiles(param(req, "name"));
  if (!data) fail("画像不存在", 404);
  res.json(data);
}));

app.put("/api/persona/:name/file", wrap(async (req, res) => {
  const body = (req.body ?? {}) as Record<string, unknown>;
  const filename = String(body.filename ?? "");
  const content = String(body.content ?? "");
  savePersonaFile(param(req, "name"), filename, content);
  res.json({ ok: true, filename });
}));

app.delete("/api/persona/:name", wrap(async (req, res) => {
  deletePersona(param(req, "name"));
  res.json({ ok: true, deleted: param(req, "name") });
}));

app.get("/api/skills", wrap(async (_req, res) => {
  res.json(skillList());
}));

app.get("/api/skill/:name", wrap(async (req, res) => {
  const detail = skillDetail(param(req, "name"));
  if (!detail) fail(`SKILL '${param(req, "name")}' 不存在`, 404);
  res.json(detail);
}));

app.post("/api/skill", wrap(async (req, res) => {
  const body = (req.body ?? {}) as Record<string, unknown>;
  const name = String(body.skill ?? "");
  const input = String(body.input ?? "");
  const persona = body.persona ? String(body.persona) : undefined;
  const full = findSkill(name);
  if (!full) fail(`SKILL '${name}' 不存在`, 404);
  const response = await oneShot(`请执行 /${full}，内容如下：\n\n${input}`, persona, "skill");
  res.json({ response });
}));

app.post("/api/env", wrap(async (req, res) => {
  const body = (req.body ?? {}) as Record<string, unknown>;
  const updates = body.updates && typeof body.updates === "object" ? (body.updates as Record<string, string>) : {};
  saveEnvUpdates(updates);
  res.json(envStatus());
}));

const envToolCache: { ts: number; data: unknown; python: string } = { ts: 0, data: undefined, python: "" };
const envJobs = new Map<string, Record<string, unknown>>();

function installToolScript(): string {
  return path.join(SKILLS_DIR, "shared", "scripts", "install_tool.py");
}

app.get("/api/env/tools", wrap(async (req, res) => {
  if (!req.query.refresh && envToolCache.data && Date.now() - envToolCache.ts < 15000) {
    res.json(envToolCache.data);
    return;
  }
  const script = installToolScript();
  if (!fs.existsSync(script)) fail("未找到 skills/shared/scripts/install_tool.py", 500);
  const proc = spawnSync(pythonExecutable(), [script, "--json", "check"], {
    cwd: PROJECT_ROOT,
    env: proxyEnv(),
    encoding: "utf8",
    timeout: 240000,
  });
  if (proc.status !== 0) fail(`环境体检失败：${(proc.stderr || "").trim().slice(-300) || "无输出"}`, 500);
  let data: Record<string, unknown>;
  try {
    data = JSON.parse(proc.stdout) as Record<string, unknown>;
  } catch (error) {
    fail(`体检输出解析失败：${error instanceof Error ? error.message : String(error)}`, 500);
  }
  data.cachedAt = Math.floor(Date.now() / 1000);
  data.python = pythonExecutable();
  envToolCache.ts = Date.now();
  envToolCache.data = data;
  envToolCache.python = pythonExecutable();
  res.json(data);
}));

app.post("/api/env/install", wrap(async (req, res) => {
  const id = String((req.body ?? {}).id ?? "").trim();
  if (!/^[A-Za-z0-9_.-]{1,80}$/.test(id)) fail("无效的工具 id");
  const script = installToolScript();
  if (!fs.existsSync(script)) fail("未找到 skills/shared/scripts/install_tool.py", 500);
  const jobId = crypto.randomUUID().replace(/-/g, "").slice(0, 16);
  const job: Record<string, unknown> = {
    jobId,
    id,
    state: "running",
    lines: [],
    result: null,
    started: Math.floor(Date.now() / 1000),
    ended: null,
  };
  envJobs.set(jobId, job);
  const child = spawn(pythonExecutable(), [script, "--json", "install", id], {
    cwd: PROJECT_ROOT,
    env: proxyEnv(),
  });
  const append = (line: string) => {
    if (!line.trim()) return;
    const lines = Array.isArray(job.lines) ? (job.lines as string[]) : [];
    job.lines = [...lines, line].slice(-40);
  };
  child.stderr?.setEncoding("utf8");
  child.stderr?.on("data", (chunk: string) => {
    for (const line of chunk.split(/\r?\n/)) append(line);
  });
  let stdout = "";
  child.stdout?.setEncoding("utf8");
  child.stdout?.on("data", (chunk: string) => {
    stdout += chunk;
  });
  child.on("error", (error) => {
    job.state = "fail";
    job.result = { id, state: "fail", detail: error.message };
    job.ended = Math.floor(Date.now() / 1000);
  });
  child.on("close", (code) => {
    try {
      const parsed = JSON.parse(stdout) as { results?: unknown[] };
      job.result = parsed.results?.[0] ?? null;
      job.state = (job.result as { state?: string } | null)?.state === "ok" ? "ok" : "fail";
    } catch {
      job.state = code === 0 ? "ok" : "fail";
    }
    job.ended = Math.floor(Date.now() / 1000);
    envToolCache.ts = 0;
  });
  res.json({ jobId, id, state: "running" });
}));

app.get("/api/env/job/:jobId", wrap(async (req, res) => {
  const job = envJobs.get(param(req, "jobId"));
  if (!job) fail("任务不存在（服务可能重启过）", 404);
  res.json(job);
}));

app.get("/api/outputs", wrap(async (_req, res) => {
  res.json(outputTree());
}));

function archiveEntries(full: string): Promise<string[]> {
  return new Promise((resolve, reject) => {
    yauzl.open(full, { lazyEntries: true }, (error, zip) => {
      if (error) {
        reject(error);
        return;
      }
      const names: string[] = [];
      let finished = false;
      const finish = (failure?: Error) => {
        if (finished) return;
        finished = true;
        try { zip.close(); } catch { /* already closed */ }
        if (failure) reject(failure);
        else resolve(names);
      };
      zip.on("entry", (entry) => {
        const name = entry.fileName;
        if (!name.endsWith("/")) names.push(name);
        if (names.length >= 100) {
          finish();
          return;
        }
        zip.readEntry();
      });
      zip.on("end", () => finish());
      zip.on("error", (failure) => finish(failure));
      zip.readEntry();
    });
  });
}

app.get("/api/artifacts/archive", wrap(async (req, res) => {
  const rel = String(req.query.path ?? "");
  const full = safeOutputFile(rel);
  if (path.extname(full).toLowerCase() !== ".zip") fail("仅支持 ZIP 产物索引");
  const allowed = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg", ".avif", ".bmp", ".html", ".htm", ".mp4", ".webm", ".mov", ".m4v", ".mp3", ".wav", ".ogg", ".m4a", ".flac", ".pdf"]);
  const base = path.dirname(full);
  const root = path.resolve(OUTPUTS_DIR);
  const paths: string[] = [];
  const seen = new Set<string>();
  const entries = await archiveEntries(full).catch(() => {
    fail("无法读取压缩包索引");
  });
  for (const name of entries) {
    if (!name || name.startsWith("/") || name.includes("\\") || name.split("/").some((part) => !part || part.startsWith(".") || part.startsWith("_"))) continue;
    if (!allowed.has(path.extname(name).toLowerCase())) continue;
    const candidate = path.resolve(base, name);
    if (!candidate.startsWith(`${root}${path.sep}`) || !fs.existsSync(candidate) || !fs.statSync(candidate).isFile()) continue;
    const relName = path.relative(root, candidate).split(path.sep).join("/");
    if (seen.has(relName)) continue;
    seen.add(relName);
    paths.push(relName);
  }
  res.json({ paths });
}));

app.use("/api/output", wrap(async (req, res) => {
  const rel = decodeURIComponent(req.path.replace(/^\/+/, ""));
  if (req.method === "GET") {
    const data = outputContent(rel);
    res.json(data);
    return;
  }
  if (req.method === "DELETE") {
    const result = deleteOutput(rel);
    res.json({ ok: true, ...result });
    return;
  }
  res.status(405).json({ detail: "Method not allowed" });
}));

app.use("/api/media", wrap(async (req, res) => {
  if (req.method !== "GET" && req.method !== "HEAD") {
    res.status(405).json({ detail: "Method not allowed" });
    return;
  }
  const rel = decodeURIComponent(req.path.replace(/^\/+/, ""));
  const full = safeOutputFile(rel);
  const ext = path.extname(full).toLowerCase();
  if (ext === ".html" || ext === ".htm") {
    res.setHeader("Cache-Control", "no-cache, no-store, must-revalidate");
    res.setHeader("Pragma", "no-cache");
  }
  res.sendFile(full);
}));

app.get("/api/upload/limits", wrap(async (_req, res) => {
  res.json({ ok: true, max_mb: MAX_UPLOAD_MB });
}));

const uploadTmp = multer({
  dest: TMP_ROOT,
  limits: { fileSize: MAX_UPLOAD_MB * 1024 * 1024 },
  fileFilter: (_req, file, callback) => {
    const ext = fileExt(file.originalname || "file");
    if (!UPLOAD_EXTS.has(ext)) callback(new Error(`不支持的文件类型：${ext || file.originalname}`));
    else callback(null, true);
  },
});
const uploadLocal = multer({
  dest: TMP_ROOT,
  limits: { fileSize: 2 * 1024 * 1024 * 1024 },
  fileFilter: (_req, file, callback) => {
    const ext = fileExt(file.originalname || "file");
    if (!UPLOAD_EXTS.has(ext)) callback(new Error(`不支持的文件类型：${ext || file.originalname}`));
    else callback(null, true);
  },
});

function storeUploads(req: Request, res: Response): void {
  const id = sessionId(req.body?.sessionId);
  const scope = attachmentScope(id);
  const batch = `${new Date().toISOString().slice(0, 10).replace(/-/g, "")}-${crypto.randomBytes(3).toString("hex")}`;
  const dest = path.join(OUTPUTS_DIR, "_inbox", scope, batch);
  fs.mkdirSync(dest, { recursive: true });
  const files = (req.files as Express.Multer.File[] | undefined) ?? [];
  if (!files.length) fail("没有文件");
  const saved: AttachmentRef[] = [];
  for (const file of files) {
    const target = uniqueTarget(dest, file.originalname || "file");
    try {
      fs.copyFileSync(file.path, target);
    } finally {
      try { fs.unlinkSync(file.path); } catch { /* ignore */ }
    }
    const rel = `_inbox/${scope}/${batch}/${path.basename(target)}`;
    saved.push({ id: attachmentId(scope, rel), name: path.basename(target), path: rel });
  }
  res.json({ ok: true, files: saved });
}

app.post("/api/upload", uploadTmp.array("files"), wrap(async (req, res) => {
  storeUploads(req, res);
}));

app.post("/api/upload/local", uploadLocal.array("files"), wrap(async (req, res) => {
  storeUploads(req, res);
}));

app.post("/api/chat/stream", wrap(async (req, res) => {
  const body = (req.body ?? {}) as Record<string, unknown>;
  const sid = sessionId(body.sessionId);
  const tid = turnId(body.turnId);
  const message = String(body.message ?? "");
  const persona = body.persona ? String(body.persona) : undefined;
  const attachments = Array.isArray(body.attachments) ? (body.attachments as AttachmentRef[]) : [];
  const approval = body.approval === "auto" ? "auto" : "manual";
  const model = body.model === undefined || body.model === "" ? undefined : String(body.model);
  const thinkingLevel = body.thinkingLevel === undefined
    ? undefined
    : normalizeThinkingLevel(body.thinkingLevel);
  if (body.thinkingLevel !== undefined && thinkingLevel === undefined) {
    fail("思考深度无效，只允许 off/minimal/low/medium/high/xhigh/max");
  }
  if (!message.trim() && !attachments.length) fail("消息不能为空");

  sseHeaders(res);
  const job = new JobWriter(tid);
  activeChatTurns.add(tid);
  let failed = false;
  const emit = (kind: string, text?: string, extra?: Record<string, unknown>) => {
    if (kind === "error") failed = true;
    const id = job.write(kind, text, extra);
    writeSse(res, kind, encodeEventData(kind, text, extra), id);
  };
  emit("activity", "⏳ 已收到，正在载入 pi 会话…");
  saveLastTurn(sid, { status: "running", text: "", turn_id: tid });

  let result = "";
  try {
    result = await runChatTurn({
      sessionKey: sid,
      prompt: message,
      persona,
      attachments,
      approval,
      model,
      thinkingLevel: thinkingLevel || undefined,
      turnId: tid,
      emit,
    });
    saveLastTurn(sid, { status: failed ? "failed" : "done", text: result, turn_id: tid });
    emit("done", undefined, { sessionKey: sid });
  } catch (error) {
    const text = error instanceof Error ? error.message : String(error);
    emit("error", text);
    saveLastTurn(sid, { status: "failed", text: `${result}\n\n❌ ${text}`.trim(), turn_id: tid });
    emit("done", undefined, { sessionKey: sid });
  } finally {
    try {
      if (!res.writableEnded && !res.destroyed) res.end();
    } finally {
      activeChatTurns.delete(tid);
    }
  }
}));

app.get("/api/chat/jobs/:turnId/stream", wrap(async (req, res) => {
  const tid = turnId(param(req, "turnId"));
  if (!jobExists(tid)) fail("任务记录不存在或已失效，无法续接；请重新发送", 404);
  const after = Number(req.query.after ?? 0) || 0;
  sseHeaders(res);
  let lastId = after;
  let closed = false;
  let ended = false;
  let sawError = false;
  let heartbeat: NodeJS.Timeout | undefined;
  const cleanup = () => {
    closed = true;
    if (heartbeat) clearInterval(heartbeat);
    if (!res.writableEnded) res.end();
  };
  res.on("close", () => {
    closed = true;
    if (heartbeat) clearInterval(heartbeat);
  });
  const pump = () => {
    if (closed || ended) return;
    for (const item of readJob(tid, lastId)) {
      lastId = item.id;
      writeSse(res, item.event, item.data, item.id);
      if (item.event === "error") sawError = true;
      if (item.event === "done") ended = true;
    }
    if (ended) cleanup();
  };
  pump();
  // No live POST stream owns this job and it never reached a terminal event:
  // the previous process crashed/restarted mid-turn. Finalize it instead of
  // heartbeating "still working" forever.
  if (!ended && !activeChatTurns.has(tid)) {
    const hasError = sawError || readJob(tid).some((item) => item.event === "error");
    if (!hasError) {
      const message = "上一轮任务已中断（后端可能已重启或异常退出），请重新发送。";
      const errorId = appendJobEvent(tid, "error", message);
      writeSse(res, "error", JSON.stringify(message), errorId);
    }
    const doneId = appendJobEvent(tid, "done", undefined, {});
    writeSse(res, "done", JSON.stringify({}), doneId);
    ended = true;
    cleanup();
    return;
  }
  if (!ended) {
    heartbeat = setInterval(() => {
      if (closed) return;
      pump();
      if (!ended) writeSse(res, "heartbeat", JSON.stringify("still working"));
    }, 1000);
  }
  req.on("close", () => {
    if (heartbeat) clearInterval(heartbeat);
  });
}));

app.get("/api/chat/last/:sessionId", wrap(async (req, res) => {
  const sid = sessionId(param(req, "sessionId"));
  const requested = req.query.turn_id ? String(req.query.turn_id) : "";
  if (requested && jobExists(requested)) {
    res.json(reconstructTurn(requested));
    return;
  }
  res.json(readLastTurn(sid));
}));

app.post("/api/chat/approval", wrap(async (req, res) => {
  const body = (req.body ?? {}) as Record<string, unknown>;
  const sid = sessionId(body.sessionId);
  const approval = body.approval === "auto" ? "auto" : "manual";
  res.json({ ok: true, active: setTurnApproval(sid, approval) });
}));

app.post("/api/chat/stop", wrap(async (req, res) => {
  const sid = sessionId((req.body ?? {}).sessionId);
  const stopped = stopTurn(sid);
  res.json({ ok: true, stopped });
}));

app.post("/api/chat/question/answer", wrap(async (req, res) => {
  const body = (req.body ?? {}) as Record<string, unknown>;
  const questionId = String(body.questionId ?? "");
  const answers = body.answers && typeof body.answers === "object" ? (body.answers as Record<string, string[]>) : {};
  if (!questionId) fail("缺少 questionId");
  const result = answerQuestion(questionId, answers);
  res.status(result.ok ? 200 : 409).json(result);
}));

app.post("/api/chat/question/status", wrap(async (req, res) => {
  const ids = Array.isArray((req.body ?? {}).questionIds) ? ((req.body as Record<string, unknown>).questionIds as string[]) : [];
  res.json({ ok: true, questions: questionStatus(ids.map(String)) });
}));

app.post("/api/chat", wrap(async (req, res) => {
  const body = (req.body ?? {}) as Record<string, unknown>;
  const message = String(body.message ?? "");
  const persona = body.persona ? String(body.persona) : undefined;
  if (!message.trim()) fail("消息不能为空");
  const response = await oneShot(message, persona, "chat");
  res.json({ response });
}));

app.delete("/api/session/:sessionKey", wrap(async (req, res) => {
  const sid = sessionId(param(req, "sessionKey"));
  const binding = readBinding(sid);
  let deleted = deleteBinding(sid);
  if (binding?.sessionFile && fs.existsSync(binding.sessionFile)) {
    fs.unlinkSync(binding.sessionFile);
    deleted = true;
  }
  const last = turnFile(sid);
  if (fs.existsSync(last)) {
    fs.unlinkSync(last);
    deleted = true;
  }
  res.json({ deleted });
}));

app.use("/api", accountsRouter());
app.use("/api", calendarRouter());
app.use("/api", profileRouter());
app.use("/api", publishingRouter());

app.use("/api", (req, _res, next) => {
  next(new HttpError(404, `接口不存在：${req.method} ${req.originalUrl}`));
});

app.get("/onepage", wrap(async (_req, res) => {
  const file = path.join(STATIC_DIR, "onepage.html");
  if (!fs.existsSync(file)) fail("未找到 onepage.html", 404);
  res.sendFile(file);
}));
app.use("/static", express.static(STATIC_DIR, { fallthrough: true, index: false }));
app.use("/assets", express.static(path.join(REACT_DIR, "assets"), { fallthrough: true, index: false }));
app.get("/", wrap(async (_req, res) => {
  const index = path.join(REACT_DIR, "index.html");
  if (!fs.existsSync(index)) {
    res.status(503).type("text/plain").send("前端尚未构建。请运行 `npm run build:web`。");
    return;
  }
  res.sendFile(index);
}));
app.use((req, res, next) => {
  if (req.method === "GET" && !req.path.startsWith("/api/")) {
    const index = path.join(REACT_DIR, "index.html");
    if (fs.existsSync(index)) {
      res.sendFile(index);
      return;
    }
  }
  next();
});

app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
  if (res.headersSent) {
    if (!res.writableEnded) res.end();
    return;
  }
  if (error instanceof HttpError) {
    res.status(error.status).json({ detail: error.message });
    return;
  }
  if (error instanceof multer.MulterError) {
    const message = error.code === "LIMIT_FILE_SIZE" ? `文件超过 ${MAX_UPLOAD_MB}MB 上限` : error.message;
    res.status(413).json({ detail: message });
    return;
  }
  const message = error instanceof Error ? error.message : String(error);
  res.status(500).json({ detail: message });
});

ensureDirs();
installHostBridge();
app.listen(PORT, HOST, () => {
  const shown = HOST === "0.0.0.0" ? "localhost" : HOST;
  console.log(`Easel · pi SDK server listening on http://${shown}:${PORT}`);
  console.log(`pi state: ${PI_STATE_DIR}`);
  if (!fs.existsSync(path.join(REACT_DIR, "index.html"))) {
    console.log("Frontend not built yet: npm run build:web");
  }
});

function shutdown(signal: string): void {
  console.log(`\n${signal}: shutting down Easel server…`);
  try {
    fs.rmSync(TMP_ROOT, { recursive: true, force: true });
  } catch {
    // ignore
  }
  process.exit(0);
}
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
