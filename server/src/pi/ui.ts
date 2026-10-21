import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import { ask, type EventSink } from "./host.js";

export function createEaselUI(sessionId: string, emit: EventSink): ExtensionUIContext {
  const select = async (
    title: string,
    options: string[],
    opts?: { timeout?: number; signal?: AbortSignal },
  ): Promise<string | undefined> => {
    const answers = await ask(
      sessionId,
      [
        {
          questionId: "ui_select",
          header: "需要确认",
          question: title,
          options: options.map((label) => ({ label })),
          multiSelect: false,
        },
      ],
      opts?.timeout ? Math.ceil(opts.timeout / 1000) : undefined,
    );
    return answers.ui_select?.[0];
  };

  return {
    select,
    confirm: async (title: string, message: string, opts?: { timeout?: number; signal?: AbortSignal }) => {
      const answers = await ask(
        sessionId,
        [
          {
            questionId: "ui_confirm",
            header: "需要确认",
            question: `${title}\n\n${message}`,
            options: [{ label: "允许" }, { label: "拒绝" }],
            multiSelect: false,
          },
        ],
        opts?.timeout ? Math.ceil(opts.timeout / 1000) : undefined,
      );
      return answers.ui_confirm?.[0] === "允许";
    },
    input: async (title: string, placeholder?: string, opts?: { timeout?: number; signal?: AbortSignal }) => {
      const answers = await ask(
        sessionId,
        [
          {
            questionId: "ui_input",
            header: "需要输入",
            question: placeholder ? `${title}\n\n${placeholder}` : title,
            options: [],
            multiSelect: false,
          },
        ],
        opts?.timeout ? Math.ceil(opts.timeout / 1000) : undefined,
      );
      return answers.ui_input?.[0];
    },
    notify(message: string, type?: "info" | "warning" | "error") {
      emit(type === "error" ? "error" : "activity", message);
    },
    onTerminalInput() {
      return () => {};
    },
    setStatus() {},
    setWorkingMessage(message?: string) {
      if (message) emit("activity", message);
    },
    setWorkingVisible() {},
    setWorkingIndicator() {},
    setHiddenThinkingLabel() {},
    setWidget() {},
    setFooter() {},
    setHeader() {},
    setTitle() {},
    async custom() {
      return undefined as never;
    },
    pasteToEditor() {},
    setEditorText() {},
    getEditorText() {
      return "";
    },
    editor: async (title: string, prefill?: string) => {
      const answers = await ask(sessionId, [
        {
          questionId: "ui_editor",
          header: "需要输入",
          question: prefill ? `${title}\n\n${prefill}` : title,
          options: [],
          multiSelect: false,
        },
      ]);
      return answers.ui_editor?.[0];
    },
    addAutocompleteProvider() {},
    setEditorComponent() {},
    getEditorComponent() {
      return undefined;
    },
    get theme() {
      // Terminal themes are a TUI preference. Easel renders the conversation in
      // the browser, so extensions that only use `theme` for TUI chrome can
      // still load; none of Easel's built-in extensions read it.
      return {} as never;
    },
    getAllThemes() {
      return [];
    },
    getTheme() {
      return undefined;
    },
    setTheme() {
      return { success: false, error: "Easel 使用浏览器界面，不支持终端主题" };
    },
    getToolsExpanded() {
      return false;
    },
    setToolsExpanded() {},
  } as unknown as ExtensionUIContext;
}
