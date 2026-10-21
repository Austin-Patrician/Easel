import fs from "node:fs";
import path from "node:path";
import {
  DefaultResourceLoader,
  SettingsManager,
  type ResourceLoader,
} from "@earendil-works/pi-coding-agent";
import { PI_AGENT_DIR, PROJECT_ROOT, SKILLS_DIR, type Sandbox } from "../config.js";

const WORKSPACE_DIR = path.join(PROJECT_ROOT, "agents", "workspace");

export function easelInstructions(sandbox: Sandbox): string {
  const documents = fs.existsSync(WORKSPACE_DIR)
    ? fs
        .readdirSync(WORKSPACE_DIR)
        .filter((name) => name.endsWith(".md"))
        .sort((a, b) => {
          const rank = (name: string) => (name === "SOUL.md" ? 0 : name === "AGENTS.md" ? 1 : 2);
          return rank(a) - rank(b) || a.localeCompare(b);
        })
        .map((name) => `## 共享工作区：${name}\n\n${fs.readFileSync(path.join(WORKSPACE_DIR, name), "utf8")}`)
        .join("\n\n")
    : "";
  const python = process.platform === "win32"
    ? path.join(PROJECT_ROOT, ".venv", "Scripts", "python.exe")
    : path.join(PROJECT_ROOT, ".venv", "bin", "python");
  return `${documents}

## 运行时项目根与执行引擎

当前执行引擎：pi（唯一 Agent 底座，TypeScript SDK 进程内运行）；权限范围：${sandbox}。
只使用 pi 真实提供的工具，不冒充其它引擎。工具权限由 Easel 的 pi 权限扩展在每次调用前判定；
需要额外授权时会向用户展示确认卡片。公开发布、修改账号状态和其它不可逆操作必须先取得明确同意。
项目根绝对路径：${PROJECT_ROOT}；先切换到该目录再运行项目脚本。
技能库：${path.join(SKILLS_DIR, "builtin")}；共享脚本：${path.join(SKILLS_DIR, "shared", "scripts")}。
每个 SKILL.md 是流程规范，不要求使用原生 /skill 命令；先读取对应技能再执行。
Python 优先使用 ${python}；产物保存到 ${path.join(PROJECT_ROOT, "outputs")}。
账号画像位于 ${path.join(PROJECT_ROOT, "profiles")}；直接使用该实际路径。
遵循用户选择的画像和每轮技能提醒。配置检查只使用项目 .env 的脱敏结果，不回显凭证。
不要泄露凭证、私有配置或内部地址。`;
}

export function createResourceLoader(sandbox: Sandbox): ResourceLoader {
  const settingsManager = SettingsManager.create(PROJECT_ROOT, PI_AGENT_DIR);
  const extensions = [
    path.join(PROJECT_ROOT, "server", "extensions", "ask-user.ts"),
    path.join(PROJECT_ROOT, "server", "extensions", "permissions.ts"),
  ].filter((file) => fs.existsSync(file));
  return new DefaultResourceLoader({
    cwd: PROJECT_ROOT,
    agentDir: PI_AGENT_DIR,
    settingsManager,
    additionalExtensionPaths: extensions,
    additionalSkillPaths: [path.join(SKILLS_DIR, "builtin")],
    noContextFiles: true,
    appendSystemPrompt: [easelInstructions(sandbox)],
  });
}
