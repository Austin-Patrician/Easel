import fs from "node:fs";
import path from "node:path";
import { PROFILES_DIR, validPersonaName } from "./config.js";

export const FILE_ORDER = [
  "identity.md",
  "style.md",
  "audience.md",
  "platforms.md",
  "preferences.md",
  "memory.md",
];

export function personaExists(name: string): boolean {
  return validPersonaName(name) && fs.existsSync(path.join(PROFILES_DIR, name));
}

export function listPersonaNames(): string[] {
  if (!fs.existsSync(PROFILES_DIR)) return [];
  return fs
    .readdirSync(PROFILES_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && validPersonaName(entry.name))
    .map((entry) => entry.name)
    .sort();
}

export interface PersonaSummary {
  name: string;
  description: string;
}

export function listPersonas(): PersonaSummary[] {
  return listPersonaNames().map((name) => {
    let description = "";
    const identity = path.join(PROFILES_DIR, name, "identity.md");
    if (fs.existsSync(identity)) {
      for (const line of fs.readFileSync(identity, "utf8").split(/\r?\n/)) {
        const stripped = line.trim();
        if (stripped && !stripped.startsWith("#") && !stripped.startsWith("<!--")) {
          description = stripped.slice(0, 80);
          break;
        }
      }
    }
    return { name, description };
  });
}

export function loadProfileText(name: string): string {
  if (!validPersonaName(name)) return "";
  const directory = path.join(PROFILES_DIR, name);
  if (!fs.existsSync(directory)) return "";
  const parts: string[] = [];
  for (const filename of FILE_ORDER) {
    const file = path.join(directory, filename);
    if (!fs.existsSync(file)) continue;
    const text = fs.readFileSync(file, "utf8").trim();
    if (text) parts.push(text);
  }
  const extra = fs
    .readdirSync(directory)
    .filter((filename) => filename.endsWith(".md") && !FILE_ORDER.includes(filename))
    .sort();
  for (const filename of extra) {
    const text = fs.readFileSync(path.join(directory, filename), "utf8").trim();
    if (text) parts.push(text);
  }
  return parts.join("\n\n---\n\n");
}

export function personaPrefix(name?: string | null): string {
  if (!name || !personaExists(name)) return "";
  return (
    `我当前使用的画像是「${name}」。` +
    `本会话的账号长期记忆仅使用 profiles/${name}/memory.md，` +
    "不要使用工作区全局 MEMORY.md 作为账号记忆。"
  );
}

export const TURN_REMINDER =
  "〔内部提醒·非用户所说，勿复述、勿回显〕本轮动手前先查技能库：" +
  "有对应或相邻的 SKILL 就读进来、按它的流程/数据源/工具做，别凭记忆或通用知识裸做；" +
  "五层（含制作层：图文/图/视频/成片/长稿等）都由你自己按对应 SKILL 产出成品文件到 outputs/；" +
  "问「我的账号/帖子/粉丝/最近发了啥」先查已登录账号、别回问用户要账号名；" +
  "要发到公开平台的文案/评论绝不写入密钥/内部地址/代理/路径/env 名等敏感信息，也别随手自曝「由 AI 生成/某工具做的」。";

export function chatTurnMessage(userMessage: string, persona?: string | null): string {
  const prefix = personaPrefix(persona);
  const head = prefix ? `${prefix}\n\n` : "";
  return `${head}${userMessage}\n\n${TURN_REMINDER}`;
}
