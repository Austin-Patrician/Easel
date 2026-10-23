import fs from "node:fs";
import path from "node:path";
import { OUTPUTS_DIR, PROFILES_DIR, SKILLS_DIR, readEnv, readJson } from "./config.js";
import { FILE_ORDER, listPersonas, loadProfileText, personaExists } from "./persona.js";

const IMAGE_EXTS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".svg", ".avif"]);
const VIDEO_EXTS = new Set([".mp4", ".mov", ".webm", ".m4v"]);
const AUDIO_EXTS = new Set([".mp3", ".wav", ".m4a", ".ogg", ".flac"]);
const TEXT_EXTS = new Set([
  ".md", ".markdown", ".txt", ".json", ".csv", ".html", ".htm", ".srt", ".vtt",
  ".yaml", ".yml", ".toml", ".log", ".xml", ".css", ".js", ".ts", ".tsx", ".py",
]);
const SYSTEM_TOP_LEVEL = new Set([
  "_login", "_analytics", "_publish", "_sessions", "_profile_build", "_debug",
  "_inbox", "_harness", "_pi", "analytics", "wechat",
]);
const PROTECTED_OUTPUTS = new Set([
  "_login", "_analytics", "_schedule.json", "_ideas.json", "_publish", "_publish.log",
  "_sessions", "_profile_build", "_debug", "_inbox", "_harness", "_pi",
]);
export const UPLOAD_EXTS = new Set([
  ...IMAGE_EXTS, ...VIDEO_EXTS,
  ".pdf", ".txt", ".md", ".markdown", ".csv", ".json", ".srt", ".vtt",
  ".docx", ".doc", ".xlsx", ".xls", ".pptx", ".ppt", ".mp3", ".wav", ".m4a",
]);

export function fileKind(filename: string): "image" | "video" | "audio" | "text" | "binary" {
  const ext = path.extname(filename).toLowerCase();
  if (IMAGE_EXTS.has(ext)) return "image";
  if (VIDEO_EXTS.has(ext)) return "video";
  if (AUDIO_EXTS.has(ext)) return "audio";
  if (TEXT_EXTS.has(ext)) return "text";
  return "binary";
}

export function safeOutputFile(rel: string): string {
  const root = path.resolve(OUTPUTS_DIR);
  const full = path.resolve(OUTPUTS_DIR, rel);
  if (full !== root && !full.startsWith(`${root}${path.sep}`)) throw new Error("非法路径");
  if (!fs.existsSync(full) || !fs.statSync(full).isFile()) throw new Error("文件不存在");
  return full;
}

export function safeOutputTarget(rel: string, mustExist = true): string {
  const root = path.resolve(OUTPUTS_DIR);
  const full = path.resolve(OUTPUTS_DIR, rel);
  if (full === root || !full.startsWith(`${root}${path.sep}`)) throw new Error("非法路径");
  if (mustExist && !fs.existsSync(full)) throw new Error("不存在");
  return full;
}

function fileMeta(full: string, rel: string): Record<string, unknown> {
  let mtime = 0;
  let size = 0;
  try {
    const stat = fs.statSync(full);
    mtime = Math.floor(stat.mtimeMs / 1000);
    size = stat.size;
  } catch {
    // ignore
  }
  return { name: path.basename(full), path: rel, kind: fileKind(full), mtime, size, type: "file" };
}

function buildNode(full: string, rel: string): Record<string, unknown> {
  if (fs.statSync(full).isDirectory()) {
    const children = fs
      .readdirSync(full)
      .filter((name) => !name.startsWith("."))
      .sort()
      .map((name) => buildNode(path.join(full, name), `${rel}/${name}`));
    const mtime = children.reduce(
      (max, child) => Math.max(max, Number(child.mtime ?? 0)),
      Math.floor(fs.statSync(full).mtimeMs / 1000),
    );
    const fileCount = children.reduce((sum, child) => sum + (child.type === "dir" ? Number(child.fileCount ?? 0) : 1), 0);
    return { name: path.basename(full), type: "dir", path: rel, mtime, children, fileCount };
  }
  return fileMeta(full, rel);
}

function readProjectMeta(project: string): Record<string, unknown> {
  const manifest = path.join(project, ".easel.json");
  if (!fs.existsSync(manifest)) return {};
  const data = readJson<Record<string, unknown>>(manifest);
  if (!data) return {};
  const meta: Record<string, unknown> = {};
  for (const key of ["title", "summary", "platform", "kind", "status", "tags", "deliverables"]) {
    const value = data[key];
    if (value !== null && value !== undefined && value !== "" && !(Array.isArray(value) && value.length === 0)) {
      meta[key] = value;
    }
  }
  if (!Object.keys(meta).length) return {};
  const name = path.basename(project);
  const declared = typeof data.cover === "string" ? data.cover : "";
  let cover = "";
  if (declared && fs.existsSync(path.join(project, declared))) cover = `${name}/${declared}`;
  const deliverables = Array.isArray(data.deliverables) ? data.deliverables.map(String) : [];
  if (!cover) {
    for (const item of deliverables) {
      const kind = fileKind(item);
      if ((kind === "image" || kind === "video") && fs.existsSync(path.join(project, item))) {
        cover = `${name}/${item}`;
        break;
      }
    }
  }
  if (cover) meta.cover = cover;
  meta.deliverablePaths = deliverables
    .filter((item) => fs.existsSync(path.join(project, item)))
    .map((item) => `${name}/${item}`);
  return meta;
}

export function outputTree(): Array<Record<string, unknown>> {
  if (!fs.existsSync(OUTPUTS_DIR)) return [];
  const items = fs
    .readdirSync(OUTPUTS_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith(".") && !entry.name.startsWith("_") && !SYSTEM_TOP_LEVEL.has(entry.name))
    .map((entry) => {
      const full = path.join(OUTPUTS_DIR, entry.name);
      const node = buildNode(full, entry.name);
      const meta = readProjectMeta(full);
      if (Object.keys(meta).length) node.meta = meta;
      return node;
    });
  return items.sort((a, b) => Number(b.mtime ?? 0) - Number(a.mtime ?? 0));
}

function isProtected(full: string): boolean {
  const root = path.resolve(OUTPUTS_DIR);
  const rel = path.relative(root, full);
  if (!rel || rel.startsWith("..")) return true;
  const first = rel.split(path.sep)[0];
  return first.startsWith("_") || first.startsWith(".") || PROTECTED_OUTPUTS.has(first) || ["analytics", "wechat"].includes(first.toLowerCase());
}

export function deleteOutput(rel: string): { deleted: string; kind: "dir" | "file" } {
  const full = safeOutputTarget(rel);
  if (isProtected(full)) throw new Error("系统数据受保护，不可从内容库删除");
  const isDir = fs.statSync(full).isDirectory();
  fs.rmSync(full, { recursive: isDir, force: false });
  return { deleted: rel, kind: isDir ? "dir" : "file" };
}

export function outputContent(rel: string): { path: string; content: string; kind: string; isBinary: boolean } {
  const full = safeOutputFile(rel);
  const kind = fileKind(full);
  if (kind !== "text") return { path: rel, content: "", kind, isBinary: true };
  try {
    return { path: rel, content: fs.readFileSync(full, "utf8"), kind: "text", isBinary: false };
  } catch {
    return { path: rel, content: "", kind: "binary", isBinary: true };
  }
}

export interface SkillSummary {
  name: string;
  description: string;
  layer: string;
  needsApi: boolean;
  apiConfigured: boolean;
}

function parseSkillMd(file: string): { description: string; layer: string; body: string } {
  const text = fs.readFileSync(file, "utf8");
  const lines = text.split(/\r?\n/);
  if (lines[0]?.trim() !== "---") return { description: "", layer: "", body: text };
  const end = lines.findIndex((line, index) => index > 0 && line.trim() === "---");
  if (end < 0) return { description: "", layer: "", body: text };
  const front = lines.slice(1, end);
  let description = "";
  let layer = "";
  for (let i = 0; i < front.length; i += 1) {
    const stripped = front[i].trim();
    if (stripped.startsWith("layer:")) {
      layer = stripped.slice("layer:".length).trim().replace(/^['"]|['"]$/g, "");
    } else if (stripped.startsWith("description:")) {
      const value = stripped.slice("description:".length).trim();
      if (value && (value[0] === "|" || value[0] === ">")) {
        const block: string[] = [];
        let j = i + 1;
        for (; j < front.length; j += 1) {
          if (!front[j].trim()) {
            block.push("");
            continue;
          }
          const indent = front[j].length - front[j].trimStart().length;
          if (indent === 0) break;
          block.push(front[j].trim());
        }
        description = block.filter(Boolean).join(" ");
        i = j - 1;
      } else {
        description = value.replace(/^['"]|['"]$/g, "");
      }
    }
  }
  return { description, layer, body: lines.slice(end + 1).join("\n").trim() };
}

export function findSkill(name: string): string | undefined {
  const candidates = name.startsWith("skill-") ? [name] : [name, `skill-${name}`];
  for (const candidate of candidates) {
    if (fs.existsSync(path.join(SKILLS_DIR, "builtin", candidate, "SKILL.md"))) return candidate;
  }
  return undefined;
}

export function skillList(): SkillSummary[] {
  const root = path.join(SKILLS_DIR, "builtin");
  if (!fs.existsSync(root)) return [];
  const env = readEnv();
  return fs
    .readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && fs.existsSync(path.join(root, entry.name, "SKILL.md")))
    .map((entry) => {
      const parsed = parseSkillMd(path.join(root, entry.name, "SKILL.md"));
      return {
        name: entry.name,
        description: parsed.description,
        layer: parsed.layer,
        needsApi: false,
        apiConfigured: true,
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

export function skillDetail(name: string): Record<string, unknown> | undefined {
  const full = findSkill(name);
  if (!full) return undefined;
  const parsed = parseSkillMd(path.join(SKILLS_DIR, "builtin", full, "SKILL.md"));
  return {
    name: full,
    layer: parsed.layer,
    description: parsed.description,
    body: parsed.body,
    needsApi: false,
    apiConfigured: true,
    apiSpec: null,
  };
}

export interface PersonaFile {
  filename: string;
  content: string;
}

export function personaFiles(name: string): { name: string; files: PersonaFile[] } | undefined {
  if (!personaExists(name)) return undefined;
  const directory = path.join(PROFILES_DIR, name);
  const extras = fs
    .readdirSync(directory)
    .filter((filename) => filename.endsWith(".md") && !FILE_ORDER.includes(filename))
    .sort();
  const files = [...FILE_ORDER, ...extras].map((filename) => ({
    filename,
    content: fs.existsSync(path.join(directory, filename)) ? fs.readFileSync(path.join(directory, filename), "utf8") : "",
  }));
  return { name, files };
}

export function savePersonaFile(name: string, filename: string, content: string): void {
  if (!personaExists(name)) throw new Error("画像不存在");
  if (!filename.endsWith(".md") || filename.startsWith(".") || /[/\\]/.test(filename)) throw new Error("文件名非法");
  const directory = path.resolve(PROFILES_DIR, name);
  const file = path.resolve(directory, filename);
  if (path.dirname(file) !== directory) throw new Error("非法路径");
  const temporary = `${file}.tmp`;
  fs.writeFileSync(temporary, content, "utf8");
  fs.renameSync(temporary, file);
}

export function deletePersona(name: string): void {
  if (!personaExists(name)) throw new Error("画像不存在");
  const directory = path.resolve(PROFILES_DIR, name);
  const root = path.resolve(PROFILES_DIR);
  if (!directory.startsWith(`${root}${path.sep}`)) throw new Error("非法路径");
  fs.rmSync(directory, { recursive: true, force: false });
}

const VALUE_OK = /^[^\x00-\x1F\x7F]*$/;
const ENV_ALLOWED =
  /^(EASEL_|TAVILY_|IMG_|VIDEO_|MUSIC_|VOICE_|GEMINI_|MINERU_|OPENAI_|ANTHROPIC_|OPENROUTER_|DASHSCOPE_|ARK_|VOLC_|SILICONFLOW_|XHS_|DOUYIN_|BILI_|WECHAT_|WX_|KLING_|AGNES_|FISH_|MINIMAX_|MIMO_|HTTP_PROXY|HTTPS_PROXY|NO_PROXY|http_proxy|https_proxy|no_proxy)/;

export function saveEnvUpdates(updates: Record<string, string>): void {
  const envFile = path.join(PROFILES_DIR, "..", ".env");
  for (const [key, rawValue] of Object.entries(updates)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || !ENV_ALLOWED.test(key)) throw new Error(`不允许写入的变量：${key}`);
    if (/[\r\n\0]/.test(rawValue ?? "")) throw new Error(`配置值不能包含换行符：${key}`);
    if (!VALUE_OK.test(rawValue ?? "")) throw new Error(`配置值含不允许的字符：${key}`);
  }
  const lines = fs.existsSync(envFile) ? fs.readFileSync(envFile, "utf8").split(/\r?\n/) : [];
  const seen = new Set<string>();
  const output: string[] = [];
  for (const line of lines) {
    const match = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line);
    if (match && Object.prototype.hasOwnProperty.call(updates, match[1])) {
      seen.add(match[1]);
      const value = updates[match[1]];
      if (value.trim()) output.push(`${match[1]}=${value}`);
      continue;
    }
    output.push(line);
  }
  const appended = Object.entries(updates)
    .filter(([key, value]) => !seen.has(key) && value.trim())
    .map(([key, value]) => `${key}=${value}`);
  if (appended.length) {
    if (output.length && output[output.length - 1].trim()) output.push("");
    output.push("# ---- Easel API keys (added via Web) ----", ...appended);
  }
  const temporary = `${envFile}.tmp`;
  fs.writeFileSync(temporary, `${output.join("\n")}\n`, "utf8");
  fs.renameSync(temporary, envFile);
}

export function envStatus(): Record<string, unknown> {
  const env = readEnv();
  return {
    ok: true,
    skills: {},
    models: {
      directApiConfigured: Boolean(env.EASEL_DIRECT_API_KEY && env.EASEL_DIRECT_API_MODEL && env.EASEL_DIRECT_API_BASE_URL),
    },
  };
}

export { listPersonas, loadProfileText };
