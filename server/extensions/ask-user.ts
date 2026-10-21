/**
 * Easel ask_user extension.
 *
 * Pi does not ship a first-class "ask the human" tool. Easel's frontend already
 * renders a structured question card and posts answers back over HTTP, so this
 * extension registers the tool and delegates the round-trip to the Node host.
 *
 * Loaded by the SDK through DefaultResourceLoader.additionalExtensionPaths.
 */
import { Type } from "typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

interface HostBridge {
  ask(sessionId: string, questions: unknown[], timeoutSeconds?: number): Promise<Record<string, string[]>>;
}

const Option = Type.Object({
  label: Type.String({ maxLength: 80 }),
  description: Type.Optional(Type.String({ maxLength: 300 })),
});

export default function askUserExtension(pi: ExtensionAPI) {
  pi.registerTool({
    name: "ask_user",
    label: "询问用户",
    description:
      "向用户展示一张可选择的问答卡片并等待回答。用于缺少关键信息、需要用户拍板、权限确认或验证码等场景。" +
      "一次 1–3 个问题，每题 2–4 个选项；用户也可以自行输入答案。",
    parameters: Type.Object({
      questions: Type.Array(
        Type.Object({
          id: Type.Optional(Type.String({ maxLength: 80 })),
          questionId: Type.Optional(Type.String({ maxLength: 80 })),
          header: Type.Optional(Type.String({ maxLength: 40 })),
          question: Type.String({ maxLength: 2000 }),
          options: Type.Optional(Type.Array(Option)),
          multiSelect: Type.Optional(Type.Boolean()),
        }),
        { minItems: 1, maxItems: 3 },
      ),
      timeoutSeconds: Type.Optional(Type.Number({ minimum: 1, maximum: 3600 })),
    }),
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const host = (globalThis as { __easelPiHost?: HostBridge }).__easelPiHost;
      if (!host) throw new Error("ask_user host bridge is not available");
      const sessionId = ctx.sessionManager.getSessionId();
      const questions = params.questions.map((item, index) => ({
        questionId: item.questionId || item.id || `q${index + 1}`,
        header: item.header,
        question: item.question,
        options: item.options ?? [],
        multiSelect: item.multiSelect === true,
      }));
      if (signal.aborted) throw new Error("ask_user aborted");
      const answers = await host.ask(sessionId, questions, params.timeoutSeconds);
      if (signal.aborted) throw new Error("ask_user aborted");
      return {
        content: [{ type: "text", text: JSON.stringify({ answers }, null, 2) }],
        details: { answers },
      };
    },
  });
}
