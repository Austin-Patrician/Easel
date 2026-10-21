#!/usr/bin/env node
import crypto from "node:crypto";
import path from "node:path";
import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { PI_AGENT_DIR, PROJECT_ROOT, ensureDirs } from "./config.js";
import { installHostBridge, answerQuestion } from "./pi/host.js";
import { runChatTurn } from "./pi/chat.js";
import { findSkill } from "./content.js";
import { createModelRuntime, listModels, modelRuntimePathHints } from "./pi/models.js";

function parse(argv: string[]): { command: string; flags: Record<string, string>; rest: string[] } {
  const [command = "chat", ...items] = argv;
  const flags: Record<string, string> = {};
  const rest: string[] = [];
  for (let i = 0; i < items.length; i += 1) {
    const item = items[i];
    if (item.startsWith("--")) {
      const name = item.slice(2);
      const value = items[i + 1] && !items[i + 1].startsWith("--") ? items[++i] : "true";
      flags[name] = value;
    } else {
      rest.push(item);
    }
  }
  return { command, flags, rest };
}

function questionText(payload: Record<string, unknown>, rl: readline.Interface): Promise<void> {
  return (async () => {
    const id = String(payload.id ?? "");
    const questions = Array.isArray(payload.questions) ? payload.questions as Array<Record<string, unknown>> : [];
    const answers: Record<string, string[]> = {};
    output.write("\n");
    for (const item of questions) {
      const qid = String(item.questionId ?? "");
      const header = item.header ? `【${String(item.header)}】` : "";
      output.write(`${header}${String(item.question ?? "")}\n`);
      const options = Array.isArray(item.options) ? item.options as Array<Record<string, unknown>> : [];
      options.forEach((option, index) => output.write(`  ${index + 1}. ${String(option.label ?? "")}${option.description ? ` — ${String(option.description)}` : ""}\n`));
      const raw = await rl.question("回答：");
      const index = Number(raw) - 1;
      const values = item.multiSelect === true
        ? raw.split(/[,，\s]+/).filter(Boolean).map((value) => {
            const number = Number(value) - 1;
            return options[number] ? String(options[number].label) : value;
          })
        : [options[index] ? String(options[index].label) : raw.trim()];
      answers[qid] = values.filter(Boolean);
    }
    const result = answerQuestion(id, answers);
    if (!result.ok) output.write(`回答未提交：${result.error ?? "未知错误"}\n`);
  })();
}

async function chat(flags: Record<string, string>): Promise<number> {
  const rl = readline.createInterface({ input, output });
  const persona = flags.persona;
  const sessionKey = flags.session || `cli-${Date.now()}`;
  output.write(`Easel · pi SDK · 会话 ${sessionKey}${persona ? ` · 画像 ${persona}` : ""}\n输入 /exit 退出。\n`);
  let pendingQuestion = false;
  try {
    for (;;) {
      const message = await rl.question("\n你 › ");
      if (!message.trim()) continue;
      if (message.trim() === "/exit" || message.trim() === "/quit") break;
      pendingQuestion = false;
      await runChatTurn({
        sessionKey,
        prompt: message,
        persona,
        turnId: crypto.randomUUID().replace(/-/g, ""),
        emit: (kind, text, extra) => {
          if (kind === "token" && text) output.write(text);
          else if (kind === "thinking" && text && flags.thinking === "true") output.write(`\n[思考] ${text}`);
          else if (kind === "activity" && text) output.write(`\n〔${text}〕\n`);
          else if (kind === "error" && text) output.write(`\n❌ ${text}\n`);
          else if (kind === "question" && extra) {
            pendingQuestion = true;
            void questionText(extra, rl).catch((error) => output.write(`\n问题处理失败：${error instanceof Error ? error.message : String(error)}\n`));
          }
          if (kind === "done" && !pendingQuestion) output.write("\n");
        },
      });
    }
    return 0;
  } finally {
    rl.close();
  }
}

async function skill(args: string[], flags: Record<string, string>): Promise<number> {
  const requested = args[0] || "";
  const full = findSkill(requested);
  if (!full) {
    output.write(`SKILL '${requested}' 不存在\n`);
    return 1;
  }
  const text = flags.input || flags.i || "";
  if (!text.trim()) {
    output.write("缺少 --input\n");
    return 1;
  }
  const rl = readline.createInterface({ input, output });
  try {
    let failed = false;
    await runChatTurn({
      sessionKey: `cli-skill-${Date.now()}`,
      prompt: `请执行 /${full}，内容如下：\n\n${text}`,
      persona: flags.persona,
      turnId: crypto.randomUUID().replace(/-/g, ""),
      emit: (kind, value, extra) => {
        if (kind === "token" && value) output.write(value);
        else if (kind === "activity" && value) output.write(`\n〔${value}〕\n`);
        else if (kind === "error" && value) {
          failed = true;
          output.write(`\n❌ ${value}\n`);
        } else if (kind === "question" && extra) {
          void questionText(extra, rl);
        }
      },
    });
    output.write("\n");
    return failed ? 1 : 0;
  } finally {
    rl.close();
  }
}


async function doctor(): Promise<number> {
  output.write(`Easel doctor\n`);
  output.write(`  node       ${process.version}\n`);
  output.write(`  project    ${PROJECT_ROOT}\n`);
  output.write(`  pi agent   ${PI_AGENT_DIR}\n`);
  const hints = modelRuntimePathHints();
  output.write(`  auth.json  ${hints.authPath}\n`);
  output.write(`  models.json ${hints.modelsPath}\n`);
  try {
    const runtime = await createModelRuntime();
    const models = await listModels(runtime);
    output.write(`  models     ${models.length ? models.map((item) => item.id).slice(0, 8).join(", ") : "none"}\n`);
    if (!models.length) {
      output.write("\n没有可用模型。运行 `pi` 完成 /login，或在 .env 配置 EASEL_DIRECT_API_*。\n");
      return 1;
    }
  } catch (error) {
    output.write(`  models     error: ${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
  return 0;
}

async function ping(): Promise<number> {
  try {
    const runtime = await createModelRuntime();
    const models = await listModels(runtime);
    output.write(models.length ? `pi OK · ${models.length} model(s) available\n` : "pi has no available model\n");
    return models.length ? 0 : 1;
  } catch (error) {
    output.write(`pi unavailable: ${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}

const USAGE = `Easel CLI（pi SDK）

用法：
  easel chat [--persona NAME] [--session KEY] [--thinking]
  easel skill <name> --input "..." [--persona NAME]
  easel doctor
  easel ping
  easel web [--host HOST] [--port PORT]

模型认证：运行 pi 并执行 /login，或在 .env 配置 EASEL_DIRECT_API_*。
`;

async function main(): Promise<number> {
  ensureDirs();
  installHostBridge();
  const { command, flags, rest } = parse(process.argv.slice(2));
  if (command === "chat") return chat(flags);
  if (command === "skill") return skill(rest, flags);
  if (command === "doctor") return doctor();
  if (command === "ping") return ping();
  if (command === "help" || command === "--help" || command === "-h") {
    output.write(USAGE);
    return 0;
  }
  output.write(`未知命令：${command}\n\n${USAGE}`);
  return 1;
}

main().then((code) => process.exitCode = code).catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack || error.message : String(error)}\n`);
  process.exitCode = 1;
});
