import assert from "node:assert/strict";
import { test } from "node:test";
import { terminalAssistantError } from "./chat.js";

test("terminalAssistantError ignores failures that pi will retry", () => {
  assert.equal(terminalAssistantError([
    { role: "assistant", stopReason: "error", errorMessage: "HTTP 500" },
  ], true), "");
});

test("terminalAssistantError reports the final assistant failure", () => {
  assert.equal(terminalAssistantError([
    { role: "user", content: "hi" },
    { role: "assistant", stopReason: "error", errorMessage: "invalid model" },
    { role: "toolResult", toolName: "bash" },
  ], false), "invalid model");
});

test("terminalAssistantError ignores successful and aborted turns", () => {
  assert.equal(terminalAssistantError([
    { role: "assistant", stopReason: "stop" },
  ], false), "");
  assert.equal(terminalAssistantError([
    { role: "assistant", stopReason: "aborted" },
  ], false), "");
  assert.equal(terminalAssistantError([], false), "");
});

test("terminalAssistantError only inspects the latest assistant message", () => {
  assert.equal(terminalAssistantError([
    { role: "assistant", stopReason: "error", errorMessage: "old failure" },
    { role: "assistant", stopReason: "stop" },
  ], false), "");
});
