import fs from "node:fs";
import path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { OUTPUTS_DIR, PROJECT_ROOT, readEnv, readJson, writeJson } from "./config.js";
import { pythonExecutable, runPython, wechatEnv, type ProcessResult } from "./python.js";

export const SHARED_SCRIPTS = path.join(PROJECT_ROOT, "skills", "shared", "scripts");
export const BROWSER_PROFILES = path.join(process.env.HOME ?? process.env.USERPROFILE ?? "", ".easel-browser-profiles");
export const LOGIN_DIR = path.join(OUTPUTS_DIR, "_login");
export const PUBLISH_DIR = path.join(OUTPUTS_DIR, "_publish");
export const PROFILE_BUILD_DIR = path.join(OUTPUTS_DIR, "_profile_build");
export const SCHEDULE_FILE = path.join(OUTPUTS_DIR, "_schedule.json");
export const IDEAS_FILE = path.join(OUTPUTS_DIR, "_ideas.json");
export const LOGIN_TIMEOUT = 240;

export const WECHAT_SKILL_DIR = path.join(PROJECT_ROOT, "skills", "builtin", "skill-wechat-publisher");
export const WECHAT_SKILL_SCRIPTS = path.join(WECHAT_SKILL_DIR, "scripts");
export const WECHAT_CONFIG_YAML = path.join(WECHAT_SKILL_DIR, "wechat-publisher.yaml");
const WECHAT_WEB_ACCOUNT = "web";

export interface AccountConfig {
  name: string;
  backend: "xhs" | "web" | "biliup" | "douyin" | "wechat-oa" | "unsupported";
  wp?: string;
  profile?: string;
  note?: string;
}

export const LOGIN_RUNNERS: Record<string, AccountConfig> = {
  xiaohongshu: { name: "小红书", backend: "xhs", profile: "XiaohongshuProfile" },
  kuaishou: { name: "快手", backend: "web", wp: "kuaishou", profile: "KuaishouProfile" },
  "weixin-channels": { name: "微信视频号", backend: "web", wp: "weixin-channels", profile: "ChannelsProfile" },
  zhihu: { name: "知乎", backend: "web", wp: "zhihu", profile: "ZhihuProfile" },
  bilibili: { name: "B站", backend: "biliup" },
  douyin: { name: "抖音", backend: "douyin", profile: "DouyinProfile" },
  "wechat-oa": { name: "微信公众号", backend: "wechat-oa" },
};

export const ANALYTICS_PLATFORMS = new Set([
  "xiaohongshu", "douyin", "kuaishou", "zhihu", "weixin-channels", "bilibili", "wechat-oa",
]);

export const MEDIA_REQUIRED = new Set(["xiaohongshu", "douyin", "kuaishou", "weixin-channels", "bilibili"]);
export const VIDEO_ONLY_PUBLISH = new Set(["douyin", "weixin-channels", "bilibili"]);

const loginProcesses = new Map<string, ChildProcess>();

const PLACEHOLDER = /replace_me|your[-_]?api[-_]?key|xxx|^\.{3}$|^<.*>$/i;

export function isSet(value: unknown): boolean {
  const text = String(value ?? "").trim();
  return Boolean(text) && !PLACEHOLDER.test(text);
}

export function mask(value: string): string {
  const text = value.trim();
  if (!text) return "";
  return text.length <= 4 ? "••••" : `••••${text.slice(-4)}`;
}

export function writeJsonAtomic(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  fs.renameSync(temporary, file);
}

export function writeTextAtomic(file: string, value: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.tmp`;
  fs.writeFileSync(temporary, value, "utf8");
  fs.renameSync(temporary, file);
}

export function readArrayFile(file: string): Array<Record<string, unknown>> {
  const value = readJson<unknown>(file);
  return Array.isArray(value) ? (value as Array<Record<string, unknown>>) : [];
}

export function activeLoginProcess(platform: string): ChildProcess | undefined {
  const child = loginProcesses.get(platform);
  if (!child) return undefined;
  if (child.exitCode !== null || child.signalCode !== null) {
    loginProcesses.delete(platform);
    return undefined;
  }
  return child;
}

function exitedLoginCode(platform: string): number | null {
  const child = loginProcesses.get(platform);
  if (!child) return null;
  if (child.exitCode === null && child.signalCode === null) return null;
  loginProcesses.delete(platform);
  return child.exitCode ?? -1;
}

export function stopLoginProcess(platform: string): void {
  const child = loginProcesses.get(platform);
  loginProcesses.delete(platform);
  if (child && child.exitCode === null && child.signalCode === null) {
    try {
      child.kill("SIGTERM");
    } catch {
      // Already gone.
    }
  }
}

function startBackground(
  platform: string,
  command: string,
  args: string[],
  logPath: string,
  env: NodeJS.ProcessEnv,
): ChildProcess {
  fs.mkdirSync(path.dirname(logPath), { recursive: true });
  const log = fs.openSync(logPath, "a");
  try {
    const child = spawn(command, args, {
      cwd: PROJECT_ROOT,
      env,
      detached: process.platform !== "win32",
      stdio: ["ignore", log, log],
    });
    child.unref();
    loginProcesses.set(platform, child);
    return child;
  } finally {
    fs.closeSync(log);
  }
}

export function writeLoginMarker(platform: string, state: string, message = ""): void {
  try {
    writeJsonAtomic(path.join(LOGIN_DIR, `${platform}.json`), {
      state,
      message,
      qr: "",
      ts: Math.floor(Date.now() / 1000),
    });
  } catch {
    // Best-effort marker.
  }
}

export interface LoginStatus {
  state: string;
  message: string;
  qr: string;
  qrTs: number;
}

export function loginStatus(platform: string, key = platform): LoginStatus {
  const statusFile = path.join(LOGIN_DIR, `${key}.json`);
  let data: LoginStatus = { state: "unknown", message: "", qr: "", qrTs: 0 };
  if (fs.existsSync(statusFile)) {
    const value = readJson<Record<string, unknown>>(statusFile);
    if (value) {
      data.state = String(value.state ?? "unknown");
      data.message = String(value.message ?? "");
    }
  }
  const exitCode = exitedLoginCode(platform);
  if (!["success", "expired", "error"].includes(data.state) && exitCode !== null) {
    data = {
      state: "error",
      message: `登录程序异常退出（退出码 ${exitCode}），请查看 outputs/_login/${key}.log`,
      qr: "",
      qrTs: 0,
    };
  }
  const qrFile = path.join(LOGIN_DIR, `${key}.png`);
  if (["qr_ready", "window_login"].includes(data.state) && fs.existsSync(qrFile)) {
    data.qr = `_login/${key}.png`;
    try {
      data.qrTs = Math.floor(fs.statSync(qrFile).mtimeMs);
    } catch {
      data.qrTs = 0;
    }
  } else {
    data.qr = "";
    data.qrTs = 0;
  }
  return data;
}

export function mpLoginStatus(): LoginStatus {
  return loginStatus("wechat-oa-mp", "wechat-oa-mp");
}

export function wechatLoadYaml(): Record<string, unknown> {
  if (!fs.existsSync(WECHAT_CONFIG_YAML)) return {};
  try {
    const value = parseYaml(fs.readFileSync(WECHAT_CONFIG_YAML, "utf8")) as unknown;
    return value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

export function wechatWebAccount(): Record<string, unknown> {
  const config = wechatLoadYaml();
  const accounts = config.accounts;
  if (!accounts || typeof accounts !== "object") return {};
  const account = (accounts as Record<string, unknown>)[WECHAT_WEB_ACCOUNT];
  return account && typeof account === "object" ? (account as Record<string, unknown>) : {};
}

export function wechatHasCredentials(): boolean {
  const account = wechatWebAccount();
  return Boolean(String(account.app_id ?? "").trim() && String(account.app_secret ?? "").trim());
}

export function wechatSaveCredentials(
  appId: string,
  appSecret: string,
  name = "",
  author = "",
): void {
  const config = wechatLoadYaml();
  const accounts = config.accounts && typeof config.accounts === "object"
    ? (config.accounts as Record<string, unknown>)
    : {};
  const current = accounts[WECHAT_WEB_ACCOUNT] && typeof accounts[WECHAT_WEB_ACCOUNT] === "object"
    ? (accounts[WECHAT_WEB_ACCOUNT] as Record<string, unknown>)
    : {};
  current.name = name || String(current.name ?? "") || "微信公众号";
  current.app_id = appId;
  current.app_secret = appSecret;
  current.author = author || String(current.author ?? "");
  accounts[WECHAT_WEB_ACCOUNT] = current;
  config.accounts = accounts;
  config.default = WECHAT_WEB_ACCOUNT;
  writeTextAtomic(WECHAT_CONFIG_YAML, stringifyYaml(config));
}

export function wechatClearCredentials(): void {
  const config = wechatLoadYaml();
  const accounts = config.accounts && typeof config.accounts === "object"
    ? (config.accounts as Record<string, unknown>)
    : undefined;
  if (accounts && WECHAT_WEB_ACCOUNT in accounts) {
    delete accounts[WECHAT_WEB_ACCOUNT];
    config.accounts = accounts;
    if (config.default === WECHAT_WEB_ACCOUNT) {
      config.default = Object.keys(accounts)[0] ?? "";
    }
    try {
      writeTextAtomic(WECHAT_CONFIG_YAML, stringifyYaml(config));
    } catch {
      // Best effort.
    }
  }
  for (const file of [
    path.join(WECHAT_SKILL_SCRIPTS, `.token_cache_${WECHAT_WEB_ACCOUNT}.json`),
    path.join(WECHAT_SKILL_SCRIPTS, ".token_cache.json"),
  ]) {
    try {
      fs.unlinkSync(file);
    } catch {
      // No cache.
    }
  }
}

export async function wechatVerifyToken(): Promise<{ ok: boolean; message: string }> {
  const code = [
    "import sys",
    `sys.path.insert(0, ${JSON.stringify(WECHAT_SKILL_SCRIPTS)})`,
    "from config import set_account",
    "from wechat_token import get_access_token",
    `set_account(${JSON.stringify(WECHAT_WEB_ACCOUNT)})`,
    "try:",
    "    t = get_access_token(force_refresh=True)",
    "    print('OK' if t else 'EMPTY')",
    "except Exception as e:",
    "    print('ERR:' + str(e))",
  ].join("\n");
  const result = await runPython(["-c", code], {
    cwd: WECHAT_SKILL_SCRIPTS,
    env: wechatEnv(),
    timeoutMs: 30000,
  });
  const last = result.stdout.trim().split(/\r?\n/).filter(Boolean).pop() ?? "";
  if (last === "OK") return { ok: true, message: "" };
  if (last.startsWith("ERR:")) return { ok: false, message: last.slice(4).trim().slice(0, 200) };
  if (result.timedOut) return { ok: false, message: "验证超时（网络或 IP 白名单问题）" };
  const stderr = result.stderr.trim().split(/\r?\n/).filter(Boolean).pop() ?? "验证失败";
  return { ok: false, message: stderr.slice(0, 200) };
}

export function accountLoggedIn(platform: string, config: AccountConfig): boolean {
  if (config.backend === "unsupported") return false;
  if (config.backend === "biliup") return fs.existsSync(path.join(PROJECT_ROOT, "cookies.json"));
  if (config.backend === "wechat-oa") {
    try {
      if (mpLoginStatus().state === "success") return true;
    } catch {
      // Fall through to AppID credentials.
    }
    return wechatHasCredentials();
  }
  const marker = path.join(LOGIN_DIR, `${platform}.json`);
  if (!fs.existsSync(marker)) return false;
  return String(readJson<Record<string, unknown>>(marker)?.state ?? "") === "success";
}

export interface LoginStartResult {
  mode: "qr" | "credentials" | "terminal";
  state?: string;
  message?: string;
  qr?: string;
  qrTs?: number;
  configured?: boolean;
}

export async function startLogin(platform: string, restart = false): Promise<LoginStartResult> {
  const config = LOGIN_RUNNERS[platform];
  if (!config) throw new Error("未知平台");
  if (config.backend === "unsupported") throw new Error(`${config.name} 暂不可用：${config.note ?? ""}`);
  if (config.backend === "wechat-oa") {
    return {
      mode: "credentials",
      configured: wechatHasCredentials(),
      message: "微信公众号请填写 AppID / AppSecret",
    };
  }
  const existing = activeLoginProcess(platform);
  if (existing) {
    if (!restart) return { mode: "qr", ...loginStatus(platform) };
    stopLoginProcess(platform);
    await new Promise((resolve) => setTimeout(resolve, 600));
  }
  fs.mkdirSync(LOGIN_DIR, { recursive: true });
  const qr = path.join(LOGIN_DIR, `${platform}.png`);
  const status = path.join(LOGIN_DIR, `${platform}.json`);
  for (const file of [qr, status]) {
    try { fs.unlinkSync(file); } catch { /* absent */ }
  }
  const py = pythonExecutable();
  let args: string[];
  if (config.backend === "xhs") {
    args = [path.join(SHARED_SCRIPTS, "xhs_publish.py"), "login", "--no-proxy",
      "--qr-out", qr, "--status-file", status, "--timeout", String(LOGIN_TIMEOUT)];
  } else if (config.backend === "biliup") {
    args = [path.join(SHARED_SCRIPTS, "bili_login.py"), "login",
      "--qr-out", qr, "--status-file", status,
      "--cookie", path.join(PROJECT_ROOT, "cookies.json"), "--timeout", String(LOGIN_TIMEOUT)];
  } else if (config.backend === "douyin") {
    const codeFile = path.join(LOGIN_DIR, `${platform}.code`);
    try { fs.unlinkSync(codeFile); } catch { /* absent */ }
    args = [path.join(SHARED_SCRIPTS, "douyin_publish.py"), "login", "--no-proxy",
      "--qr-out", qr, "--status-file", status,
      "--sms-code-file", codeFile, "--timeout", String(LOGIN_TIMEOUT)];
  } else {
    args = [path.join(SHARED_SCRIPTS, "web_publisher.py"), "login-qr",
      "--platform", String(config.wp ?? platform), "--qr-out", qr,
      "--status-file", status, "--timeout", String(LOGIN_TIMEOUT)];
  }
  startBackground(platform, py, args, path.join(LOGIN_DIR, `${platform}.log`), {
    ...wechatEnv(),
    PYTHONIOENCODING: "utf-8",
  });
  const current = loginStatus(platform);
  if (current.state === "unknown") {
    current.state = "starting";
    current.message = "正在启动浏览器并准备二维码…";
  }
  return { mode: "qr", ...current };
}

export async function startMpLogin(): Promise<LoginStatus> {
  if (activeLoginProcess("wechat-oa-mp")) return mpLoginStatus();
  fs.mkdirSync(LOGIN_DIR, { recursive: true });
  for (const name of ["wechat-oa-mp.png", "wechat-oa-mp.json"]) {
    try { fs.unlinkSync(path.join(LOGIN_DIR, name)); } catch { /* absent */ }
  }
  const proxy = process.env.EASEL_PROXY ?? process.env.https_proxy ?? "";
  const args = [path.join(SHARED_SCRIPTS, "weixin_mp_stats.py"), "login",
    "--proxy", proxy, "--qr-out", path.join(LOGIN_DIR, "wechat-oa-mp.png"),
    "--status-file", path.join(LOGIN_DIR, "wechat-oa-mp.json"), "--timeout", "240"];
  startBackground("wechat-oa-mp", pythonExecutable(), args,
    path.join(LOGIN_DIR, "wechat-oa-mp.log"), wechatEnv());
  const status = mpLoginStatus();
  if (status.state === "unknown") {
    status.state = "starting";
    status.message = "正在启动浏览器并准备二维码…";
  }
  return status;
}

export function smsCode(code: string): string | undefined {
  const digits = code.replace(/\D/g, "");
  return digits.length >= 4 && digits.length <= 8 ? digits : undefined;
}

export function writeLoginSms(platform: string, code: string): void {
  fs.mkdirSync(LOGIN_DIR, { recursive: true });
  fs.writeFileSync(path.join(LOGIN_DIR, `${platform}.code`), code, "utf8");
}

export function writePublishSms(platform: string, code: string): void {
  fs.mkdirSync(PUBLISH_DIR, { recursive: true });
  fs.writeFileSync(path.join(PUBLISH_DIR, `${platform}.code`), code, "utf8");
}

export async function logoutAccount(platform: string): Promise<{ ok: true; deleted: string[] }> {
  const config = LOGIN_RUNNERS[platform];
  if (!config) throw new Error("未知平台");
  const deleted: string[] = [];
  if (config.backend === "wechat-oa") {
    wechatClearCredentials();
    deleted.push("wechat-publisher.yaml:accounts.web");
    stopLoginProcess("wechat-oa-mp");
    for (const name of ["wechat-oa.json", "wechat-oa.png", "wechat-oa-mp.json",
      "wechat-oa-mp.png", "wechat-oa-mp.log"]) {
      const file = path.join(LOGIN_DIR, name);
      try {
        if (fs.existsSync(file)) { fs.unlinkSync(file); deleted.push(name); }
      } catch { /* ignore */ }
    }
    const profile = path.resolve(BROWSER_PROFILES, "WeixinMpProfile");
    if (profile.startsWith(`${path.resolve(BROWSER_PROFILES)}${path.sep}`) && fs.existsSync(profile)) {
      fs.rmSync(profile, { recursive: true, force: true });
      deleted.push("WeixinMpProfile");
    }
    return { ok: true, deleted };
  }
  stopLoginProcess(platform);
  if (config.profile) {
    const profile = path.resolve(BROWSER_PROFILES, config.profile);
    if (profile.startsWith(`${path.resolve(BROWSER_PROFILES)}${path.sep}`) && fs.existsSync(profile)) {
      fs.rmSync(profile, { recursive: true, force: true });
      deleted.push(config.profile);
    }
  }
  if (config.backend === "biliup") {
    const cookies = path.join(PROJECT_ROOT, "cookies.json");
    try {
      if (fs.existsSync(cookies)) { fs.unlinkSync(cookies); deleted.push("cookies.json"); }
    } catch { /* ignore */ }
  }
  for (const suffix of [".json", ".png", "-me.png", ".code"]) {
    const file = path.join(LOGIN_DIR, `${platform}${suffix}`);
    try {
      if (fs.existsSync(file)) { fs.unlinkSync(file); deleted.push(path.basename(file)); }
    } catch { /* ignore */ }
  }
  return { ok: true, deleted };
}

export interface Whoami {
  loggedIn: boolean;
  name: string;
  avatar: string;
}

const whoamiCache = new Map<string, { at: number; value: Whoami }>();
const whoamiInflight = new Map<string, Promise<Whoami>>();

export async function accountWhoami(platform: string, force = false): Promise<Whoami> {
  const config = LOGIN_RUNNERS[platform];
  if (!config) throw new Error("未知平台");
  if (!force) {
    const cached = whoamiCache.get(platform);
    if (cached && Date.now() - cached.at < 600_000) return cached.value;
  }
  const existing = whoamiInflight.get(platform);
  if (existing) return existing;
  const task = (async (): Promise<Whoami> => {
    if (config.backend === "unsupported") return { loggedIn: false, name: "", avatar: "" };
    if (config.backend === "wechat-oa" && mpLoginStatus().state !== "success") {
      const account = wechatWebAccount();
      return {
        loggedIn: accountLoggedIn(platform, config),
        name: String(account.name ?? "") || "微信公众号",
        avatar: "",
      };
    }
    let command: string[];
    if (config.backend === "biliup") {
      command = [path.join(SHARED_SCRIPTS, "bili_login.py"), "whoami",
        "--cookie", path.join(PROJECT_ROOT, "cookies.json")];
    } else if (config.backend === "xhs") {
      command = [path.join(SHARED_SCRIPTS, "xhs_publish.py"), "whoami", "--no-proxy"];
    } else if (config.backend === "wechat-oa") {
      command = [path.join(SHARED_SCRIPTS, "weixin_mp_stats.py"), "whoami", "--no-proxy"];
    } else if (config.backend === "douyin") {
      command = [path.join(SHARED_SCRIPTS, "douyin_publish.py"), "whoami", "--no-proxy"];
    } else {
      command = [path.join(SHARED_SCRIPTS, "web_publisher.py"), "whoami",
        "--platform", String(config.wp ?? platform)];
    }
    const timeout = config.backend === "xhs" ? 35_000 : ["douyin", "wechat-oa"].includes(config.backend) ? 40_000 : 60_000;
    const result = await runPython(command, { timeoutMs: timeout });
    if (result.timedOut) throw new Error("校验超时（浏览器起不来或网络慢）");
    let data: Whoami = { loggedIn: false, name: "", avatar: "" };
    let confident = false;
    for (const raw of result.stdout.trim().split(/\r?\n/).reverse()) {
      const line = raw.trim();
      if (!line.startsWith("{")) continue;
      try {
        const parsed = JSON.parse(line) as Record<string, unknown>;
        if (typeof parsed.loggedIn === "boolean") {
          data = {
            loggedIn: parsed.loggedIn,
            name: String(parsed.name ?? ""),
            avatar: String(parsed.avatar ?? ""),
          };
          confident = result.code === 0 && !parsed.error;
          break;
        }
      } catch {
        // Ignore diagnostics.
      }
    }
    if (!confident) throw new Error("未能确认当前账号身份，请稍后重试校验；原登录状态和账号资料保持不变");
    if (config.backend === "wechat-oa" && !data.loggedIn && wechatHasCredentials()) {
      const account = wechatWebAccount();
      data = { loggedIn: true, name: String(account.name ?? "") || "微信公众号", avatar: "" };
    }
    whoamiCache.set(platform, { at: Date.now(), value: data });
    if (config.backend !== "biliup") {
      if (data.loggedIn) writeLoginMarker(platform, "success", data.name);
      else {
        try { fs.unlinkSync(path.join(LOGIN_DIR, `${platform}.json`)); } catch { /* absent */ }
      }
    }
    return data;
  })().finally(() => whoamiInflight.delete(platform));
  whoamiInflight.set(platform, task);
  return task;
}

export function clearWhoamiCache(platform?: string): void {
  if (platform) whoamiCache.delete(platform);
  else whoamiCache.clear();
}

export function analyticsEnvironment(): NodeJS.ProcessEnv {
  return { ...wechatEnv(), PYTHONUTF8: "1", PYTHONIOENCODING: "utf-8" };
}

export async function runAnalytics(platform: string): Promise<Record<string, unknown>> {
  let args: string[];
  let timeoutMs: number;
  if (platform === "bilibili") {
    args = [path.join(SHARED_SCRIPTS, "bili_login.py"), "stats",
      "--cookie", path.join(PROJECT_ROOT, "cookies.json")];
    timeoutMs = 90_000;
  } else if (platform === "wechat-oa") {
    const proxy = process.env.EASEL_PROXY ?? process.env.https_proxy ?? "";
    args = [path.join(SHARED_SCRIPTS, "weixin_mp_stats.py"), "stats",
      "--proxy", proxy, "--count", "20"];
    timeoutMs = 180_000;
  } else {
    args = [path.join(SHARED_SCRIPTS, "account_stats.py"), "fetch", "--platform", platform];
    timeoutMs = 90_000;
  }
  const result = await runPython(args, { env: analyticsEnvironment(), timeoutMs });
  if (result.timedOut) throw new Error("抓取超时，已停止浏览器；请检查网络，关闭正在进行的登录或校验后重试");
  for (const raw of result.stdout.trim().split(/\r?\n/).reverse()) {
    const line = raw.trim();
    if (!line.startsWith("{")) continue;
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (result.code !== 0 || parsed.error) {
      throw new Error(String(parsed.error ?? "平台数据抓取失败").slice(0, 240));
    }
    if (parsed.loggedIn === true
      && ["followers", "likes", "following", "posts"].every((key) => parsed[key] === null || parsed[key] === undefined)
      && !parsed.metrics && !parsed.notes) {
      throw new Error("账号已登录，但平台未返回可用数据；请检查网络或平台维护状态后重试");
    }
    return parsed;
  }
  const detail = result.stderr.trim().split(/\r?\n/).filter(Boolean).pop() ?? "未取到数据";
  throw new Error(`未取到数据（可能未登录或平台改版）：${detail.slice(0, 120)}`);
}

export function proxyEnvForScripts(): NodeJS.ProcessEnv {
  return wechatEnv();
}

export type { ProcessResult };
