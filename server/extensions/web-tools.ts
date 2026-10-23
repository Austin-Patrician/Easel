/**
 * Easel web tools extension.
 *
 * Pi has no built-in web search. Tavily is exposed as two read-only tools so
 * the agent can research without falling back to curl and shell approvals.
 */
import { Type } from "typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  formatExtractResult,
  formatSearchResult,
  tavilyExtract,
  tavilySearch,
} from "../src/pi/tavily.js";

const SearchDepth = Type.Union([Type.Literal("basic"), Type.Literal("advanced")]);
const SearchTopic = Type.Union([Type.Literal("general"), Type.Literal("news"), Type.Literal("finance")]);
const TimeRange = Type.Union([
  Type.Literal("day"),
  Type.Literal("week"),
  Type.Literal("month"),
  Type.Literal("year"),
]);
const ExtractDepth = Type.Union([Type.Literal("basic"), Type.Literal("advanced")]);
const ExtractFormat = Type.Union([Type.Literal("markdown"), Type.Literal("text")]);

export default function webToolsExtension(pi: ExtensionAPI) {
  pi.registerTool({
    name: "web_search",
    label: "联网搜索",
    description:
      "使用 Tavily 搜索公开互联网，返回标题、URL、摘要和可选答案。需要实时信息、新闻或外部资料时优先使用。"
      + "不要用 curl/wget 搜索网页；已知网址需要正文时使用 web_extract。需要用户提供 TAVILY_API_KEY。",
    parameters: Type.Object({
      query: Type.String({ minLength: 1, maxLength: 400 }),
      maxResults: Type.Optional(Type.Number({ minimum: 1, maximum: 20 })),
      searchDepth: Type.Optional(SearchDepth),
      topic: Type.Optional(SearchTopic),
      includeDomains: Type.Optional(Type.Array(Type.String({ maxLength: 200 }), { maxItems: 20 })),
      excludeDomains: Type.Optional(Type.Array(Type.String({ maxLength: 200 }), { maxItems: 20 })),
      timeRange: Type.Optional(TimeRange),
      includeAnswer: Type.Optional(Type.Boolean()),
    }),
    async execute(_toolCallId, params, signal) {
      const result = await tavilySearch(params, { signal });
      return {
        content: [{ type: "text", text: formatSearchResult(result) }],
        details: result,
      };
    },
  });

  pi.registerTool({
    name: "web_extract",
    label: "读取网页",
    description:
      "使用 Tavily Extract 读取 1–5 个公开网页的正文，返回 Markdown 或纯文本。"
      + "适合在 web_search 之后读取原文；不要用 curl/wget 抓网页。",
    parameters: Type.Object({
      urls: Type.Array(Type.String({ maxLength: 2000 }), { minItems: 1, maxItems: 5 }),
      extractDepth: Type.Optional(ExtractDepth),
      format: Type.Optional(ExtractFormat),
      includeImages: Type.Optional(Type.Boolean()),
      timeout: Type.Optional(Type.Number({ minimum: 1, maximum: 30 })),
    }),
    async execute(_toolCallId, params, signal) {
      const result = await tavilyExtract(params, { signal });
      return {
        content: [{ type: "text", text: formatExtractResult(result) }],
        details: result,
      };
    },
  });
}
