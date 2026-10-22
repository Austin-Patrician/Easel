import assert from "node:assert/strict";
import { test } from "node:test";
import {
  answerQuestion,
  ask,
  permission,
  registerTurn,
  setTurnApproval,
  unregisterTurn,
  type EventSink,
} from "./host.js";

type Captured = { kind: string; text?: string; extra?: Record<string, unknown> };

function register(
  sessionId: string,
  sandbox: "read-only" | "workspace-write" = "workspace-write",
  approval: "manual" | "auto" = "manual",
): Captured[] {
  const events: Captured[] = [];
  const emit: EventSink = (kind, text, extra) => {
    events.push({ kind, text, extra });
  };
  registerTurn({ sessionId, sessionKey: `key-${sessionId}`, sandbox, approval, emit });
  return events;
}

test("ask_user emits a question card and resolves the submitted answers", async () => {
  const events = register("ask-session");
  const pending = ask("ask-session", [{
    questionId: "confirm",
    question: "继续吗？",
    options: [{ label: "继续" }, { label: "取消" }],
  }], 5);

  const question = events.find((item) => item.kind === "question");
  assert.ok(question?.extra);
  const payload = question.extra as { id: string };
  assert.ok(payload.id.startsWith("ask_"));
  assert.equal(answerQuestion(payload.id, { confirm: ["继续"] }).ok, true);
  assert.deepEqual(await pending, { confirm: ["继续"] });
  unregisterTurn("ask-session");
});

test("read-only bash accepts simple inspection but rejects command chaining", async () => {
  register("read-only-session", "read-only");
  assert.equal((await permission("read-only-session", {
    toolName: "bash", input: { command: "git status" }, cwd: process.cwd(),
  })).action, "allow");
  assert.equal((await permission("read-only-session", {
    toolName: "bash", input: { command: "find . -name '*.md'" }, cwd: process.cwd(),
  })).action, "allow");
  assert.equal((await permission("read-only-session", {
    toolName: "bash", input: { command: "ls; rm -rf outputs" }, cwd: process.cwd(),
  })).action, "deny");
  assert.equal((await permission("read-only-session", {
    toolName: "bash", input: { command: "find . -delete" }, cwd: process.cwd(),
  })).action, "deny");
  unregisterTurn("read-only-session");
});

test("workspace-write asks before recursive deletes and outside-workspace writes", async () => {
  register("write-session");
  assert.equal((await permission("write-session", {
    toolName: "bash", input: { command: "rm -rf ~/project-copy" }, cwd: process.cwd(),
  })).action, "ask");
  assert.equal((await permission("write-session", {
    toolName: "write", input: { path: "/tmp/outside.txt" }, cwd: process.cwd(),
  })).action, "ask");
  assert.equal((await permission("write-session", {
    toolName: "write", input: { path: "outputs/note.txt" }, cwd: process.cwd(),
  })).action, "allow");
  unregisterTurn("write-session");
});

test("auto approval allows ask decisions but keeps hard denials", async () => {
  const events = register("auto-session", "workspace-write", "auto");
  assert.equal((await permission("auto-session", {
    toolName: "bash", input: { command: "curl https://example.com" }, cwd: process.cwd(),
  })).action, "allow");
  assert.ok(events.some((item) => item.kind === "activity" && item.text?.includes("已自动放行")));
  assert.equal((await permission("auto-session", {
    toolName: "write", input: { path: "/tmp/outside.txt" }, cwd: process.cwd(),
  })).action, "allow");
  unregisterTurn("auto-session");

  register("auto-read-only", "read-only", "auto");
  assert.equal((await permission("auto-read-only", {
    toolName: "bash", input: { command: "ls; rm -rf outputs" }, cwd: process.cwd(),
  })).action, "deny");
  unregisterTurn("auto-read-only");
});

test("approval mode can switch while the turn is running", async () => {
  const events = register("switch-session");
  assert.equal(setTurnApproval("key-switch-session", "auto"), true);
  assert.equal(events.at(-1)?.text, "审批模式：自动放行后续确认");
  assert.equal((await permission("switch-session", {
    toolName: "bash", input: { command: "curl https://example.com" }, cwd: process.cwd(),
  })).action, "allow");
  assert.equal(setTurnApproval("key-switch-session", "manual"), true);
  assert.equal((await permission("switch-session", {
    toolName: "bash", input: { command: "curl https://example.com" }, cwd: process.cwd(),
  })).action, "ask");
  unregisterTurn("switch-session");
});
