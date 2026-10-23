/**
 * Easel permission extension.
 *
 * Pi has no built-in sandbox or approval policy. This extension gates tool calls
 * using the host's read-only / workspace-write policy and asks through Easel's
 * question card when required. It fails closed when no UI is available.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

type Decision = { action: "allow" | "deny" | "ask"; reason?: string; title?: string; detail?: string };

interface HostBridge {
  permission(sessionId: string, event: { toolName: string; input: unknown; cwd: string }): Promise<Decision>;
  ask(sessionId: string, questions: unknown[], timeoutSeconds?: number): Promise<Record<string, string[]>>;
}

const SAFE_READ_TOOLS = new Set(["read", "grep", "find", "ls", "web_search", "web_extract"]);

export default function permissionExtension(pi: ExtensionAPI) {
  pi.on("tool_call", async (event, ctx) => {
    if (event.toolName === "ask_user") return undefined;

    const host = (globalThis as { __easelPiHost?: HostBridge }).__easelPiHost;
    let decision: Decision;
    if (host) {
      decision = await host.permission(ctx.sessionManager.getSessionId(), {
        toolName: event.toolName,
        input: event.input,
        cwd: ctx.cwd,
      });
    } else {
      decision = SAFE_READ_TOOLS.has(event.toolName)
        ? { action: "allow" }
        : { action: "deny", reason: "没有可用的权限策略" };
    }

    if (decision.action === "allow") return undefined;
    if (decision.action === "deny") {
      return { block: true, reason: decision.reason || "权限策略拒绝了此操作" };
    }

    if (!host || !ctx.hasUI) {
      return { block: true, reason: "此操作需要用户确认，但当前没有可用的确认界面" };
    }
    const answers = await host.ask(ctx.sessionManager.getSessionId(), [{
      questionId: "ui_select",
      header: "需要确认",
      question: decision.title || `允许执行「${event.toolName}」？`,
      detail: decision.detail,
      options: [{ label: "允许本次" }, { label: "拒绝" }],
      multiSelect: false,
    }]);
    if (answers.ui_select?.[0] !== "允许本次") {
      return { block: true, reason: "用户拒绝了此操作" };
    }
    return undefined;
  });
}
