import crypto from "node:crypto";
import path from "node:path";
import { scrubSecrets, type Sandbox } from "../config.js";

export type QuestionOption = { label: string; description?: string };
export interface EaselQuestion {
  questionId: string;
  header?: string;
  question: string;
  detail?: string;
  options: QuestionOption[];
  multiSelect: boolean;
}
export interface QuestionPayload {
  id: string;
  questions: EaselQuestion[];
  expiresAtMs?: number;
}

export type EventSink = (kind: string, text?: string, extra?: Record<string, unknown>) => void;
export type ApprovalMode = "manual" | "auto";

export interface ActiveTurn {
  sessionId: string;
  sessionKey: string;
  sandbox: Sandbox;
  approval: ApprovalMode;
  emit: EventSink;
}

interface PendingQuestion {
  id: string;
  sessionId: string;
  sessionKey: string;
  questions: EaselQuestion[];
  resolve: (answers: Record<string, string[]>) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
  status: "pending" | "resolved" | "cancelled";
}

const activeTurns = new Map<string, ActiveTurn>();
const pendingBySession = new Map<string, Set<string>>();
const pending = new Map<string, PendingQuestion>();

export function registerTurn(turn: ActiveTurn): void {
  activeTurns.set(turn.sessionId, turn);
}

export function setTurnApproval(sessionKey: string, approval: ApprovalMode): boolean {
  let updated = false;
  for (const turn of activeTurns.values()) {
    if (turn.sessionKey !== sessionKey) continue;
    turn.approval = approval;
    turn.emit("activity", `审批模式：${approval === "auto" ? "自动放行后续确认" : "手动确认"}`);
    updated = true;
  }
  return updated;
}

export function unregisterTurn(sessionId: string): void {
  activeTurns.delete(sessionId);
  const ids = pendingBySession.get(sessionId);
  if (ids) {
    for (const id of ids) cancelQuestion(id, "会话已结束，问题已取消");
    pendingBySession.delete(sessionId);
  }
}

function cancelQuestion(id: string, reason: string): void {
  const item = pending.get(id);
  if (!item) return;
  item.status = "cancelled";
  clearTimeout(item.timer);
  pending.delete(id);
  item.reject(new Error(reason));
}

export function cancelSessionQuestions(sessionId: string, reason = "本轮已终止"): void {
  const ids = pendingBySession.get(sessionId);
  if (!ids) return;
  for (const id of [...ids]) cancelQuestion(id, reason);
  pendingBySession.delete(sessionId);
}

export async function ask(
  sessionId: string,
  rawQuestions: unknown[],
  timeoutSeconds?: number,
): Promise<Record<string, string[]>> {
  const turn = activeTurns.get(sessionId);
  if (!turn) throw new Error("ask_user 只能在 Easel 对话轮次中调用");
  const questions = normalizeQuestions(rawQuestions);
  if (!questions.length) throw new Error("ask_user 至少需要一个有效问题");
  if (questions.length > 3) throw new Error("ask_user 一次最多 3 个问题");
  for (const question of questions) {
    if (question.options.length > 4) throw new Error("ask_user 每题最多 4 个选项");
  }

  const id = `ask_${crypto.randomUUID().replace(/-/g, "")}`;
  const seconds = Math.max(1, Math.min(3600, Number(timeoutSeconds) || 300));
  const payload: QuestionPayload = {
    id,
    questions,
    expiresAtMs: Date.now() + seconds * 1000,
  };

  return await new Promise<Record<string, string[]>>((resolve, reject) => {
    const timer = setTimeout(() => {
      const item = pending.get(id);
      if (!item) return;
      item.status = "cancelled";
      pending.delete(id);
      pendingBySession.get(sessionId)?.delete(id);
      turn.emit("activity", "问答题等待超时，Agent 将按无回答继续");
      reject(new Error("等待用户回答超时"));
    }, seconds * 1000);
    pending.set(id, {
      id,
      sessionId,
      sessionKey: turn.sessionKey,
      questions,
      resolve,
      reject,
      timer,
      status: "pending",
    });
    const set = pendingBySession.get(sessionId) ?? new Set<string>();
    set.add(id);
    pendingBySession.set(sessionId, set);
    turn.emit("question", undefined, payload as unknown as Record<string, unknown>);
  });
}

export function answerQuestion(
  id: string,
  answers: Record<string, string[]>,
): { ok: boolean; error?: string } {
  const item = pending.get(id);
  if (!item) return { ok: false, error: "该问题已结束或不存在" };
  if (item.status !== "pending") return { ok: false, error: "该问题已作答" };
  const normalized: Record<string, string[]> = {};
  for (const question of item.questions) {
    const values = (answers[question.questionId] ?? []).map((value) => String(value).trim()).filter(Boolean);
    if (!values.length) return { ok: false, error: `问题「${question.questionId}」需要回答` };
    if (!question.multiSelect && values.length > 1) {
      return { ok: false, error: `问题「${question.questionId}」不支持多选` };
    }
    normalized[question.questionId] = values;
  }
  item.status = "resolved";
  clearTimeout(item.timer);
  pending.delete(id);
  pendingBySession.get(item.sessionId)?.delete(id);
  item.resolve(normalized);
  return { ok: true };
}

export function questionStatus(ids: string[]): Record<string, { status: string }> {
  const result: Record<string, { status: string }> = {};
  for (const id of ids) {
    const item = pending.get(id);
    result[id] = { status: item ? "pending" : "expired" };
  }
  return result;
}

function normalizeQuestions(raw: unknown[]): EaselQuestion[] {
  const questions: EaselQuestion[] = [];
  for (const [index, value] of raw.entries()) {
    if (!value || typeof value !== "object") continue;
    const item = value as Record<string, unknown>;
    const question = String(item.question ?? "").trim();
    if (!question) continue;
    const questionId = String(item.questionId ?? item.id ?? `q${index + 1}`).trim() || `q${index + 1}`;
    const options = Array.isArray(item.options)
      ? item.options
          .map((option) => {
            if (!option || typeof option !== "object") return undefined;
            const opt = option as Record<string, unknown>;
            const label = String(opt.label ?? "").trim();
            if (!label) return undefined;
            return {
              label: label.slice(0, 80),
              ...(opt.description ? { description: String(opt.description).slice(0, 300) } : {}),
            };
          })
          .filter((option): option is QuestionOption => Boolean(option))
      : [];
    questions.push({
      questionId: questionId.slice(0, 80),
      ...(item.header ? { header: String(item.header).slice(0, 40) } : {}),
      question: question.slice(0, 2000),
      ...(item.detail ? { detail: String(item.detail).slice(0, 3000) } : {}),
      options,
      multiSelect: item.multiSelect === true,
    });
  }
  return questions;
}

type Decision = { action: "allow" | "deny" | "ask"; reason?: string; title?: string; detail?: string };

const SAFE_READ_TOOLS = new Set(["read", "grep", "find", "ls", "web_search", "web_extract"]);
const SAFE_BASH =
  /^(pwd|ls|cat|head|tail|wc|sed\s+-n|grep|rg|find|which|command\s+-v|git\s+(status|diff|log|show)|python(3|\.\d+)?\s+(-V|--version)|node\s+(-v|--version)|npm\s+(-v|--version)|ffmpeg\s+-version)\b/;
// Read-only mode allows simple inspection commands only. Shell separators,
// pipes, redirects and command substitution would let a command chain past the
// first safe word and mutate files, so reject the whole command.
const READ_ONLY_UNSAFE = /[;&|<>`\r\n]|\$\(/;
const READ_ONLY_MUTATING_FLAGS = /\s-(delete|exec|execdir|ok|okdir|fprint|fprint0|fprintf|fls)\b|\s--(pre|pre-glob|output)\b/;
const DANGEROUS_BASH =
  /(\bsudo\b|\brm\s+(-[a-z]*[rf][a-z]*|--recursive|--force)\b|\bgit\s+push\b|\bcurl\b|\bwget\b|\bnpm\s+(install|i)\b|\bpnpm\s+(add|install)\b|\byarn\s+add\b|\bpip\s+install\b|\bchmod\b|\bchown\b|\bdd\b|\bmkfs\b|\bshutdown\b|\breboot\b|\bkill\b)/i;

function inside(root: string, target: string): boolean {
  const resolvedRoot = path.resolve(root);
  const resolvedTarget = path.resolve(root, target);
  return resolvedTarget === resolvedRoot || resolvedTarget.startsWith(`${resolvedRoot}${path.sep}`);
}

function pathOf(input: unknown): string {
  if (!input || typeof input !== "object") return "";
  const value = input as Record<string, unknown>;
  return String(value.path ?? value.file_path ?? value.filePath ?? "");
}

export async function permission(
  sessionId: string,
  event: { toolName: string; input: unknown; cwd: string },
): Promise<Decision> {
  const turn = activeTurns.get(sessionId);
  const sandbox = turn?.sandbox ?? "workspace-write";
  const tool = event.toolName;
  const finish = (decision: Decision): Decision => {
    if (!turn || turn.approval !== "auto" || decision.action !== "ask") return decision;
    turn.emit("activity", `已自动放行：${tool}`);
    return { action: "allow" };
  };
  if (SAFE_READ_TOOLS.has(tool)) return finish({ action: "allow" });

  if (tool === "write" || tool === "edit") {
    if (sandbox === "read-only") {
      return finish({ action: "deny", reason: "当前为只读权限，不能修改文件" });
    }
    const target = pathOf(event.input);
    if (target && !inside(event.cwd, target)) {
      return finish({
        action: "ask",
        title: "允许在工作区外修改文件？",
        detail: target,
      });
    }
    return finish({ action: "allow" });
  }

  if (tool === "bash") {
    const command =
      event.input && typeof event.input === "object"
        ? String((event.input as Record<string, unknown>).command ?? "")
        : "";
    if (sandbox === "read-only") {
      const safe = SAFE_BASH.test(command.trim())
        && !READ_ONLY_UNSAFE.test(command)
        && !READ_ONLY_MUTATING_FLAGS.test(command);
      if (safe) return finish({ action: "allow" });
      return finish({ action: "deny", reason: "当前为只读权限，只允许不含管道、重定向或修改操作的只读命令" });
    }
    if (DANGEROUS_BASH.test(command)) {
      return finish({
        action: "ask",
        title: "允许执行此命令？",
        detail: command.slice(0, 3000),
      });
    }
    return finish({ action: "allow" });
  }

  return finish({
    action: "ask",
    title: `允许使用工具「${tool}」？`,
    detail: scrubSecrets(JSON.stringify(event.input)).slice(0, 3000),
  });
}

export interface HostBridge {
  ask(sessionId: string, questions: unknown[], timeoutSeconds?: number): Promise<Record<string, string[]>>;
  permission(
    sessionId: string,
    event: { toolName: string; input: unknown; cwd: string },
  ): Promise<Decision>;
}

export const hostBridge: HostBridge = { ask, permission };

export function installHostBridge(): void {
  (globalThis as { __easelPiHost?: HostBridge }).__easelPiHost = hostBridge;
}
