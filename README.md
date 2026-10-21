<p align="center">
  <img src="assets/readme/brand.png#gh-light-mode-only" width="640" alt="Easel">
  <img src="assets/readme/brand-dark.png#gh-dark-mode-only" width="640" alt="Easel">
</p>

<p align="center">
  <strong>简体中文</strong> · <a href="README_EN.md">English</a>
</p>

<p align="center">
  你的私人、持续进化的社媒运营助手<br>
  从一个想法开始，完成发现、策划、创作、发布与复盘。
</p>

<p align="center">
  <a href="https://zju-real.github.io/Easel/"><img src="https://img.shields.io/badge/Easel-Project_Page-F05A3C?style=flat-square&logo=googlechrome&logoColor=white" alt="Easel Project Page"></a>
  <img src="https://img.shields.io/badge/pi-SDK-111827?style=flat-square" alt="pi SDK">
  <img src="https://img.shields.io/badge/Node.js-22.19%2B-339933?style=flat-square&logo=node.js&logoColor=white" alt="Node.js 22.19+">
  <img src="https://img.shields.io/badge/TypeScript-5.9-3178C6?style=flat-square&logo=typescript&logoColor=white" alt="TypeScript 5.9">
  <img src="https://img.shields.io/badge/Python-3.10%2B-3776AB?style=flat-square&logo=python&logoColor=white" alt="Python 3.10+">
  <a href="docs/skill-function-mapping.md"><img src="https://img.shields.io/badge/Skills-114-0F9D8A?style=flat-square" alt="114 Skills"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-Apache_2.0-2EA44F?style=flat-square" alt="License: Apache 2.0"></a>
</p>

![Easel 产品宣传海报](assets/readme/poster.png)

## Easel 是什么

Easel 是一个面向社交媒体创作者的开源内容工作台。它把 Agent、账号画像、内容技能和真实的媒体工具接在一起，让 Agent 不只回答“应该怎么做”，而是直接把内容做出来并归档，并在需要时发布。

你可以把它理解成一个会记住你的内容搭档：它了解账号定位、受众、风格、平台限制和历史表现，从热点发现一直陪你做到发布，再把结果带回下一次创作。

Easel 围绕五个连续工作流展开：**发现**适合账号的热点与机会，**策划**选题、标题、脚本和排期，**创作**图文、音频与视频内容，**发布**经过检查和平台适配的成品，再通过**归因**分析表现并把有效经验沉淀回账号画像。

## 架构：pi 是唯一 Agent 内核

Easel 现在只使用 [pi](https://github.com/earendil-works/pi) 的 TypeScript SDK 作为 Agent 内核，没有任何其它 Agent 运行时或仅聊天 API 回退路径。

```text
React 前端
    │  HTTP / SSE
    ▼
TypeScript 后端 (Express)
    │
    ├── pi TypeScript SDK
    │     ├── ask_user 扩展  ──► SSE 问题卡片
    │     └── 权限扩展       ──► read-only / workspace-write
    │
    └── Python 媒体 / 平台脚本
          （图像、视频、音频、登录、发布）
```

- **会话**：pi `SessionManager` 持久化到 `outputs/_pi/sessions/`，会话绑定在 `outputs/_pi/bindings/`。
- **问答**：`ask_user` 由 pi 扩展注册，通过 SSE `question` 事件桥接到前端问题卡片。
- **权限**：pi `tool_call` 扩展在工具执行前检查主机策略；拒绝即阻止执行。
- **模型**：支持 pi 自己的登录/模型配置，可在 Web 设置里直接维护 pi 的 `models.json`，也可把 `.env` 的 `EASEL_DIRECT_API_*` 注册为 pi provider `easel-direct`。
- **复杂媒体与平台操作**：保留为 Python 脚本，由 TypeScript 后端按需调用。

> 旧版非 pi 会话历史不会迁移。升级后新建的 pi 会话从干净状态开始。

## 快速开始

### 环境要求

- **Node.js >= 22.19**（pi SDK 要求）
- **npm**
- **Python >= 3.10**（媒体处理、浏览器登录与自动发布需要）
- FFmpeg 由对应技能按需安装；`setup.sh` / `setup.ps1` 会安装登录与发布所需的 Playwright Chromium

### 安装

macOS / Linux：

```bash
git clone https://github.com/ZJU-REAL/Easel.git
cd Easel
bash setup.sh
```

Windows PowerShell：

```powershell
git clone https://github.com/ZJU-REAL/Easel.git
cd Easel
powershell -ExecutionPolicy Bypass -File setup.ps1
```

安装脚本会：

1. 检查 Node.js 版本；
2. 安装后端与前端 npm 依赖；
3. 创建 `.venv`、安装 Python 媒体依赖，并安装与 Playwright 版本匹配的 Chromium；
4. 如果没有 `.env`，从 `.env.example` 创建；
5. 构建 TypeScript 后端和 React 前端。

可选参数：

```bash
bash setup.sh --check          # 只检查环境（含 Playwright Chromium）
bash setup.sh --skip-python    # 跳过 Python 依赖
bash setup.sh --skip-browser   # 跳过 Playwright Chromium 安装
bash setup.sh --skip-install   # 跳过依赖安装，直接构建
bash setup.sh --start          # 构建后启动 Web 服务
```

### 配置模型

推荐使用 pi 自己的登录：

```bash
pi
# 在 pi 中执行 /login，选择供应商并完成认证
```

也可以使用任意 OpenAI-compatible 服务：

```dotenv
EASEL_DIRECT_API_KEY=your-key
EASEL_DIRECT_API_BASE_URL=https://your-provider.example/v1
EASEL_DIRECT_API_MODEL=gpt-4.1
```

`EASEL_DIRECT_API_BASE_URL` 需要包含 `/v1` 这类 API 根路径，不要填完整的 `/chat/completions`。

也可以完全在 Web 里配置：打开「设置 → 模型配置 → 对话」，在「pi 供应商」里填写供应商 ID、Base URL、API 类型、API Key 和模型 ID。Easel 会按 pi 的原生格式写入 `~/.pi/agent/models.json`（设置 `EASEL_PI_AGENT_DIR` 时写入该目录），保存后下个对话回合即可选用，无需重启 Easel。`easel-direct` 仍由 `.env` 的 `EASEL_DIRECT_API_*` 管理，在页面上只读。

### 启动

```bash
npm start          # 等价于 node server/dist/index.js
# 或
.venv/bin/easel web   # 默认 127.0.0.1:7860（需先安装 Python 依赖）
```

打开 <http://127.0.0.1:7860>。默认只监听本机；如需局域网访问：

```bash
EASEL_HOST=0.0.0.0 EASEL_PORT=7860 npm start
```

## 主要功能

- **工作台**：热点、选题、排期、内容库和账号状态一屏总览。
- **对话**：pi SDK 流式输出、思考增量、工具活动、问题卡片、停止与断线重放。
- **画像**：从表单生成基线六维文件，再交给 pi 分析社媒链接并增强。
- **技能库**：114 个内置技能，覆盖选题、文案、图片、视频、音频、发布与复盘。
- **内容库**：统一归档图片、视频、音频与文档，支持预览、下载和删除保护。
- **账号**：小红书、抖音、快手、视频号、知乎、B站、公众号的登录与状态检查。
- **发布**：自动发布或人工审核包；人工模式只导出 ZIP，不接触平台登录态。
- **模型设置**：pi 模型选择、pi `models.json` 供应商管理、媒体通道 Key、连通性自测。

## CLI

```bash
easel chat [--persona NAME] [--session KEY] [--thinking]
easel skill <name> -i "输入" [--profile NAME]
easel doctor
easel ping
easel web [--host 127.0.0.1] [--port 7860]
```

`easel` 是一个很薄的 Python 启动器，实际执行的是 `server/dist/cli.js` 中的 Node/pi 逻辑。安装脚本会把它放进 `.venv/bin/easel`；Windows 为 `.venv\Scripts\easel.exe`。

## 媒体与发布配置

媒体通道可在 Web「设置 → 模型配置」中填写，也可以直接写 `.env`：

```dotenv
VIDEO_PROVIDER=agnes
AGNES_API_KEY=...
AGNES_MODEL=agnes-video-2.5-flash

MUSIC_PROVIDER=dashscope
DASHSCOPE_API_KEY=...

VOICE_PROVIDER=gemini
GEMINI_API_KEY=...
GEMINI_TTS_MODEL=gemini-2.5-flash-preview-tts
```

小米 MiMo TTS 使用 OpenAI 兼容的 `chat/completions` + `audio` 字段（不是 `/audio/speech`），Easel 已内置 `xiaomi-mimo` 适配器：

```dotenv
VOICE_PROVIDER=xiaomi-mimo
MIMO_API_KEY=...
MIMO_TTS_MODEL=mimo-v2.5-tts
MIMO_TTS_VOICE=冰糖          # 可选：mimo_default / 冰糖 / 茉莉 / 苏打 / 白桦 / Mia / Chloe / Milo / Dean
# MIMO_BASE_URL=https://api.xiaomimimo.com/v1
```

发布模式：

```dotenv
EASEL_PUBLISH_MODE=automated   # 允许后端调用平台脚本发布
EASEL_PUBLISH_MODE=manual      # 只允许人工审核后导出发布包
```

自动发布会真实操作平台。小红书等平台可能触发验证或风控；建议先使用人工模式审核内容，再决定是否自动发布。

## 目录

```text
server/                 TypeScript HTTP/SSE 后端
server/extensions/      pi 的 ask_user 与权限扩展
web/frontend/           React + Vite 前端
skills/builtin/         内置技能
skills/shared/          共享技能脚本与资源
agents/workspace/       pi 的工作区提示（AGENTS.md / SOUL.md）
profiles/               用户画像
outputs/                内容库、会话、日志、发布包
docs/                   架构、技能规范与已知问题
```

运行时数据：

```text
outputs/_pi/sessions/   pi 会话
outputs/_pi/bindings/   会话绑定
outputs/_pi/jobs/       每轮 JSONL 事件日志（用于断线重放）
outputs/_publish/       发布包与临时排版文件
```

## 开发

```bash
npm install
npm --prefix web/frontend install

npm run typecheck       # 后端 TypeScript 类型检查
npm run build:server    # 编译后端
npm run build:web       # 构建前端
npm run build           # 全部构建
npm run dev             # tsx watch 启动后端
npm --prefix web/frontend run lint
```

Python 脚本测试：

```bash
.venv/bin/python -m pytest
```

## 安全

- 服务默认绑定 `127.0.0.1`，不要在没有认证的情况下直接暴露到公网。
- 工具权限由 pi 扩展和主机策略共同限制；`read-only` 会阻止写文件与执行命令。
- `.env`、登录态、Cookies 和发布包不应提交到 Git；仓库的 `.gitignore` 已覆盖常见路径。
- 人工发布包不包含登录凭证；导出不等于上传或发布。
- 自动发布前应确认目标账号、平台规则和内容合规要求。

## 已知问题与文档

- [技能规范](docs/SKILL-SPEC.md)
- [提示词栈](docs/prompt-stack.md)
- [人工发布](docs/manual-publishing.md)
- [内容检查点](docs/artifact-checkpoints.md)
- [已知问题](docs/known-issues.md)

## License

[Apache-2.0](LICENSE)
