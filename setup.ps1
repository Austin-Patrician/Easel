# Easel 安装脚本：Node.js + pi SDK + 前端 + Python 媒体工具。
# 用法：powershell -ExecutionPolicy Bypass -File setup.ps1 [-Check] [-SkipPython] [-SkipInstall] [-Start]
param(
    [switch]$Check,
    [switch]$SkipPython,
    [switch]$SkipInstall,
    [switch]$Start
)

$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $Root

function Write-Info([string]$Message) { Write-Host "[easel] $Message" -ForegroundColor Cyan }
function Write-Ok([string]$Message) { Write-Host "  OK $Message" -ForegroundColor Green }
function Write-Warn([string]$Message) { Write-Host "  !  $Message" -ForegroundColor Yellow }
function Stop-Install([string]$Message) { Write-Host "  X  $Message" -ForegroundColor Red; exit 1 }

function Invoke-Step([string]$Label, [scriptblock]$Command) {
    Write-Info $Label
    & $Command
    if ($LASTEXITCODE -ne 0) { Stop-Install "$Label 失败（退出码 $LASTEXITCODE）" }
    Write-Ok $Label
}

function Get-CommandPath([string]$Name) {
    $Command = Get-Command $Name -ErrorAction SilentlyContinue
    if (-not $Command) { return $null }
    return $Command.Source
}

$Node = Get-CommandPath 'node'
if (-not $Node) { Stop-Install '未找到 Node.js，请先安装 Node.js >= 22.19。' }
$npm = Get-CommandPath 'npm'
if (-not $npm) { Stop-Install '未找到 npm，请先安装 Node.js。' }

$NodeVersion = (& $Node -p 'process.versions.node').Trim()
& $Node -e 'const [a,b]=process.versions.node.split(".").map(Number); process.exit(a>22||(a===22&&b>=19)?0:1)'
if ($LASTEXITCODE -ne 0) { Stop-Install "Node.js >= 22.19 才满足 pi SDK 要求；当前是 $NodeVersion。" }
Write-Ok "Node.js $NodeVersion"

$Python = Get-CommandPath 'python'
if (-not $Python) { $Python = Get-CommandPath 'python3' }

if ($Check) {
    if ($Python) {
        $pythonVersion = (& $Python -c 'import sys; print(".".join(map(str, sys.version_info[:3])))').Trim()
        Write-Ok "Python $pythonVersion"
    } else {
        Write-Warn '未找到 python3；媒体处理、浏览器发布等 Python 技能将不可用'
    }
    if (Test-Path (Join-Path $Root '.env')) { Write-Ok '.env 已存在' } else { Write-Warn '.env 不存在' }
    if (Test-Path (Join-Path $Root 'node_modules')) { Write-Ok 'Node 依赖已安装' } else { Write-Warn 'Node 依赖未安装' }
    if (Test-Path (Join-Path $Root 'web\frontend\node_modules')) { Write-Ok '前端依赖已安装' } else { Write-Warn '前端依赖未安装' }
    if (Test-Path (Join-Path $Root '.venv\Scripts\python.exe')) { Write-Ok 'Python 虚拟环境已存在' } else { Write-Warn 'Python 虚拟环境未创建' }
    exit 0
}

if (-not $SkipInstall) {
    Invoke-Step '安装 Node 依赖' { & $npm ci --no-audit --no-fund }
    Invoke-Step '安装前端依赖' { & $npm --prefix web/frontend ci --no-audit --no-fund }

    if (-not $SkipPython) {
        if (-not $Python) { Stop-Install '未找到 python，请安装 Python >= 3.10，或使用 -SkipPython。' }
        $VenvPython = Join-Path $Root '.venv\Scripts\python.exe'
        if (-not (Test-Path $VenvPython)) {
            Invoke-Step '创建 Python 虚拟环境' { & $Python -m venv .venv }
        }
        Invoke-Step '升级 pip' { & $VenvPython -m pip install --upgrade pip --quiet }
        Invoke-Step '安装 Python 媒体 / 发布依赖' { & $VenvPython -m pip install -e . --quiet }
        Write-Ok 'Python 依赖安装完成'
    } else {
        Write-Warn '已跳过 Python 依赖；媒体和自动发布相关技能可能不可用'
    }
} else {
    Write-Warn '已跳过依赖安装'
}

$EnvFile = Join-Path $Root '.env'
if (-not (Test-Path $EnvFile)) {
    Copy-Item (Join-Path $Root '.env.example') $EnvFile
    Write-Ok '已从 .env.example 创建 .env'
}

Invoke-Step '构建 TypeScript 后端与前端' { & $npm run build }
Write-Ok '构建完成'

Write-Host ''
Write-Info 'Easel 已就绪。'
Write-Host '  启动 Web：npm start        （默认 http://127.0.0.1:7860）'
if (-not $SkipPython) {
    Write-Host '  Python CLI：.venv\Scripts\easel.exe doctor（或先激活 .venv）'
} else {
    Write-Host '  Python CLI：需要先创建 .venv 并安装依赖'
}
Write-Host '  模型认证：运行 pi 完成 /login，或在 .env 填写 EASEL_DIRECT_API_*'

if ($Start) { & $npm start }
