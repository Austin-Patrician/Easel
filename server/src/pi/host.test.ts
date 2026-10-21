import assert from "node:assert/strict";
import { test } from "node:test";
import {
  answerQuestion,
  ask,
  permission,
  registerTurn,
  unregisterTurn,
  type EventSink,
} from "./host.js";

type Captured = { kind: string; text?: string; extra?: Record<string, unknown> };

function register(sessionId: string, sandbox: "read-only" | "workspace-write" = "workspace-write"): Captured[] {
  const events: Captured[] = [];
  const emit: EventSink = (kind, text, extra) => {
    events.push({ kind, text, extra });
  };
  registerTurn({ sessionId, sessionKey: `key-${sessionId}`, sandbox, emit });
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
