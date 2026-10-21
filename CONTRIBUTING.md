# 贡献指南

感谢参与 Easel。项目以 Apache-2.0 开源，欢迎 Issue 和 PR。

## 反馈 Issue

- **环境问题**：附上操作系统、Node.js、Python、`easel doctor` 输出和脱敏后的错误日志。先查[已知问题](docs/known-issues.md)。
- **功能建议 / 新技能**：先开 Issue 说明场景与预期产物，确认方向后再动手，避免大改撞车。

## 提交前必跑

```bash
npm run typecheck
npm run build
python scripts/validate_skills.py
python scripts/validate_skill_commands.py
python scripts/validate_document_paths.py
.venv/bin/python -m pytest tests/
```

前端改动还应运行：

```bash
npm --prefix web/frontend run lint
npm --prefix web/frontend run build
```

路径校验覆盖根文档、`docs/`、`agents/` 和 `skills/` 下的 Markdown，以及画像模板和前端说明。命令里的 `skills/...` 相对项目根，技能资源名相对技能目录，Markdown 链接与显式 `../` 相对当前文档；占位符和运行时生成的产物不要求预先存在。

## 架构约定

- **pi 是唯一 Agent 内核**。不要新增或恢复任何其它 Agent 运行时或仅聊天 API 回退。
- HTTP/SSE 后端位于 `server/`，使用 TypeScript；`easel/cli.py` 只是 Node 后端的薄启动器。
- `ask_user` 和 permissions 是 pi 扩展，位于 `server/extensions/`。
- 复杂媒体处理、浏览器登录和平台发布保留为 Python 脚本，由 TypeScript 路由调用。
- Python 依赖只用于媒体和平台操作，不再引入 Web 框架或 Agent 运行时。

## Skill 约定

- 遵循 [SKILL 接口规范](docs/SKILL-SPEC.md)：frontmatter 含 `name / description / layer`，SKILL.md 精简（< 200 行），领域知识进 `references/`，可执行脚本进 `scripts/`。
- 产物统一写入 `outputs/<项目>/`，路径经 `skills/shared/scripts/output_paths.py` 校验。
- 发布类技能保持门禁语义：先预览与发布前检查，真实发布由用户确认后执行。
- 账号画像只从 `profiles/<画像>/` 读取，不写全局记忆文件。

## 代码约定

- Node.js >= 22.19；Python >= 3.10。
- 前端为 React + Vite（`web/frontend/`），后端入口为 `server/src/index.ts`。
- 会话、任务日志和绑定只写入 `outputs/_pi/`。
- 凭证不进仓库：`.env` 不入库；测试不得调用真实模型、真实平台或外部消息渠道。

## PR 约定

- 一个 PR 只做一件事；标题用 `feat: / fix: / docs: / chore: / polish:` 前缀。
- 描述里写清动机与验证方式；涉及技能行为改动时附上触发示例。
- 第三方素材或技能引入需在 [ACKNOWLEDGMENTS](docs/ACKNOWLEDGMENTS.md) 登记来源与许可。
