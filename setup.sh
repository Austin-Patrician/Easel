#!/usr/bin/env bash
set -euo pipefail

# Easel 安装脚本：Node.js + pi SDK + 前端 + Python 媒体工具。
# 用法：bash setup.sh [--check] [--skip-python] [--skip-install] [--start]

PROJECT_ROOT="$(cd "$(dirname "$0")" && pwd)"
cd "$PROJECT_ROOT"

CHECK=0
SKIP_PYTHON=0
SKIP_INSTALL=0
START=0
for argument in "$@"; do
  case "$argument" in
    --check) CHECK=1 ;;
    --skip-python) SKIP_PYTHON=1 ;;
    --skip-install) SKIP_INSTALL=1 ;;
    --start) START=1 ;;
    -h|--help)
      cat <<'EOF'
用法：bash setup.sh [选项]

  --check         只检查环境，不安装、不构建
  --skip-python   不创建 Python 虚拟环境，也不安装媒体依赖
  --skip-install  跳过 npm / pip 安装，只做环境检查和构建
  --start         构建完成后启动 Web 服务
EOF
      exit 0
      ;;
    *) echo "未知参数：$argument（用 --help 查看用法）" >&2; exit 1 ;;
  esac
done

GREEN='\033[0;32m'; YELLOW='\033[0;33m'; CYAN='\033[0;36m'; RED='\033[0;31m'; NC='\033[0m'
info() { echo -e "${CYAN}[easel]${NC} $*"; }
ok()   { echo -e "${GREEN}  ✓${NC} $*"; }
warn() { echo -e "${YELLOW}  !${NC} $*"; }
die()  { echo -e "${RED}  ✗${NC} $*" >&2; exit 1; }

need() { command -v "$1" >/dev/null 2>&1 || die "未找到 $1，请先安装。"; }

need node
need npm
NODE_VERSION="$(node -p 'process.versions.node')"
node -e 'const [a,b]=process.versions.node.split(".").map(Number); process.exit(a>22||(a===22&&b>=19)?0:1)' \
  || die "Node.js >= 22.19 才满足 pi SDK 要求；当前是 $NODE_VERSION。"
ok "Node.js $NODE_VERSION"

if [ "$CHECK" = 1 ]; then
  if command -v python3 >/dev/null 2>&1; then
    ok "Python $(python3 -c 'import sys; print(".".join(map(str, sys.version_info[:3])))')"
  else
    warn "未找到 python3；媒体处理、浏览器发布等 Python 技能将不可用"
  fi
  [ -f .env ] && ok ".env 已存在" || warn ".env 不存在；运行不带 --check 的脚本会自动从 .env.example 创建"
  [ -d node_modules ] && ok "Node 依赖已安装" || warn "Node 依赖未安装"
  [ -d web/frontend/node_modules ] && ok "前端依赖已安装" || warn "前端依赖未安装"
  [ -x .venv/bin/python ] && ok "Python 虚拟环境已存在" || warn "Python 虚拟环境未创建"
  exit 0
fi

if [ "$SKIP_INSTALL" = 0 ]; then
  info "安装 Node 依赖…"
  npm ci --no-audit --no-fund
  npm --prefix web/frontend ci --no-audit --no-fund
  ok "Node 依赖安装完成"

  if [ "$SKIP_PYTHON" = 0 ]; then
    need python3
    if [ ! -x .venv/bin/python ]; then
      info "创建 Python 虚拟环境…"
      python3 -m venv .venv
    fi
    info "安装 Python 媒体 / 发布依赖（首次可能较慢）…"
    .venv/bin/python -m pip install --upgrade pip --quiet
    .venv/bin/python -m pip install -e . --quiet
    ok "Python 依赖安装完成"
  else
    warn "已跳过 Python 依赖；媒体和自动发布相关技能可能不可用"
  fi
else
  warn "已跳过依赖安装"
fi

if [ ! -f .env ]; then
  cp .env.example .env
  ok "已从 .env.example 创建 .env"
fi

info "构建 TypeScript 后端与前端…"
npm run build
ok "构建完成"

echo
info "Easel 已就绪。"
echo "  启动 Web：npm start        （默认 http://127.0.0.1:7860）"
if [ "$SKIP_PYTHON" = 0 ]; then
  echo "  Python CLI：.venv/bin/easel doctor（或先 source .venv/bin/activate）"
else
  echo "  Python CLI：需要先创建 .venv 并安装依赖"
fi
echo "  模型认证：运行 pi 完成 /login，或在 .env 填写 EASEL_DIRECT_API_*"

if [ "$START" = 1 ]; then
  exec npm start
fi
