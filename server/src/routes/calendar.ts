import crypto from "node:crypto";
import { Router } from "express";
import { OUTPUTS_DIR } from "../config.js";
import {
  IDEAS_FILE,
  SCHEDULE_FILE,
  SHARED_SCRIPTS,
  readArrayFile,
  writeJsonAtomic,
} from "../domain.js";
import { asyncRoute, fail, param } from "../http.js";
import { runPython } from "../python.js";

const SCHEDULE_STATUSES = new Set(["idea", "draft", "scheduled", "published"]);
const SCHEDULE_KINDS = new Set(["content", "event"]);
const SCHEDULE_SOURCES = new Set(["manual", "publish-page", "chat", "scheduler"]);
const IDEA_STATUSES = new Set(["pending", "doing", "done"]);

let scheduleLock: Promise<unknown> = Promise.resolve();
function withScheduleLock<T>(fn: () => T): Promise<T> {
  const next = scheduleLock.then(fn, fn);
  scheduleLock = next.catch(() => undefined);
  return next;
}

function stringField(value: unknown, fallback = ""): string {
  return value === undefined || value === null ? fallback : String(value);
}

const TREND_SOURCES: Record<string, [string, string?]> = {
  weibo: ["https://v2.xxapi.cn/api/weibohot", "https://60s.viki.moe/v2/weibo"],
  douyin: ["https://v2.xxapi.cn/api/douyinhot", "https://60s.viki.moe/v2/douyin"],
  zhihu: ["https://api.zhihu.com/topstory/hot-list?limit=50", "https://60s.viki.moe/v2/zhihu"],
  bilibili: ["https://v2.xxapi.cn/api/bilibilihot", "https://60s.viki.moe/v2/bili"],
  baidu: ["https://v2.xxapi.cn/api/baiduhot", "https://60s.viki.moe/v2/baidu/hot"],
  toutiao: ["https://www.toutiao.com/hot-event/hot-board/?origin=toutiao_pc", "https://60s.viki.moe/v2/toutiao"],
};
const TREND_LABELS: Record<string, string> = {
  weibo: "微博", douyin: "抖音", zhihu: "知乎", bilibili: "B站", baidu: "百度", toutiao: "头条",
};
const trendCache = new Map<string, { at: number; items: Array<Record<string, string>> }>();

function pickString(value: unknown, keys: string[]): string {
  if (!value || typeof value !== "object") return "";
  const record = value as Record<string, unknown>;
  for (const key of keys) {
    const item = record[key];
    if ((typeof item === "number" || typeof item === "string") && String(item).trim()) {
      return String(item).trim();
    }
  }
  return "";
}

function parseHot(payload: unknown): Array<Record<string, string>> {
  let data = payload && typeof payload === "object" ? (payload as Record<string, unknown>).data : undefined;
  if (data && typeof data === "object" && !Array.isArray(data)) {
    const record = data as Record<string, unknown>;
    data = record.data ?? record.list ?? [];
  }
  if (!Array.isArray(data)) return [];
  const items: Array<Record<string, string>> = [];
  for (const raw of data) {
    if (typeof raw === "string") {
      if (raw.trim()) items.push({ title: raw.trim(), hot: "", url: "" });
      continue;
    }
    if (!raw || typeof raw !== "object") continue;
    const item = raw as Record<string, unknown>;
    const target = item.target && typeof item.target === "object"
      ? (item.target as Record<string, unknown>)
      : {};
    const title = pickString(item, ["title", "Title", "word", "name", "keyword"])
      || pickString(target, ["title", "Title", "word", "name", "keyword"]);
    if (!title) continue;
    const hot = pickString(item, ["hot", "hot_value", "HotValue", "hotValue", "num", "detail_text"])
      || pickString(target.metrics_area, ["text"]);
    let url = pickString(item, ["url", "Url", "link", "mobil_url"])
      || pickString(target, ["url", "Url", "link", "mobil_url"]);
    const match = /^https?:\/\/api\.zhihu\.com\/questions\/(\d+)$/.exec(url);
    if (match) url = `https://www.zhihu.com/question/${match[1]}`;
    items.push({ title, hot, url });
  }
  return items;
}

async function fetchPlatform(platform: string): Promise<Array<Record<string, string>>> {
  for (const url of TREND_SOURCES[platform] ?? []) {
    if (!url) continue;
    try {
      const response = await fetch(url, {
        headers: {
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0 Safari/537.36",
          Accept: "application/json, text/plain, */*",
        },
        signal: AbortSignal.timeout(8000),
      });
      if (!response.ok) continue;
      const items = parseHot(await response.json());
      if (items.length) return items;
    } catch {
      // Try the backup source.
    }
  }
  return [];
}

export function calendarRouter(): Router {
  const router = Router();

  router.get("/schedule", asyncRoute(async (_req, res) => {
    res.json(readArrayFile(SCHEDULE_FILE));
  }));

  router.post("/schedule", asyncRoute(async (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const item = await withScheduleLock(() => {
      const items = readArrayFile(SCHEDULE_FILE);
      const kind = SCHEDULE_KINDS.has(String(body.kind)) ? String(body.kind) : "content";
      const created = {
        id: crypto.randomUUID().replace(/-/g, "").slice(0, 12),
        title: stringField(body.title).trim() || (kind === "event" ? "未命名活动" : "未命名"),
        date: stringField(body.date),
        platform: stringField(body.platform),
        time: stringField(body.time),
        status: SCHEDULE_STATUSES.has(String(body.status)) ? String(body.status) : "idea",
        note: stringField(body.note),
        kind,
        url: stringField(body.url),
        source: SCHEDULE_SOURCES.has(String(body.source)) ? String(body.source) : "manual",
        event_type: stringField(body.event_type),
        end_date: stringField(body.end_date),
      };
      items.push(created);
      writeJsonAtomic(SCHEDULE_FILE, items);
      return created;
    });
    res.json(item);
  }));

  router.put("/schedule/:sid", asyncRoute(async (req, res) => {
    const id = param(req, "sid");
    const body = (req.body ?? {}) as Record<string, unknown>;
    const updated = await withScheduleLock(() => {
      const items = readArrayFile(SCHEDULE_FILE);
      const item = items.find((candidate) => candidate.id === id);
      if (!item) return undefined;
      const kind = SCHEDULE_KINDS.has(String(body.kind)) ? String(body.kind) : String(item.kind ?? "content");
      Object.assign(item, {
        title: stringField(body.title).trim() || String(item.title ?? "未命名"),
        date: stringField(body.date),
        platform: stringField(body.platform),
        time: stringField(body.time),
        status: SCHEDULE_STATUSES.has(String(body.status)) ? String(body.status) : String(item.status ?? "idea"),
        note: stringField(body.note),
        kind,
        url: stringField(body.url),
        event_type: stringField(body.event_type),
        end_date: stringField(body.end_date),
      });
      writeJsonAtomic(SCHEDULE_FILE, items);
      return item;
    });
    if (!updated) fail("排期不存在", 404);
    res.json(updated);
  }));

  router.delete("/schedule/:sid", asyncRoute(async (req, res) => {
    const id = param(req, "sid");
    const deleted = await withScheduleLock(() => {
      const items = readArrayFile(SCHEDULE_FILE);
      const next = items.filter((item) => item.id !== id);
      if (next.length === items.length) return false;
      writeJsonAtomic(SCHEDULE_FILE, next);
      return true;
    });
    if (!deleted) fail("排期不存在", 404);
    res.json({ ok: true, deleted: id });
  }));

  router.get("/schedule/context", asyncRoute(async (req, res) => {
    const days = Math.max(1, Math.min(Number(req.query.days ?? 14) || 14, 90));
    const result = await runPython(
      [SHARED_SCRIPTS + "/calendar_ops.py", "--data", SCHEDULE_FILE, "context", "--days", String(days)],
      { timeoutMs: 20000 },
    );
    if (result.code !== 0 || !result.stdout.trim()) {
      res.json({});
      return;
    }
    try {
      res.json(JSON.parse(result.stdout));
    } catch {
      res.json({});
    }
  }));

  router.get("/ideas", asyncRoute(async (_req, res) => {
    res.json(readArrayFile(IDEAS_FILE));
  }));

  router.post("/ideas", asyncRoute(async (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const items = readArrayFile(IDEAS_FILE);
    const item = {
      id: crypto.randomUUID().replace(/-/g, "").slice(0, 12),
      title: stringField(body.title).trim() || "未命名选题",
      note: stringField(body.note),
      source: stringField(body.source),
      status: IDEA_STATUSES.has(String(body.status)) ? String(body.status) : "pending",
      created: Math.floor(Date.now() / 1000),
    };
    items.unshift(item);
    writeJsonAtomic(IDEAS_FILE, items);
    res.json(item);
  }));

  router.put("/ideas/:iid", asyncRoute(async (req, res) => {
    const id = param(req, "iid");
    const body = (req.body ?? {}) as Record<string, unknown>;
    const items = readArrayFile(IDEAS_FILE);
    const item = items.find((candidate) => candidate.id === id);
    if (!item) fail("选题不存在", 404);
    Object.assign(item, {
      title: stringField(body.title).trim() || String(item.title ?? "未命名选题"),
      note: stringField(body.note),
      source: stringField(body.source),
      status: IDEA_STATUSES.has(String(body.status)) ? String(body.status) : String(item.status ?? "pending"),
    });
    writeJsonAtomic(IDEAS_FILE, items);
    res.json(item);
  }));

  router.delete("/ideas/:iid", asyncRoute(async (req, res) => {
    const id = param(req, "iid");
    const items = readArrayFile(IDEAS_FILE);
    const next = items.filter((item) => item.id !== id);
    if (next.length === items.length) fail("选题不存在", 404);
    writeJsonAtomic(IDEAS_FILE, next);
    res.json({ ok: true, deleted: id });
  }));

  router.get("/trends", asyncRoute(async (req, res) => {
    const requested = String(req.query.platforms ?? "weibo,douyin,zhihu")
      .split(",")
      .map((item) => item.trim())
      .filter((item) => item in TREND_SOURCES);
    const limit = Math.max(1, Math.min(Number(req.query.limit ?? 12) || 12, 30));
    const now = Date.now();
    const trends = [];
    for (const platform of requested) {
      const cached = trendCache.get(platform);
      let items = cached && now - cached.at < 300_000 ? cached.items : await fetchPlatform(platform);
      if (!items.length && cached) items = cached.items;
      if (items.length) trendCache.set(platform, { at: now, items });
      trends.push({
        platform,
        label: TREND_LABELS[platform] ?? platform,
        items: items.slice(0, limit),
        ok: Boolean(items.length),
      });
    }
    res.json({ trends, updated: Math.floor(now / 1000) });
  }));

  return router;
}
