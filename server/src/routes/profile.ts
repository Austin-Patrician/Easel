import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { Router } from "express";
import { PROFILES_DIR, validPersonaName } from "../config.js";
import { PROFILE_BUILD_DIR } from "../domain.js";
import { asyncRoute, fail, param } from "../http.js";
import { runChatTurn } from "../pi/chat.js";

type Form = Record<string, unknown>;

function text(form: Form, key: string, fallback = ""): string {
  const value = form[key];
  if (Array.isArray(value)) return value.map(String).join("、");
  return value === undefined || value === null ? fallback : String(value).trim() || fallback;
}

function linksOf(form: Form): Record<string, string> {
  const raw = form.links;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  return Object.fromEntries(
    Object.entries(raw as Record<string, unknown>)
      .map(([platform, url]) => [platform, String(url ?? "").trim()])
      .filter(([, url]) => url),
  );
}

function formInstruction(name: string, form: Form): string {
  const g = (key: string, fallback = "（未填）"): string => text(form, key, fallback) || fallback;
  const links = linksOf(form);
  const linkText = Object.entries(links).map(([platform, url]) => `  - ${platform}: ${url}`).join("\n") || "  （未提供）";
  return `画像名：${name}\n运营平台：${g("platforms")}\n起号状态：${g("accountStage")}`
    + `\n社媒主页链接：\n${linkText}\n想做的方向：${g("direction")}`
    + `\n为什么做/我的优势：${g("reason")}\n运营目标：${g("goal")}`
    + `\n想产出的形式：${g("formats")}\n喜欢看的内容/对标账号：${g("likes")}`
    + `\n期望调性：${g("tone")}\n不做的内容/红线：${g("avoid")}\n`;
}

function writeBaselineProfile(name: string, form: Form): void {
  const directory = path.join(PROFILES_DIR, name);
  fs.mkdirSync(directory, { recursive: true });
  const g = (key: string, fallback = ""): string => text(form, key, fallback);
  const direction = g("direction") || "[待补充]";
  const reason = g("reason") || "[待补充]";
  const goal = g("goal");
  const formats = g("formats");
  const tone = g("tone") || "[待分析]";
  const likes = g("likes");
  const avoid = g("avoid");
  const platforms = Array.isArray(form.platforms)
    ? form.platforms.map(String)
    : text(form, "platforms") ? text(form, "platforms").split(/[、,，]/).map((item) => item.trim()).filter(Boolean) : [];
  const links = linksOf(form);

  const identity = `# 身份定位\n\n## 我是谁\n\n${direction}\n\n## 差异化\n\n${reason}\n\n## 内容方向\n\n${direction}`
    + `${formats ? `（形式：${formats}）` : ""}\n${goal ? `运营目标：${goal}` : ""}\n`;
  const style = `# 内容风格\n\n## 语气\n\n${tone}\n\n## 开头结构\n\n[待 AI 分析已发内容]\n\n## 视觉风格\n\n[待 AI 分析]\n\n## 内容节奏\n\n${formats || "[待补充]"}\n\n## 标志性元素\n\n[待 AI 分析]\n`;
  const audience = "# 目标受众\n\n## 核心人群\n\n[待 AI 分析/待补充]\n\n## 兴趣标签\n\n[待补充]\n\n## 痛点\n\n[待补充]\n\n## 互动特征\n\n[待 AI 分析已发内容]\n";
  const platformLines = platforms.map((platform) => {
    const url = links[platform] ?? "";
    return `## ${platform}\n\n主页：${url || "[待补充]"}\n粉丝量级 / 内容形式：[待补充]\n`;
  });
  const platformsText = `# 平台运营\n\n${platformLines.length ? platformLines.join("\n") : "[待补充]\n"}`;
  const preferences = `# 偏好与红线\n\n## 要做的\n\n${direction}\n\n## 不做的\n\n${avoid || "[待补充]"}\n\n## 合规底线\n\n${avoid || "[待补充]"}\n`;
  const memory = `# 经验沉淀\n\n## 内容洞察\n\n${likes ? `喜欢的内容/对标：${likes}` : "[待 AI 分析已收藏/点赞]"}\n\n## 踩过的坑\n\n[待积累]\n`;

  for (const [filename, content] of Object.entries({
    "identity.md": identity,
    "style.md": style,
    "audience.md": audience,
    "platforms.md": platformsText,
    "preferences.md": preferences,
    "memory.md": memory,
  })) {
    fs.writeFileSync(path.join(directory, filename), content, "utf8");
  }
}

function statusFile(name: string): string {
  return path.join(PROFILE_BUILD_DIR, `${name}.json`);
}

function writeProfileStatus(name: string, state: string, log = ""): void {
  try {
    fs.mkdirSync(PROFILE_BUILD_DIR, { recursive: true });
    const file = statusFile(name);
    const temporary = `${file}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify({ state, log, ts: Math.floor(Date.now() / 1000) }), "utf8");
    fs.renameSync(temporary, file);
  } catch {
    // Status is best-effort.
  }
}

export function profileRouter(): Router {
  const router = Router();

  router.post("/profile/build", asyncRoute(async (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const name = String(body.name ?? "").trim();
    if (!name) fail("画像名不能为空（去掉首尾空格后为空，请输入有效名称）");
    if (/[/\\]/.test(name)) fail("画像名不能包含 / 或 \\ 字符，请改掉后重试");
    if (name.startsWith(".") || name.startsWith("_")) fail("画像名不能以 . 或 _ 开头，请换个开头");
    if (!validPersonaName(name)) fail("画像名不合法");
    const directory = path.join(PROFILES_DIR, name);
    if (fs.existsSync(directory)) fail(`画像「${name}」已存在，请换一个名字`, 409);
    const form = body.form && typeof body.form === "object" && !Array.isArray(body.form)
      ? (body.form as Form)
      : {};
    writeBaselineProfile(name, form);
    writeProfileStatus(name, "running", "AI 正在分析并增强画像…");

    const message = `请执行 /skill-profile-builder 完善已存在的画像「${name}」。用户已通过表单提供以下信息，我已按此写好 profiles/${name}`
      + "/ 的基线六维文件。请：①尽力抓取用户给的社媒链接分析已发内容/风格/受众（抓不到就降级，标注[待补充]，勿臆造）②据分析结果润色/补全各维度文件 ③给出一句话完成度摘要。表单信息如下：\n\n"
      + formInstruction(name, form);

    void (async () => {
      const output: string[] = [];
      const errors: string[] = [];
      try {
        const result = await runChatTurn({
          sessionKey: `web-profile-${name}-${crypto.randomUUID()}`,
          prompt: message,
          turnId: crypto.randomUUID().replace(/-/g, ""),
          emit: (kind, value) => {
            if (kind === "token" && value) output.push(value);
            if (kind === "error" && value) errors.push(value);
          },
        });
        const completed = (result || output.join("")).trim();
        if (!completed && errors.length) {
          writeProfileStatus(name, "failed", `AI 增强失败（基线画像已可用）：${errors.join("\n")}`);
        } else {
          writeProfileStatus(name, "done", completed || "AI 增强完成");
        }
      } catch (error) {
        const detail = errors.join("\n") || (error instanceof Error ? error.message : String(error));
        writeProfileStatus(name, "failed", `AI 增强失败（基线画像已可用）：${detail}`);
      }
    })();

    res.json({ created: fs.existsSync(directory), name, async: true, status: "running" });
  }));

  router.get("/profile/build/status/:name", asyncRoute(async (req, res) => {
    const name = param(req, "name");
    if (!validPersonaName(name)) fail("画像名不合法");
    const file = statusFile(name);
    if (fs.existsSync(file)) {
      try {
        const value = JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
        res.json({ state: String(value.state ?? "unknown"), log: String(value.log ?? "") });
        return;
      } catch {
        // Fall through.
      }
    }
    res.json({ state: "unknown", log: "" });
  }));

  return router;
}
