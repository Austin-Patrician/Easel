# Easel Prompt Stack

> Easel 只使用 pi TypeScript SDK，prompt 由工作区文档、运行时说明和按需加载的技能组成。

## 组合顺序

```text
Layer 1: SOUL.md         人格、沟通风格与能力总览
Layer 2: AGENTS.md       分工规则、编排逻辑、计划与制作流程
Layer 3: 运行时说明      当前引擎、项目根、Python 路径、权限与产物路径
Layer 4: SKILL           触发时读取 SKILL.md，并按需加载 references/ 与 scripts/
```

实现位置：

- `server/src/pi/prompt.ts` 读取 `agents/workspace/*.md`，按 SOUL.md、AGENTS.md、其它文件的顺序拼接。
- 同一文件追加运行时说明，明确 pi 是唯一执行引擎、当前 sandbox、项目根、技能目录、Python 路径与输出目录。
- `DefaultResourceLoader` 注册 `server/extensions/ask-user.ts`、`server/extensions/permissions.ts` 和 `skills/builtin`。
- `server/src/persona.ts` 把画像文本作为消息内联传入，不修改任何全局记忆文件。

## 画像与记忆

- 每个会话绑定一个画像；画像文件位于 `profiles/<name>/`。
- 账号长期记忆只存放在 `profiles/<name>/memory.md`。
- 通用模式不读取任何画像记忆。
- 不使用全局 `MEMORY.md`，也不会通过改写全局文件来切换画像。

## 技能加载

- 技能源目录：`skills/builtin/`。
- 共享脚本与资源：`skills/shared/`。
- SKILL.md 是流程规范。模型需要先读取对应技能，再执行其中的步骤，而不是依赖隐藏的 slash 命令。
- 每次用户回合末尾会追加一条内部提醒，要求先查技能库、使用真实账号数据、不要把敏感信息写进公开内容。

## 权限

pi 的 `tool_call` 扩展在工具执行前读取主机策略：

- `read-only`：拒绝写文件和执行命令；
- `workspace-write`：允许工作区内的文件修改和命令执行，但仍受扩展规则约束。

需要额外授权时，扩展通过问题卡片向用户确认；用户拒绝后工具不会执行。

## 修改提示词

直接编辑 `agents/workspace/` 下的 Markdown。下一轮 pi 会话会重新加载，无需同步脚本或重启服务。
