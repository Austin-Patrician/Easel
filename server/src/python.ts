import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { PROJECT_ROOT } from "./config.js";

export function pythonExecutable(): string {
  const venv = path.join(
    PROJECT_ROOT,
    ".venv",
    process.platform === "win32" ? "Scripts/python.exe" : "bin/python",
  );
  if (fs.existsSync(venv)) return venv;
  return process.platform === "win32" ? "python" : "python3";
}

const DEFAULT_NO_PROXY =
  "localhost,127.0.0.1,10.*,*.xiaohongshu.com,*.devops.xiaohongshu.com,*.douyin.com,*.kuaishou.com,*.zhihu.com,*.bilibili.com,*.weixin.qq.com,*.qq.com";

export function proxyEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  env.EASEL_ROOT ??= PROJECT_ROOT;
  if (process.env.EASEL_PROXY) {
    env.http_proxy ??= process.env.EASEL_PROXY;
    env.https_proxy ??= process.env.EASEL_PROXY;
  }
  env.no_proxy ??= DEFAULT_NO_PROXY;
  env.PYTHONUTF8 ??= "1";
  env.PYTHONIOENCODING ??= "utf-8";
  return env;
}

export function publishEnv(): NodeJS.ProcessEnv {
  return { ...proxyEnv(), EASEL_CALENDAR_AUTORECORD: "0" };
}

export function wechatEnv(): NodeJS.ProcessEnv {
  const env = publishEnv();
  const hosts = ["api.weixin.qq.com", "mp.weixin.qq.com"];
  const egress = (process.env.WECHAT_EGRESS_PROXY ?? "").trim();
  if (egress) {
    env.http_proxy = egress;
    env.https_proxy = egress;
    env.HTTP_PROXY = egress;
    env.HTTPS_PROXY = egress;
    env.no_proxy = (env.no_proxy ?? "")
      .split(",")
      .filter((item) => item && !hosts.some((host) => item.includes(host)))
      .join(",");
    env.NO_PROXY = env.no_proxy;
  } else {
    const current = env.no_proxy ?? "";
    env.no_proxy = current ? `${current},${hosts.join(",")}` : hosts.join(",");
    env.NO_PROXY = env.no_proxy;
  }
  return env;
}

export interface ProcessResult {
  code: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

export function runProcess(
  command: string,
  args: string[],
  options: { cwd?: string; env?: NodeJS.ProcessEnv; timeoutMs?: number; maxOutput?: number } = {},
): Promise<ProcessResult> {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd: options.cwd ?? PROJECT_ROOT,
      env: options.env ?? proxyEnv(),
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const maxOutput = options.maxOutput ?? 4 * 1024 * 1024;
    const append = (current: string, chunk: Buffer): string => {
      if (current.length >= maxOutput) return current;
      return (current + chunk.toString("utf8")).slice(0, maxOutput);
    };
    child.stdout.on("data", (chunk: Buffer) => {
      stdout = append(stdout, chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr = append(stderr, chunk);
    });
    const timer = options.timeoutMs
      ? setTimeout(() => {
          timedOut = true;
          try {
            if (process.platform === "win32" && child.pid) {
              spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore" });
            } else {
              child.kill("SIGKILL");
            }
          } catch {
            // Process already gone.
          }
        }, options.timeoutMs)
      : undefined;
    child.on("error", (error) => {
      if (timer) clearTimeout(timer);
      resolve({ code: 127, stdout, stderr: `${stderr}\n${error.message}`.trim(), timedOut });
    });
    child.on("close", (code) => {
      if (timer) clearTimeout(timer);
      resolve({ code: code ?? 1, stdout, stderr, timedOut });
    });
  });
}

export function runPython(
  args: string[],
  options: { cwd?: string; env?: NodeJS.ProcessEnv; timeoutMs?: number; maxOutput?: number } = {},
): Promise<ProcessResult> {
  return runProcess(pythonExecutable(), args, options);
}

/** Parse the last JSON object printed by a Python helper that emits diagnostics plus one JSON result. */
export function lastJsonObject(text: string): Record<string, unknown> | undefined {
  for (const raw of text.trim().split(/\r?\n/).reverse()) {
    const line = raw.trim();
    if (!line.startsWith("{")) continue;
    try {
      const value = JSON.parse(line) as unknown;
      if (value && typeof value === "object" && !Array.isArray(value)) {
        return value as Record<string, unknown>;
      }
    } catch {
      // Keep looking upwards.
    }
  }
  return undefined;
}
