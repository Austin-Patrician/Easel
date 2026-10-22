import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  createAgentSession,
  SessionManager,
  SettingsManager,
  type AgentSession,
} from "@earendil-works/pi-coding-agent";
import {
  OUTPUTS_DIR,
  PI_AGENT_DIR,
  PROJECT_ROOT,
  PI_SESSION_DIR,
  harnessSettings,
  readBinding,
  writeBinding,
  scrubSecrets,
  type Sandbox,
  type ThinkingLevel,
} from "../config.js";
import { chatTurnMessage } from "../persona.js";
import { applyBuiltinCapabilities, createModelRuntime, resolveConfiguredModel } from "./models.js";
import { createResourceLoader } from "./prompt.js";
import { createEaselUI } from "./ui.js";
import { cancelSessionQuestions, registerTurn, unregisterTurn, type ApprovalMode, type EventSink } from "./host.js";

export interface AttachmentRef {
  id: string;
  name: string;
  path: string;
}

export interface ChatTurnRequest {
  sessionKey: string;
  prompt: string;
  persona?: string;
  attachments?: AttachmentRef[];
  model?: string;
  thinkingLevel?: ThinkingLevel;
  sandbox?: Sandbox;
  approval?: ApprovalMode;
  turnId: string;
  emit: EventSink;
}

export interface RunningTurn {
  session: AgentSession;
  abort: () => void;
  stopped: boolean;
}

const locks = new Map<string, Promise<void>>();
const running = new Map<string, RunningTurn>();
const stopped = new Set<string>();

export function runningTurn(sessionKey: string): RunningTurn | undefined {
  return running.get(sessionKey);
}

export function stopTurn(sessionKey: string): boolean {
  const item = running.get(sessionKey);
  if (!item) return false;
  item.stopped = true;
  stopped.add(sessionKey);
  cancelSessionQuestions(item.session.sessionId, "用户停止了本轮");
  void item.session.abort().catch(() => {});
  return true;
}

export function clearStopped(sessionKey: string): void {
  stopped.delete(sessionKey);
}

async function serialize<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const previous = locks.get(key) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  const chained = previous.then(() => current);
  locks.set(key, chained);
  await previous;
  try {
    return await fn();
  } finally {
    release();
    if (locks.get(key) === chained) locks.delete(key);
  }
}

function attachmentScope(sessionKey: string): string {
  return cryptoHash(sessionKey).slice(0, 20);
}

function cryptoHash(value: string): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function attachmentId(scope: string, relative: string): string {
  return cryptoHash(`${scope}\0${relative}`).slice(0, 24);
}

function safeOutputTarget(relative: string): string {
  const full = path.resolve(OUTPUTS_DIR, relative);
  const root = path.resolve(OUTPUTS_DIR);
  if (full === root || !full.startsWith(`${root}${path.sep}`)) {
    throw new Error("附件路径无效");
  }
  return full;
}

export function attachmentContext(sessionKey: string, attachments: AttachmentRef[] | undefined): string {
  if (!attachments?.length) return "";
  const scope = attachmentScope(sessionKey);
  const rows: string[] = [];
  const seen = new Set<string>();
  for (const attachment of attachments) {
    const normalized = String(attachment.path ?? "").replace(/\\/g, "/");
    const parts = normalized.split("/");
    if (!normalized || normalized.startsWith("/") || parts.includes("..") || parts.length !== 4) {
      throw new Error("附件路径无效");
    }
    if (parts[0] !== "_inbox" || parts[1] !== scope) {
      throw new Error("附件不属于当前会话");
    }
    if (attachment.id !== attachmentId(scope, normalized)) {
      throw new Error("附件标识校验失败");
    }
    const full = safeOutputTarget(normalized);
    if (!fs.existsSync(full) || !fs.statSync(full).isFile()) {
      throw new Error(`附件不存在：${attachment.name}`);
    }
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    rows.push(`- outputs/${normalized}`);
  }
  return (
    "〔系统附件清单，仅供本轮执行，不要向用户复述文件上传过程或内部路径〕\n" +
    "只允许使用下列当前会话附件；禁止扫描、枚举或猜测 outputs/_inbox 中的其他文件：\n" +
    rows.join("\n") +
    "\n需要纳入内容项目时，将清单内文件复制到 outputs/<项目>/assets/ 后再使用；" +
    "保留 inbox 原件，确保重试仍可复现。"
  );
}

function bindSessionEvents(session: AgentSession, emit: EventSink): () => void {
  return session.subscribe((event) => {
    switch (event.type) {
      case "message_update": {
        const delta = event.assistantMessageEvent;
        if (delta.type === "text_delta" && delta.delta) emit("token", delta.delta);
        else if (delta.type === "thinking_delta" && delta.delta) emit("thinking", delta.delta);
        else if (delta.type === "toolcall_start") emit("activity", "🔧 正在准备工具调用…");
        else if (delta.type === "error") emit("error", scrubSecrets(delta.error.errorMessage || "模型返回错误"));
        break;
      }
      case "tool_execution_start":
        emit("activity", `🔧 正在执行：${event.toolName}`);
        break;
      case "tool_execution_end":
        if (event.isError) emit("activity", `⚠️ 工具 ${event.toolName} 执行失败，Agent 将继续处理`);
        break;
      case "auto_retry_start":
        emit("activity", `模型请求失败，第 ${event.attempt}/${event.maxAttempts} 次重试…`);
        break;
      case "compaction_start":
        emit("activity", "上下文较长，正在压缩历史…");
        break;
      case "compaction_end":
        if (event.errorMessage) emit("activity", `上下文压缩失败：${event.errorMessage}`);
        break;
      case "agent_settled":
        if (event.aborted) emit("activity", "本轮已终止");
        break;
      default:
        break;
    }
  });
}

function errorText(error: unknown): string {
  if (error instanceof Error) {
    if (/aborted|cancelled|canceled/i.test(error.message)) return "";
    return scrubSecrets(error.message || String(error));
  }
  return scrubSecrets(String(error));
}

export async function runChatTurn(request: ChatTurnRequest): Promise<string> {
  const { sessionKey, emit } = request;
  return serialize(sessionKey, async () => {
    const config = harnessSettings();
    const sandbox = request.sandbox ?? config.sandbox;
    const approval: ApprovalMode = request.approval === "auto" ? "auto" : "manual";
    const thinkingLevel: ThinkingLevel | undefined = request.thinkingLevel ?? (config.thinking || undefined);
    let session: AgentSession | undefined;
    let unsubscribe: (() => void) | undefined;
    const output: string[] = [];
    const capture: EventSink = (kind, text, extra) => {
      if (kind === "token" && text) output.push(text);
      emit(kind, text, extra);
    };

    try {
      const binding = readBinding(sessionKey);
      if (binding && !fs.existsSync(binding.sessionFile)) {
        throw new Error("pi 会话文件不存在，无法续接历史；请新建对话");
      }
      const sessionManager = binding
        ? SessionManager.open(binding.sessionFile, PI_SESSION_DIR, PROJECT_ROOT)
        : SessionManager.create(PROJECT_ROOT, PI_SESSION_DIR);
      const modelRuntime = await createModelRuntime();
      const configured = (request.model ?? config.models.pi ?? "").trim();
      const resolved = resolveConfiguredModel(modelRuntime, configured);
      const model = resolved ? applyBuiltinCapabilities(resolved) : undefined;
      if (configured && !model) {
        throw new Error(`找不到 pi 模型「${configured}」。请检查模型标识或 pi 的 models.json。`);
      }
      if (!model) {
        const available = await modelRuntime.getAvailable();
        if (available.length === 0) {
          throw new Error("pi 还没有可用模型。请在设置页添加供应商、运行 `pi` 完成 /login，或在 .env 配置 EASEL_DIRECT_API_*。");
        }
      }

      const loader = createResourceLoader(sandbox);
      await loader.reload();
      const settingsManager = SettingsManager.create(PROJECT_ROOT, PI_AGENT_DIR);
      const created = await createAgentSession({
        cwd: PROJECT_ROOT,
        agentDir: PI_AGENT_DIR,
        modelRuntime,
        model,
        thinkingLevel,
        resourceLoader: loader,
        sessionManager,
        settingsManager,
        tools: ["read", "bash", "edit", "write", "grep", "find", "ls", "ask_user"],
      });
      session = created.session;
      if (created.extensionsResult.errors.length) {
        const first = created.extensionsResult.errors[0];
        emit("activity", `pi 扩展加载警告：${scrubSecrets(first.error)}`);
      }

      const sessionId = session.sessionId;
      if (!binding) writeBinding(sessionKey, session.sessionFile ?? "");

      registerTurn({ sessionId, sessionKey, sandbox, approval, emit: capture });
      unsubscribe = bindSessionEvents(session, capture);

      await session.bindExtensions({
        uiContext: createEaselUI(sessionId, capture),
        mode: "rpc",
        commandContextActions: {
          waitForIdle: () => session!.waitForIdle(),
          newSession: async () => ({ cancelled: true }),
          fork: async () => ({ cancelled: true }),
          navigateTree: async () => ({ cancelled: true }),
          switchSession: async () => ({ cancelled: true }),
          reload: async () => {
            await session!.reload();
          },
        },
        abortHandler: () => {
          void session?.abort().catch(() => {});
        },
        shutdownHandler: () => {},
        onError: (error) => {
          emit("activity", `pi 扩展错误（${error.event}）：${scrubSecrets(error.error)}`);
        },
      });

      const turn: RunningTurn = {
        session,
        stopped: false,
        abort: () => {
          turn.stopped = true;
          cancelSessionQuestions(sessionId, "用户停止了本轮");
          void session!.abort().catch(() => {});
        },
      };
      running.set(sessionKey, turn);

      let message = (request.prompt ?? "").trim();
      const context = attachmentContext(sessionKey, request.attachments);
      if (context) message = message ? `${message}\n\n${context}` : context;
      if (!message) throw new Error("消息不能为空");
      message = chatTurnMessage(message, request.persona);

      emit("activity", "⏳ 已收到，pi 正在处理…");
      await session.prompt(message, { source: "interactive" });
      return output.join("");
    } catch (error) {
      const message = errorText(error);
      if (message) {
        emit("error", message);
        return `${output.join("")}\n\n❌ ${message}`;
      }
      return output.join("");
    } finally {
      if (session) {
        const sessionId = session.sessionId;
        running.delete(sessionKey);
        unregisterTurn(sessionId);
        unsubscribe?.();
        try {
          session.dispose();
        } catch {
          // ignore disposal races
        }
      }
    }
  });
}
