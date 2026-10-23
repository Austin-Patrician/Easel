import assert from "node:assert/strict";
import fs from "node:fs";
import { test } from "node:test";
import { jobEventFile } from "./config.js";
import { appendJobEvent, readJob, reconstructTurn } from "./jobs.js";

test("appendJobEvent preserves existing events and appends a terminal pair", () => {
  const turnId = `test-job-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const file = jobEventFile(turnId);
  try {
    appendJobEvent(turnId, "activity", "working");
    appendJobEvent(turnId, "error", "boom");
    appendJobEvent(turnId, "done", undefined, { sessionKey: "session-1" });
    const events = readJob(turnId);
    assert.deepEqual(events.map((item) => [item.id, item.event]), [
      [1, "activity"],
      [2, "error"],
      [3, "done"],
    ]);
    assert.deepEqual(JSON.parse(events[2].data), { sessionKey: "session-1" });
    const restored = reconstructTurn(turnId);
    assert.equal(restored.status, "failed");
    assert.match(restored.text, /boom/);
  } finally {
    if (fs.existsSync(file)) fs.unlinkSync(file);
  }
});
