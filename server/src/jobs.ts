import fs from "node:fs";
import path from "node:path";
import { jobEventFile, readJson, turnFile, writeJson } from "./config.js";

export interface JobEvent {
  id: number;
  event: string;
  data: string;
}

export class JobWriter {
  readonly file: string;
  private seq = 0;

  constructor(readonly turnId: string) {
    this.file = jobEventFile(turnId);
    fs.mkdirSync(fileDir(this.file), { recursive: true });
    fs.writeFileSync(this.file, "", "utf8");
  }

  nextId(): number {
    this.seq += 1;
    return this.seq;
  }

  write(event: string, text?: string, extra?: Record<string, unknown>): number {
    const id = this.nextId();
    let data: string;
    if (event === "question") data = JSON.stringify(extra ?? {});
    else if (event === "done") data = JSON.stringify(extra ?? {});
    else data = JSON.stringify(text ?? "");
    const line = JSON.stringify({ id, event, data });
    try {
      fs.appendFileSync(this.file, `${line}\n`, "utf8");
    } catch {
      // A vanished job file must not break the live SSE response.
    }
    return id;
  }
}

function fileDir(file: string): string {
  return path.dirname(file);
}

export function readJob(turnId: string, after = 0): JobEvent[] {
  const file = jobEventFile(turnId);
  if (!fs.existsSync(file)) return [];
  const events: JobEvent[] = [];
  for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const parsed = JSON.parse(line) as JobEvent;
      if (typeof parsed.id === "number" && parsed.id > after && typeof parsed.event === "string") {
        events.push(parsed);
      }
    } catch {
      // ignore partial/corrupt line
    }
  }
  return events;
}

export function jobExists(turnId: string): boolean {
  return fs.existsSync(jobEventFile(turnId));
}

export interface LastTurn {
  status: "running" | "done" | "failed" | "unknown";
  text: string;
  turn_id?: string;
}

export function saveLastTurn(sessionKey: string, value: LastTurn): void {
  writeJson(turnFile(sessionKey), { ...value, sessionKey, updatedAt: Date.now() });
}

export function readLastTurn(sessionKey: string): LastTurn {
  const value = readJson<Record<string, unknown>>(turnFile(sessionKey));
  if (!value) return { status: "unknown", text: "" };
  return {
    status: (["running", "done", "failed", "unknown"].includes(String(value.status))
      ? value.status
      : "unknown") as LastTurn["status"],
    text: typeof value.text === "string" ? value.text : "",
    ...(typeof value.turn_id === "string" ? { turn_id: value.turn_id } : {}),
  };
}

export function reconstructTurn(turnId: string): LastTurn {
  const events = readJob(turnId);
  let text = "";
  let status: LastTurn["status"] = "running";
  let error = "";
  for (const item of events) {
    let textValue = "";
    try {
      textValue = JSON.parse(item.data) as string;
    } catch {
      textValue = item.data;
    }
    if (item.event === "token") text += textValue;
    else if (item.event === "error") {
      error = textValue;
      status = "failed";
    } else if (item.event === "done") {
      status = "done";
    }
  }
  if (status === "failed" && error) text = `${text}\n\n❌ ${error}`;
  return { status, text, turn_id: turnId };
}
