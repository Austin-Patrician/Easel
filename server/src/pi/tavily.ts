import { isConfigured, mask, readEnv } from "../config.js";

const TAVILY_BASE_URL = "https://api.tavily.com";
const SEARCH_TIMEOUT_MS = 20_000;
const EXTRACT_TIMEOUT_MS = 40_000;
const MAX_EXTRACT_CHARS = 12_000;
const MAX_EXTRACT_TOTAL_CHARS = 30_000;

export type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>;

export interface TavilyRequestOptions {
  signal?: AbortSignal;
  fetchImpl?: FetchLike;
  env?: Record<string, string>;
  timeoutMs?: number;
}

export interface WebSearchInput {
  query: string;
  maxResults?: number;
  searchDepth?: "basic" | "advanced";
  topic?: "general" | "news" | "finance";
  includeDomains?: string[];
  excludeDomains?: string[];
  timeRange?: "day" | "week" | "month" | "year";
  includeAnswer?: boolean;
}

export interface WebSearchHit {
  title: string;
  url: string;
  content: string;
  score: number | null;
}

export interface WebSearchResult {
  query: string;
  answer: string | null;
  results: WebSearchHit[];
  responseTime: number | null;
}

export interface WebExtractInput {
  urls: string[];
  extractDepth?: "basic" | "advanced";
  format?: "markdown" | "text";
  includeImages?: boolean;
  timeout?: number;
}

export interface WebExtractPage {
  url: string;
  content: string;
  truncated: boolean;
}

export interface WebExtractFailure {
  url: string;
  error: string;
}

export interface WebExtractResult {
  pages: WebExtractPage[];
  failed: WebExtractFailure[];
  responseTime: number | null;
}

interface TavilySearchResponse {
  query?: unknown;
  answer?: unknown;
  results?: unknown;
  response_time?: unknown;
}

interface TavilyExtractResponse {
  results?: unknown;
  failed_results?: unknown;
  response_time?: unknown;
}

export class TavilyError extends Error {
  readonly status?: number;

  constructor(message: string, status?: number) {
    super(message);
    this.name = "TavilyError";
    this.status = status;
  }
}

export interface WebSearchSettingsStatus {
  configured: boolean;
  keyMasked: string;
}

export function webSearchStatus(env: Record<string, string> = readEnv()): WebSearchSettingsStatus {
  const configured = isConfigured(env.TAVILY_API_KEY);
  return {
    configured,
    keyMasked: configured ? mask(env.TAVILY_API_KEY) : "",
  };
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function numberValue(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function recordValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function clip(text: string, limit: number): string {
  if (text.length <= limit) return text;
  return `${text.slice(0, limit)}\n\n[内容已截断]`;
}

function tavilyKey(env: Record<string, string>): string {
  const key = (env.TAVILY_API_KEY ?? "").trim();
  if (!isConfigured(key)) {
    throw new TavilyError(
      "未配置 TAVILY_API_KEY。请在项目 .env 中添加 TAVILY_API_KEY=tvly-... 后重试。",
    );
  }
  return key;
}

function domainList(values: string[] | undefined): string[] {
  if (!values?.length) return [];
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))].slice(0, 20);
}

function checkedQuery(query: string): string {
  const value = query.trim();
  if (!value) throw new TavilyError("搜索关键词不能为空");
  if (value.length > 400) throw new TavilyError("搜索关键词不能超过 400 个字符");
  return value;
}

function checkedUrls(urls: string[]): string[] {
  const unique = [...new Set(urls.map((value) => value.trim()).filter(Boolean))];
  if (!unique.length) throw new TavilyError("至少需要一个网页 URL");
  if (unique.length > 5) throw new TavilyError("一次最多抓取 5 个网页");
  for (const value of unique) {
    let parsed: URL;
    try {
      parsed = new URL(value);
    } catch {
      throw new TavilyError(`无效的网页 URL：${value}`);
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      throw new TavilyError(`只支持 http/https URL：${value}`);
    }
    if (parsed.username || parsed.password) {
      throw new TavilyError(`URL 不能包含用户名或密码：${value}`);
    }
    const host = parsed.hostname.toLowerCase();
    if (host === "localhost" || host.endsWith(".localhost") || host === "127.0.0.1" || host === "::1") {
      throw new TavilyError(`不能抓取本机地址：${value}`);
    }
  }
  return unique;
}

async function tavilyPost<T>(
  path: string,
  body: Record<string, unknown>,
  options: TavilyRequestOptions,
  defaultTimeoutMs: number,
): Promise<T> {
  const key = tavilyKey(options.env ?? readEnv());
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeout = AbortSignal.timeout(options.timeoutMs ?? defaultTimeoutMs);
  const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
  let response: Response;
  try {
    response = await fetchImpl(`${TAVILY_BASE_URL}${path}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
        "User-Agent": "Easel/0.4",
      },
      body: JSON.stringify(body),
      signal,
    });
  } catch (error) {
    if (options.signal?.aborted) throw new TavilyError("请求已取消");
    if (error instanceof Error && error.name === "TimeoutError") {
      throw new TavilyError("Tavily 请求超时，请稍后重试");
    }
    throw new TavilyError(`无法连接 Tavily：${error instanceof Error ? error.message : String(error)}`);
  }

  const text = await response.text();
  if (!response.ok) {
    throw new TavilyError(
      `Tavily 请求失败（HTTP ${response.status}）：${clip(text, 1000)}`,
      response.status,
    );
  }
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new TavilyError("Tavily 返回了无法解析的响应");
  }
}

export async function tavilySearch(
  input: WebSearchInput,
  options: TavilyRequestOptions = {},
): Promise<WebSearchResult> {
  const query = checkedQuery(input.query);
  const includeDomains = domainList(input.includeDomains);
  const excludeDomains = domainList(input.excludeDomains);
  const payload = await tavilyPost<TavilySearchResponse>("/search", {
    query,
    max_results: Math.min(20, Math.max(1, Math.trunc(input.maxResults ?? 5))),
    search_depth: input.searchDepth ?? "basic",
    topic: input.topic ?? "general",
    include_answer: input.includeAnswer === true,
    include_raw_content: false,
    include_images: false,
    ...(includeDomains.length ? { include_domains: includeDomains } : {}),
    ...(excludeDomains.length ? { exclude_domains: excludeDomains } : {}),
    ...(input.timeRange ? { time_range: input.timeRange } : {}),
  }, options, SEARCH_TIMEOUT_MS);

  const rawResults = Array.isArray(payload.results) ? payload.results : [];
  const results: WebSearchHit[] = [];
  for (const raw of rawResults) {
    const item = recordValue(raw);
    const url = stringValue(item.url);
    if (!url) continue;
    results.push({
      title: stringValue(item.title) || url,
      url,
      content: stringValue(item.content),
      score: numberValue(item.score),
    });
  }
  return {
    query,
    answer: stringValue(payload.answer) || null,
    results,
    responseTime: numberValue(payload.response_time),
  };
}

export async function tavilyExtract(
  input: WebExtractInput,
  options: TavilyRequestOptions = {},
): Promise<WebExtractResult> {
  const urls = checkedUrls(input.urls);
  const payload = await tavilyPost<TavilyExtractResponse>("/extract", {
    urls,
    extract_depth: input.extractDepth ?? "basic",
    format: input.format ?? "markdown",
    include_images: input.includeImages === true,
    timeout: Math.min(30, Math.max(1, Math.trunc(input.timeout ?? 10))),
  }, options, EXTRACT_TIMEOUT_MS);

  let remaining = MAX_EXTRACT_TOTAL_CHARS;
  const pages: WebExtractPage[] = [];
  const rawPages = Array.isArray(payload.results) ? payload.results : [];
  for (const raw of rawPages) {
    const item = recordValue(raw);
    const url = stringValue(item.url);
    const content = stringValue(item.raw_content);
    if (!url || !content) continue;
    const limit = Math.max(0, Math.min(MAX_EXTRACT_CHARS, remaining));
    if (limit === 0) break;
    const clipped = clip(content, limit);
    remaining -= clipped.length;
    pages.push({
      url,
      content: clipped,
      truncated: clipped.length < content.length,
    });
  }

  const failed: WebExtractFailure[] = [];
  const rawFailed = Array.isArray(payload.failed_results) ? payload.failed_results : [];
  for (const raw of rawFailed) {
    const item = recordValue(raw);
    const url = stringValue(item.url);
    if (!url) continue;
    failed.push({ url, error: stringValue(item.error) || "抓取失败" });
  }

  return {
    pages,
    failed,
    responseTime: numberValue(payload.response_time),
  };
}

export function formatSearchResult(result: WebSearchResult): string {
  const sections = [`搜索：${result.query}`];
  if (result.answer) sections.push(`摘要：${result.answer}`);
  if (!result.results.length) {
    sections.push("没有找到结果。可以换关键词，或用 web_extract 读取已知 URL。");
  } else {
    result.results.forEach((hit, index) => {
      sections.push(`### ${index + 1}. ${hit.title}\n${hit.url}\n\n${hit.content || "（无摘要）"}`);
    });
  }
  return sections.join("\n\n");
}

export function formatExtractResult(result: WebExtractResult): string {
  const sections: string[] = [];
  if (!result.pages.length && !result.failed.length) return "没有抓取到内容。";
  result.pages.forEach((page) => {
    sections.push(`## ${page.url}\n\n${page.content}`);
  });
  if (result.failed.length) {
    sections.push(`## 抓取失败\n\n${result.failed.map((item) => `- ${item.url}：${item.error}`).join("\n")}`);
  }
  return sections.join("\n\n");
}
