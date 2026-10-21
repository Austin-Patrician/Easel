"""Easel CLI — 社媒内容工作流整合层。

Agent 内核只有 pi（TypeScript SDK）。CLI 是 Node 后端的薄启动器：

    easel chat                     # 终端对话（pi SDK）
    easel doctor                   # 检查 pi / Node / 模型配置
    easel ping                     # 检查 pi 模型是否可用
    easel skill <name> -i "..."    # 运行 SKILL（pi SDK）
    easel web [--port 7860]        # 启动 Web 工作台（TypeScript + pi SDK）
"""

from __future__ import annotations

import argparse
import os
import shutil
import subprocess
import sys
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parents[1]
SERVER_ENTRY = PROJECT_ROOT / "server" / "dist" / "index.js"
CLI_ENTRY = PROJECT_ROOT / "server" / "dist" / "cli.js"

CYAN = "\033[0;36m"
GREEN = "\033[0;32m"
YELLOW = "\033[0;33m"
RED = "\033[0;31m"
DIM = "\033[0;90m"
NC = "\033[0m"


def _proxy_env() -> dict[str, str]:
    env = os.environ.copy()
    env.setdefault("EASEL_ROOT", str(PROJECT_ROOT))
    if os.environ.get("EASEL_PROXY"):
        env.setdefault("http_proxy", os.environ["EASEL_PROXY"])
        env.setdefault("https_proxy", os.environ["EASEL_PROXY"])
    env.setdefault(
        "no_proxy",
        "localhost,127.0.0.1,10.*,*.xiaohongshu.com,*.devops.xiaohongshu.com,"
        "*.douyin.com,*.kuaishou.com,*.zhihu.com,*.bilibili.com,*.weixin.qq.com,*.qq.com",
    )
    return env


def _node() -> str:
    node = shutil.which("node")
    if not node:
        print(f"{RED}未找到 Node.js{NC} — pi SDK 需要 Node >= 22.19，请安装后重试。", file=sys.stderr)
        raise SystemExit(1)
    return node


def _ensure_build() -> None:
    if not SERVER_ENTRY.is_file():
        print(
            f"{RED}未找到 {SERVER_ENTRY.relative_to(PROJECT_ROOT)}{NC}\n"
            f"请先运行：{CYAN}npm install && npm run build:server{NC}",
            file=sys.stderr,
        )
        raise SystemExit(1)


def _run_node(entry: Path, args: list[str]) -> int:
    _ensure_build()
    if not entry.is_file():
        print(f"{RED}未找到 {entry.relative_to(PROJECT_ROOT)}{NC}", file=sys.stderr)
        return 1
    result = subprocess.run(
        [_node(), str(entry), *args],
        cwd=str(PROJECT_ROOT),
        env=_proxy_env(),
    )
    return result.returncode


def cmd_chat(args: argparse.Namespace) -> int:
    argv = ["chat"]
    if getattr(args, "persona", None):
        argv += ["--persona", args.persona]
    if getattr(args, "session", None):
        argv += ["--session", args.session]
    if getattr(args, "thinking", False):
        argv += ["--thinking", "true"]
    return _run_node(CLI_ENTRY, argv)


def cmd_skill(args: argparse.Namespace) -> int:
    argv = ["skill", args.name, "--input", args.input]
    if getattr(args, "profile", None):
        argv += ["--persona", args.profile]
    return _run_node(CLI_ENTRY, argv)


def cmd_doctor(_args: argparse.Namespace) -> int:
    return _run_node(CLI_ENTRY, ["doctor"])


def cmd_ping(_args: argparse.Namespace) -> int:
    return _run_node(CLI_ENTRY, ["ping"])


def cmd_web(args: argparse.Namespace) -> int:
    _ensure_build()
    env = _proxy_env()
    env["EASEL_PORT"] = str(getattr(args, "port", 7860))
    env["EASEL_HOST"] = getattr(args, "host", "127.0.0.1")
    result = subprocess.run(
        [_node(), str(SERVER_ENTRY)],
        cwd=str(PROJECT_ROOT),
        env=env,
    )
    return result.returncode


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        prog="easel",
        description="Easel — 社媒内容工作流整合层 CLI（pi SDK）",
    )
    sub = parser.add_subparsers(dest="command", required=True)

    p_chat = sub.add_parser("chat", help="终端对话（pi SDK）")
    p_chat.add_argument("--persona", "-p", default=None, help="画像名称")
    p_chat.add_argument("--session", "-s", default=None, help="续接已有 pi 会话 key")
    p_chat.add_argument("--thinking", action="store_true", help="显示模型思考增量")
    p_chat.set_defaults(func=cmd_chat)

    p_doctor = sub.add_parser("doctor", help="检查 pi / Node / 模型配置")
    p_doctor.set_defaults(func=cmd_doctor)

    p_ping = sub.add_parser("ping", help="检查 pi 模型是否可用")
    p_ping.set_defaults(func=cmd_ping)

    p_skill = sub.add_parser("skill", help="运行 SKILL（pi SDK）")
    p_skill.add_argument("name", help="SKILL 名称")
    p_skill.add_argument("--input", "-i", required=True, help="输入内容")
    p_skill.add_argument("--profile", "-p", default=None, help="用户画像名称")
    p_skill.set_defaults(func=cmd_skill)

    p_web = sub.add_parser("web", help="启动 Web 工作台")
    p_web.add_argument("--port", type=int, default=7860, help="端口（默认 7860）")
    p_web.add_argument("--host", default="127.0.0.1", help="绑定地址（默认 127.0.0.1）")
    p_web.set_defaults(func=cmd_web)

    args = parser.parse_args(argv)
    return args.func(args)


if __name__ == "__main__":
    sys.exit(main())
