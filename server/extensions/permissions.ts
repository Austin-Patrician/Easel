/**
 * Easel permission extension.
 *
 * Pi has no built-in sandbox or approval policy. This extension gates tool calls
 * using the host's read-only / workspace-write policy and asks through Easel's
 * question card when required. It fails closed when no UI is available.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

type Decision = { action: "allow" | "deny" | "ask"; reason?: string; detail?: string };

interface HostBridge {
  permission(sessionId: string, event: { toolName: string; input: unknown; cwd: string }): Promise<Decision>;
}

const SAFE_READ_TOOLS = new Set(["read", "grep", "find", "ls"]);

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

    if (!ctx.hasUI) {
      return { block: true, reason: "此操作需要用户确认，但当前没有可用的确认界面" };
    }
    const choice = await ctx.ui.select(
      decision.detail || `允许执行「${event.toolName}」？`,
      ["允许本次", "拒绝"],
    );
    if (choice !== "允许本次") return { block: true, reason: "用户拒绝了此操作" };
    return undefined;
  });
}
