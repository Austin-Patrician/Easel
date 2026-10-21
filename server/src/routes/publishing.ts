import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { Router } from "express";
import { ZipArchive } from "archiver";
import { OUTPUTS_DIR, PROJECT_ROOT, readEnv } from "../config.js";
import {
  LOGIN_RUNNERS,
  MEDIA_REQUIRED,
  PUBLISH_DIR,
  SCHEDULE_FILE,
  SHARED_SCRIPTS,
  VIDEO_ONLY_PUBLISH,
  WECHAT_SKILL_SCRIPTS,
  mpLoginStatus,
  writePublishSms,
} from "../domain.js";
import { asyncRoute, fail, param } from "../http.js";
import { personaExists } from "../persona.js";
import { proxyEnv, pythonExecutable, runProcess, runPython, wechatEnv } from "../python.js";

const PLATFORMS: Record<string, { label: string; url: string }> = {
  xiaohongshu: { label: "小红书", url: "https://creator.xiaohongshu.com/publish/publish?source=official" },
  douyin: { label: "抖音", url: "https://creator.douyin.com/" },
  kuaishou: { label: "快手", url: "https://cp.kuaishou.com/article/publish/video" },
  "weixin-channels": { label: "视频号", url: "https://channels.weixin.qq.com/platform/post/create" },
  zhihu: { label: "知乎", url: "https://zhuanlan.zhihu.com/write" },
  bilibili: { label: "B站", url: "https://member.bilibili.com/" },
  "wechat-oa": { label: "公众号", url: "https://mp.weixin.qq.com/" },
};

const IMAGE_EXTS = new Set([".png", ".jpg", ".jpeg", ".webp", ".gif", ".bmp", ".avif"]);
const VIDEO_EXTS = new Set([".mp4", ".mov", ".webm", ".mkv", ".avi", ".m4v", ".flv", ".ts"]);
const MEDIA_EXTS = new Set([...IMAGE_EXTS, ...VIDEO_EXTS]);

function publishingMode(): "manual" | "automated" {
  const mode = String(readEnv().EASEL_PUBLISH_MODE ?? "").trim().toLowerCase();
  return mode === "" || mode === "automated" ? "automated" : "manual";
}

function requireAutomated(): void {
  if (publishingMode() !== "automated") {
    fail("当前为人工发布模式，请审核后复制或导出，在平台官方发布页亲自提交", 403);
  }
}

function safeOutput(relative: string): string {
  const root = path.resolve(OUTPUTS_DIR);
  const full = path.resolve(root, relative);
  if (full === root || !full.startsWith(`${root}${path.sep}`)) fail("媒体路径超出内容库");
  return full;
}

function escapeHtml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

function markdownToHtml(markdown: string): string {
  const lines = escapeHtml(markdown).split(/\r?\n/);
  const blocks: string[] = [];
  let paragraph: string[] = [];
  let list: string[] = [];
  const flushParagraph = () => {
    if (paragraph.length) {
      blocks.push(`<p style="margin:18px 0;line-height:1.9">${paragraph.join("<br>")}</p>`);
      paragraph = [];
    }
  };
  const flushList = () => {
    if (list.length) {
      blocks.push(`<ul style="margin:18px 0;line-height:1.9">${list.map((item) => `<li>${item}</li>`).join("")}</ul>`);
      list = [];
    }
  };
  for (const line of lines) {
    const heading = /^(#{1,4})\s+(.+)$/.exec(line);
    const bullet = /^\s*[-*]\s+(.+)$/.exec(line);
    if (heading) {
      flushParagraph();
      flushList();
      const level = Math.min(heading[1].length + 1, 5);
      blocks.push(`<h${level} style="margin:28px 0 14px;line-height:1.4">${heading[2]}</h${level}>`);
    } else if (bullet) {
      flushParagraph();
      list.push(bullet[1]);
    } else if (!line.trim()) {
      flushParagraph();
      flushList();
    } else {
      flushList();
      paragraph.push(line);
    }
  }
  flushParagraph();
  flushList();
  return blocks.join("\n");
}

function zipPackage(
  platform: string,
  title: string,
  body: string,
  tags: string,
  media: string[],
  reviewed: boolean,
): Promise<{ path: string; filename: string; published: false }> {
  if (!(platform in PLATFORMS)) return Promise.reject(new Error("未知平台"));
  if (reviewed !== true) return Promise.reject(new Error("请先人工审核当前版本"));
  if (!title.trim() && !body.trim()) return Promise.reject(new Error("标题或正文不能为空"));
  if (media.length > 32) return Promise.reject(new Error("一次最多导出 32 个媒体文件"));
  const root = path.resolve(OUTPUTS_DIR);
  const files: string[] = [];
  for (const relative of [...new Set(media)]) {
    const full = path.resolve(root, relative);
    if (!full.startsWith(`${root}${path.sep}`)) return Promise.reject(new Error("媒体路径超出内容库"));
    const parts = path.relative(root, full).split(path.sep);
    if (parts.some((part) => part.startsWith("_") || part.startsWith("."))) {
      return Promise.reject(new Error("不能导出系统目录或隐藏文件"));
    }
    if (!fs.existsSync(full) || !fs.statSync(full).isFile() || !MEDIA_EXTS.has(path.extname(full).toLowerCase())) {
      return Promise.reject(new Error("只能导出内容库中的图片或视频"));
    }
    files.push(full);
  }
  const total = files.reduce((sum, file) => sum + fs.statSync(file).size, 0);
  if (total > 2 * 1024 ** 3) return Promise.reject(new Error("素材超过 2GB，请分批导出"));
  const destination = path.join(root, "_publish", "manual");
  fs.mkdirSync(destination, { recursive: true });
  const filename = `easel-${platform}-${crypto.randomBytes(6).toString("hex")}.zip`;
  const packagePath = path.join(destination, filename);
  const { label, url } = PLATFORMS[platform];
  const metadata = {
    platform,
    title,
    tags,
    reviewed: true,
    exportedAt: new Date().toISOString(),
    status: "ready_for_manual_submission",
    officialUrl: url,
    media: files.map((file, index) => `media/${String(index + 1).padStart(2, "0")}_${path.basename(file)}`),
  };
  return new Promise((resolve, reject) => {
    const output = fs.createWriteStream(packagePath);
    const archive = new ZipArchive({ zlib: { level: 9 } });
    output.on("close", () => resolve({
      path: path.relative(root, packagePath).split(path.sep).join("/"),
      filename,
      published: false,
    }));
    output.on("error", reject);
    archive.on("error", reject);
    archive.pipe(output);
    archive.append(title, { name: "title.txt" });
    archive.append(body, { name: "body.txt" });
    archive.append(tags, { name: "tags.txt" });
    archive.append(`${JSON.stringify(metadata, null, 2)}\n`, { name: "manifest.json" });
    archive.append(
      `${label} · 人工发布包\n\n1. 解压此文件。\n2. 打开 ${url}\n`
      + "3. 在官方页面登录、粘贴标题正文、上传 media 中的素材，并核对话题。\n"
      + "4. 检查预览，按平台要求标注 AI 辅助创作，再亲自点击发布。\n"
      + "5. 到 Easel 填写作品链接，人工记录发布结果。\n\n"
      + "导出不等于上传或发布；此包不包含登录凭证。\n",
      { name: "使用说明.txt" },
    );
    files.forEach((file, index) => {
      archive.file(file, { name: `media/${String(index + 1).padStart(2, "0")}_${path.basename(file)}` });
    });
    if (platform === "wechat-oa") {
      const article = "<!doctype html><html lang=\"zh-CN\"><meta charset=\"utf-8\">"
        + "<title>公众号排版预览</title><body><article style=\"max-width:680px;"
        + "margin:32px auto;padding:24px;font:16px/1.9 sans-serif;color:#222\">"
        + `<h1 style="font-size:24px">${escapeHtml(title)}</h1>${markdownToHtml(body)}`
        + "</article></body></html>";
      archive.append(article, { name: "article.html" });
    }
    void archive.finalize().catch(reject);
  });
}

function publishStatusFile(platform: string): string {
  return path.join(PUBLISH_DIR, `${platform}.json`);
}

function readPublishStatus(platform: string): { state: string; message: string } {
  const file = publishStatusFile(platform);
  if (fs.existsSync(file)) {
    try {
      const value = JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
      return { state: String(value.state ?? "unknown"), message: String(value.message ?? "") };
    } catch {
      // Fall through.
    }
  }
  return { state: "unknown", message: "" };
}

function writePublishStatus(platform: string, state: string, message = ""): void {
  try {
    fs.mkdirSync(PUBLISH_DIR, { recursive: true });
    const file = publishStatusFile(platform);
    const temporary = `${file}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify({ state, message, ts: Math.floor(Date.now() / 1000) }), "utf8");
    fs.renameSync(temporary, file);
  } catch {
    // Status is best-effort.
  }
}

async function recordSuccessfulPublish(
  platform: string,
  title: string,
  body: string,
  tags: string,
  profile: string,
  ptype: string,
): Promise<void> {
  const config = LOGIN_RUNNERS[platform];
  if (!config) return;
  const args = [path.join(SHARED_SCRIPTS, "calendar_ops.py"), "--data", SCHEDULE_FILE,
    "record-publish", "--platform", platform, "--title", title, "--note", body.slice(0, 200),
    "--source", "publish-page"];
  if (tags) args.push("--tags", tags);
  if (profile) args.push("--profile", profile);
  if (ptype) args.push("--type", ptype);
  await runPython(args, { timeoutMs: 20_000, env: proxyEnv() }).catch(() => undefined);
}

async function logPublish(
  platform: string,
  command: string[],
  result: { stdout: string; stderr: string; code: number },
  async = false,
): Promise<void> {
  try {
    const stamp = new Date().toISOString().replace("T", " ").slice(0, 19);
    const body = `\n===== ${stamp} ${platform}${async ? "(async)" : ""} rc=${result.code} =====\n`
      + `CMD: ${command.join(" ")}\nSTDOUT:\n${result.stdout.slice(-2000)}\nSTDERR:\n${result.stderr.slice(-2000)}\n`;
    fs.appendFileSync(path.join(OUTPUTS_DIR, "_publish.log"), body, "utf8");
  } catch {
    // Logging is best-effort.
  }
}

async function runAsyncPublish(
  platform: string,
  command: string[],
  title: string,
  body: string,
  tags: string,
  profile: string,
  ptype: string,
): Promise<void> {
  const result = await runProcess(command[0], command.slice(1), {
    cwd: PROJECT_ROOT,
    env: proxyEnv(),
    timeoutMs: 900_000,
  });
  const ok = result.code === 0 && !result.timedOut;
  const current = readPublishStatus(platform);
  if (!["success", "error"].includes(current.state)) {
    const detail = result.timedOut
      ? "发布超时（>900s）"
      : (result.stderr || result.stdout).trim().split(/\r?\n/).filter(Boolean).slice(-4).join("\n") || "发布失败";
    writePublishStatus(platform, ok ? "success" : "error", ok ? "发布成功" : detail);
  }
  try {
    fs.unlinkSync(path.join(PUBLISH_DIR, `${platform}.code`));
  } catch {
    // Absent.
  }
  await logPublish(platform, command, result, true);
  if (ok) await recordSuccessfulPublish(platform, title, body, tags, profile, ptype);
}

export function publishingRouter(): Router {
  const router = Router();

  router.get("/publishing-policy", (_req, res) => {
    const mode = publishingMode();
    res.json({ mode, automaticSubmission: mode === "automated" });
  });

  router.post("/manual-publish/:platform/export", asyncRoute(async (req, res) => {
    const platform = param(req, "platform");
    const body = (req.body ?? {}) as Record<string, unknown>;
    const media = Array.isArray(body.media) ? body.media.map(String) : [];
    try {
      res.json(await zipPackage(platform, String(body.title ?? ""), String(body.body ?? ""),
        String(body.tags ?? ""), media, body.reviewed === true));
    } catch (error) {
      fail(error instanceof Error ? error.message : "导出失败");
    }
  }));

  router.get("/publish/:platform/status", asyncRoute(async (req, res) => {
    const platform = param(req, "platform");
    if (!LOGIN_RUNNERS[platform]) fail("未知平台", 404);
    res.json({ mode: "publish", ...readPublishStatus(platform) });
  }));

  router.post("/publish/:platform/sms", asyncRoute(async (req, res) => {
    requireAutomated();
    const platform = param(req, "platform");
    if (!LOGIN_RUNNERS[platform]) fail("未知平台", 404);
    const code = String((req.body ?? {}).code ?? "").replace(/\D/g, "");
    if (code.length < 4 || code.length > 8) fail("验证码应为 4-8 位数字");
    writePublishSms(platform, code);
    res.json({ ok: true });
  }));

  router.post("/publish/:platform", asyncRoute(async (req, res) => {
    requireAutomated();
    const platform = param(req, "platform");
    const config = LOGIN_RUNNERS[platform];
    if (!config) fail("未知平台", 404);
    if (config.backend === "unsupported") fail(`${config.name} 暂不支持一键发布`);
    const body = (req.body ?? {}) as Record<string, unknown>;
    const profile = String(body.persona ?? "").trim();
    if (profile && !personaExists(profile)) fail("选择的画像不存在或名称非法");
    const sourceTitle = String(body.title ?? "");
    const sourceBody = String(body.body ?? "");
    if (!sourceTitle.trim() && !sourceBody.trim()) fail("标题/正文不能为空");
    const images: string[] = [];
    const videos: string[] = [];
    for (const relative of Array.isArray(body.media) ? body.media.map(String) : []) {
      const full = safeOutput(relative);
      const ext = path.extname(full).toLowerCase();
      if (VIDEO_EXTS.has(ext)) videos.push(full);
      else if (IMAGE_EXTS.has(ext)) images.push(full);
    }
    if (MEDIA_REQUIRED.has(platform) && !images.length && !videos.length) {
      fail(`${config.name} 需附带图片或视频`);
    }
    if (images.length && videos.length) fail("同一条内容不能同时发图片和视频，请二选一");
    if (VIDEO_ONLY_PUBLISH.has(platform) && !videos.length) {
      fail(`${config.name} 只能发视频，请附带一个视频文件`);
    }
    const title = sourceTitle.trim() || sourceBody.trim().slice(0, 20);
    const tags = String(body.tags ?? "");
    const publishType = videos.length ? "视频" : platform === "wechat-oa" ? "文章" : "图文";
    const py = pythonExecutable();
    let command: string[];

    if (platform === "xiaohongshu") {
      const base = [py, path.join(SHARED_SCRIPTS, "xhs_publish.py")];
      command = videos.length
        ? [...base, "publish-video", "--no-proxy", "--video", videos[0]]
        : [...base, "publish", "--no-proxy", "--images", images.join(",")];
      command.push("--title", title, "--content", sourceBody, "--tags", tags, "--exec");
    } else if (platform === "bilibili") {
      const biliTag = tags.replace(/#/g, "").replace(/，/g, ",").replace(/^,|,$/g, "").trim() || "日常";
      command = ["biliup", "-u", path.join(PROJECT_ROOT, "cookies.json"), "upload", videos[0],
        "--title", title.slice(0, 80), "--tid", "36", "--copyright", "1", "--tag", biliTag];
      if (sourceBody.trim()) command.push("--desc", sourceBody.slice(0, 2000));
    } else if (platform === "douyin") {
      const base = [py, path.join(SHARED_SCRIPTS, "douyin_publish.py")];
      command = videos.length
        ? [...base, "publish-video", "--no-proxy", "--video", videos[0]]
        : [...base, "publish", "--no-proxy", "--images", images.join(",")];
      command.push("--title", title, "--content", sourceBody, "--tags", tags, "--exec",
        "--status-file", publishStatusFile(platform), "--sms-code-file", path.join(PUBLISH_DIR, `${platform}.code`));
      fs.mkdirSync(PUBLISH_DIR, { recursive: true });
      try {
        fs.unlinkSync(path.join(PUBLISH_DIR, `${platform}.code`));
      } catch {
        // Absent.
      }
      writePublishStatus(platform, "starting", "发布中…（若触发风控会要求短信验证）");
      void runAsyncPublish(platform, command, title, sourceBody, tags, profile, publishType);
      res.json({ async: true, pending: true, message: "发布已启动，请稍候…" });
      return;
    } else if (platform === "wechat-oa") {
      if (mpLoginStatus().state !== "success") {
        fail("公众号后台未登录：请先在账号页点「登录公众号后台」扫码");
      }
      if (!images.length) fail("公众号文章需要一张封面图，请附带至少一张图片");
      if (videos.length) fail("公众号发图文文章，请附带封面/正文图片而非视频");
      fs.mkdirSync(PUBLISH_DIR, { recursive: true });
      const stamp = crypto.randomBytes(6).toString("hex");
      const mdPath = path.join(PUBLISH_DIR, `wechat-oa-${stamp}.md`);
      const htmlPath = path.join(PUBLISH_DIR, `wechat-oa-${stamp}.html`);
      let bodyMd = sourceBody;
      if (images.length > 1) bodyMd += `\n\n${images.slice(1).map((file) => `![](${file})`).join("\n\n")}`;
      fs.writeFileSync(mdPath, `# ${title}\n\n${bodyMd}\n`, "utf8");
      const conversion = await runProcess(py,
        [path.join(WECHAT_SKILL_SCRIPTS, "html_converter.py"), mdPath, "-o", htmlPath],
        { cwd: PROJECT_ROOT, env: proxyEnv(), timeoutMs: 60_000 });
      if (conversion.code !== 0 || !fs.existsSync(htmlPath)) {
        fail(`排版失败：${(conversion.stderr || conversion.stdout || "").slice(-200)}`, 500);
      }
      const wxProxy = process.env.EASEL_PROXY ?? process.env.https_proxy ?? "";
      command = [py, path.join(SHARED_SCRIPTS, "weixin_mp_stats.py"), "publish", "--proxy", wxProxy,
        "--html", htmlPath, "--cover", images[0], "--title", title,
        "--digest", sourceBody.trim().slice(0, 100), "--author", ""];
    } else {
      command = [py, path.join(SHARED_SCRIPTS, "web_publisher.py"), "publish",
        "--platform", String(config.wp ?? platform), "--title", title, "--desc", sourceBody,
        "--tags", tags, "--exec"];
      const media = videos[0] ?? images[0];
      if (media) command.push("--media", media);
    }

    const env = platform === "wechat-oa" ? proxyEnv() : { ...wechatEnv(), EASEL_CALENDAR_AUTORECORD: "0" };
    const result = await runProcess(command[0], command.slice(1), {
      cwd: PROJECT_ROOT,
      env,
      timeoutMs: 600_000,
    });
    if (result.timedOut) fail("发布超时（媒体处理慢或流程卡住）", 504);
    const ok = result.code === 0;
    await logPublish(platform, command, result);
    if (ok) await recordSuccessfulPublish(platform, title, sourceBody, tags, profile, publishType);
    const detail = (result.stderr || result.stdout).trim().split(/\r?\n/).slice(-8).join("\n");
    res.json({ ok, message: ok ? "发布成功" : "发布失败（见 detail）", detail });
  }));

  return router;
}
