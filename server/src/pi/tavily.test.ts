import assert from "node:assert/strict";
import { test } from "node:test";
import {
  type FetchLike,
  formatExtractResult,
  formatSearchResult,
  tavilyExtract,
  tavilySearch,
} from "./tavily.js";

const env = { TAVILY_API_KEY: "tvly-test" };

test("tavilySearch requires an API key before calling the network", async () => {
  let called = false;
  const fetchImpl: FetchLike = async () => {
    called = true;
    return new Response("{}", { status: 200 });
  };
  await assert.rejects(
    () => tavilySearch({ query: "test" }, { env: {}, fetchImpl }),
    /TAVILY_API_KEY/,
  );
  assert.equal(called, false);
});

test("tavilySearch sends auth and normalizes results", async () => {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetchImpl: FetchLike = async (input, init) => {
    calls.push({ url: String(input), init: init ?? {} });
    return new Response(JSON.stringify({
      query: "agent tools",
      answer: "A short answer.",
      results: [
        { title: "Result A", url: "https://example.com/a", content: "Snippet A", score: 0.9 },
        { title: "", url: "https://example.com/b", content: "Snippet B", score: "bad" },
        { title: "No URL" },
      ],
      response_time: 1.25,
    }), { status: 200 });
  };

  const result = await tavilySearch({
    query: "  agent tools  ",
    maxResults: 99,
    includeDomains: ["example.com", " example.com ", ""],
  }, { env, fetchImpl });

  assert.equal(calls[0].url, "https://api.tavily.com/search");
  const headers = calls[0].init.headers as Record<string, string>;
  assert.equal(headers.Authorization, "Bearer tvly-test");
  const body = JSON.parse(String(calls[0].init.body)) as Record<string, unknown>;
  assert.equal(body.query, "agent tools");
  assert.equal(body.max_results, 20);
  assert.deepEqual(body.include_domains, ["example.com"]);
  assert.equal(body.include_answer, false);

  assert.equal(result.query, "agent tools");
  assert.equal(result.answer, "A short answer.");
  assert.equal(result.results.length, 2);
  assert.equal(result.results[0].title, "Result A");
  assert.equal(result.results[1].title, "https://example.com/b");
  assert.equal(result.results[1].score, null);
  assert.equal(result.responseTime, 1.25);
  assert.match(formatSearchResult(result), /Result A/);
  assert.match(formatSearchResult(result), /A short answer/);
});

test("tavilyExtract normalizes pages, failures, and truncation", async () => {
  const long = "x".repeat(13_000);
  const fetchImpl: FetchLike = async () => new Response(JSON.stringify({
    results: [
      { url: "https://example.com/a", raw_content: long },
      { url: "https://example.com/empty", raw_content: "" },
    ],
    failed_results: [
      { url: "https://example.com/b", error: "timeout" },
    ],
    response_time: 2,
  }), { status: 200 });

  const result = await tavilyExtract({
    urls: ["https://example.com/a"],
    format: "text",
  }, { env, fetchImpl });

  assert.equal(result.pages.length, 1);
  assert.equal(result.pages[0].truncated, true);
  assert.ok(result.pages[0].content.length < long.length);
  assert.match(result.pages[0].content, /内容已截断/);
  assert.deepEqual(result.failed, [{ url: "https://example.com/b", error: "timeout" }]);
  assert.match(formatExtractResult(result), /抓取失败/);
});

test("tavilyExtract rejects unsafe URLs", async () => {
  const fetchImpl: FetchLike = async () => new Response("{}", { status: 200 });
  await assert.rejects(
    () => tavilyExtract({ urls: ["file:///etc/passwd"] }, { env, fetchImpl }),
    /http\/https/,
  );
  await assert.rejects(
    () => tavilyExtract({ urls: ["http://localhost:7860"] }, { env, fetchImpl }),
    /本机地址/,
  );
});

test("Tavily HTTP errors include status without exposing the key", async () => {
  const fetchImpl: FetchLike = async () => new Response("invalid api key", { status: 401 });
  await assert.rejects(
    () => tavilySearch({ query: "test" }, { env, fetchImpl }),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /HTTP 401/);
      assert.match(error.message, /invalid api key/);
      assert.doesNotMatch(error.message, /tvly-test/);
      return true;
    },
  );
});
