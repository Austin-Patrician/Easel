<p align="center">
  <img src="assets/readme/brand.png#gh-light-mode-only" width="640" alt="Easel">
  <img src="assets/readme/brand-dark.png#gh-dark-mode-only" width="640" alt="Easel">
</p>

<p align="center">
  <a href="README.md">简体中文</a> · <strong>English</strong>
</p>

<p align="center">
  Your private, continuously improving social content copilot<br>
  From an idea to discovery, planning, production, publishing, and review.
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

![Easel poster](assets/readme/poster.png)

## What is Easel?

Easel is an open-source content workspace for social media creators. It connects an agent, account profiles, content skills, and real media tools so the agent does not merely explain what to do — it produces and archives the content, and publishes it when asked.

Think of it as a content partner that remembers your positioning, audience, style, platform limits, and past performance. It follows five connected workflows: **discover** opportunities, **plan** topics and schedules, **produce** posts, audio, and video, **publish** platform-ready work, and **attribute** results back into the profile.

## Architecture: pi is the only agent kernel

Easel uses the [pi](https://github.com/earendil-works/pi) TypeScript SDK as its sole agent runtime. There is no other agent runtime or chat-only API fallback.

```text
React frontend
    │  HTTP / SSE
    ▼
TypeScript backend (Express)
    │
    ├── pi TypeScript SDK
    │     ├── ask_user extension  ──► SSE question cards
    │     └── permission extension ──► read-only / workspace-write
    │
    └── Python media / platform scripts
          (images, video, audio, login, publishing)
```

- **Sessions** are persisted by pi `SessionManager` under `outputs/_pi/sessions/`; bindings live in `outputs/_pi/bindings/`.
- **Questions**: the `ask_user` extension emits an SSE `question` event that the frontend renders as a card.
- **Permissions**: a pi `tool_call` extension checks host policy before every tool call and blocks denied calls.
- **Models**: use pi's own login/model configuration, or expose `.env` `EASEL_DIRECT_API_*` as the pi provider `easel-direct`.
- **Media and platform operations** stay in Python scripts and are invoked by the TypeScript backend.

> Histories from non-pi runtimes are not migrated. New pi sessions start clean after upgrading.

## Quick start

### Requirements

- **Node.js >= 22.19** (required by the pi SDK)
- **npm**
- **Python >= 3.10** (media processing, browser login, and automated publishing)
- FFmpeg and Playwright Chromium are installed or requested by the relevant skills on first use.

### Install

macOS / Linux:

```bash
git clone https://github.com/ZJU-REAL/Easel.git
cd Easel
bash setup.sh
```

Windows PowerShell:

```powershell
git clone https://github.com/ZJU-REAL/Easel.git
cd Easel
powershell -ExecutionPolicy Bypass -File setup.ps1
```

The installer checks Node.js, installs backend and frontend dependencies, creates `.venv` and installs Python media dependencies, creates `.env` from `.env.example` when missing, and builds the TypeScript backend and React frontend.

Options:

```bash
bash setup.sh --check          # check the environment only
bash setup.sh --skip-python    # skip Python dependencies
bash setup.sh --skip-install   # skip dependency installation, build only
bash setup.sh --start          # start the web server after building
```

### Configure a model

The recommended path is pi's own login:

```bash
pi
# run /login inside pi, choose a provider, and finish authentication
```

Or use any OpenAI-compatible endpoint:

```dotenv
EASEL_DIRECT_API_KEY=your-key
EASEL_DIRECT_API_BASE_URL=https://your-provider.example/v1
EASEL_DIRECT_API_MODEL=gpt-4.1
```

`EASEL_DIRECT_API_BASE_URL` should include the API root such as `/v1`, not the full `/chat/completions` URL.

### Run

```bash
npm start          # node server/dist/index.js
# or
.venv/bin/easel web   # defaults to 127.0.0.1:7860 (after Python deps are installed)
```

Open <http://127.0.0.1:7860>. To allow LAN access:

```bash
EASEL_HOST=0.0.0.0 EASEL_PORT=7860 npm start
```

## Features

- **Dashboard**: trends, topics, schedule, content library, and account status at a glance.
- **Chat**: pi SDK streaming, thinking deltas, tool activity, question cards, stop, and reconnect/replay.
- **Profiles**: baseline six-file profiles from a form, enhanced by pi after analyzing social links.
- **Skills**: 114 built-in skills for research, copywriting, images, video, audio, publishing, and review.
- **Content library**: preview, download, and deletion protection for images, video, audio, and documents.
- **Accounts**: login and status checks for Xiaohongshu, Douyin, Kuaishou, WeChat Channels, Zhihu, Bilibili, and WeChat Official Accounts.
- **Publishing**: automated publishing or a manual review ZIP that never touches platform credentials.
- **Model settings**: pi model selection, media credentials, and connectivity tests.

## CLI

```bash
easel chat [--persona NAME] [--session KEY] [--thinking]
easel skill <name> -i "input" [--profile NAME]
easel doctor
easel ping
easel web [--host 127.0.0.1] [--port 7860]
```

`easel` is a thin Python launcher; the real logic lives in `server/dist/cli.js` and runs on Node/pi. The installer places it at `.venv/bin/easel` (`.venv\Scripts\easel.exe` on Windows).

## Media and publishing

Configure media channels in **Settings → Models** or directly in `.env`:

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

Publishing mode:

```dotenv
EASEL_PUBLISH_MODE=automated   # allow the backend to publish through platform scripts
EASEL_PUBLISH_MODE=manual      # export a review ZIP only
```

Automated publishing performs real platform actions. Some platforms, especially Xiaohongshu, may require verification or trigger risk controls. Review content in manual mode first.

## Layout

```text
server/                 TypeScript HTTP/SSE backend
server/extensions/      pi ask_user and permission extensions
web/frontend/           React + Vite frontend
skills/builtin/         built-in skills
skills/shared/          shared skill scripts and assets
agents/workspace/       pi workspace prompts (AGENTS.md / SOUL.md)
profiles/               user profiles
outputs/                content library, sessions, logs, publish packages
docs/                   architecture, skill spec, and known issues
```

Runtime data:

```text
outputs/_pi/sessions/   pi sessions
outputs/_pi/bindings/   session bindings
outputs/_pi/jobs/       per-turn JSONL event logs for replay
outputs/_publish/       publish packages and temporary layout files
```

## Development

```bash
npm install
npm --prefix web/frontend install

npm run typecheck       # backend TypeScript checks
npm run build:server    # compile the backend
npm run build:web       # build the frontend
npm run build           # build everything
npm run dev             # tsx watch backend
npm --prefix web/frontend run lint
```

Python tests:

```bash
.venv/bin/python -m pytest
```

## Security

- The server binds to `127.0.0.1` by default. Do not expose it publicly without authentication.
- Tool permissions are enforced by the pi extension and host policy; `read-only` blocks writes and command execution.
- Never commit `.env`, login state, cookies, or publish packages. The repository `.gitignore` covers common paths.
- Manual publish packages never contain credentials. Exporting is not publishing.
- Confirm the target account, platform rules, and content compliance before automated publishing.

## Docs

- [Skill spec](docs/SKILL-SPEC.md)
- [Prompt stack](docs/prompt-stack.md)
- [Manual publishing](docs/manual-publishing.md)
- [Artifact checkpoints](docs/artifact-checkpoints.md)
- [Known issues](docs/known-issues_EN.md)

## License

[Apache-2.0](LICENSE)
