#!/usr/bin/env python3
"""asr.py — 语音转字幕（ASR）的确定性封装（faster-whisper + 云端 API + 标准库）。

所有"语音/视频 → 字幕文件"类 SKILL（auto-subtitle 等）共用此脚本，避免每次
现场即兴调 whisper 导致的模型选择、时间戳格式、中文断句不一致等问题。

默认走本地 faster-whisper；配置了 TRANSCRIBE_PROVIDER 或对应 API Key 后也可走
小米 MiMo ASR（mimo-v2.5-asr）或 SiliconFlow，云端只返回整段文本时按语速估算
时间轴（JSON 里 approx_timeline=true）。

与 video_ops.py 的边界：本脚本只负责"识别语音 → 生成字幕文件（SRT/ASS/TXT/JSON）"，
不负责把字幕烧录进视频；烧录用 video_ops.py 或 ffmpeg subtitles/ass 滤镜。

依赖：faster-whisper（`pip install faster-whisper`）+ ffmpeg（视频提取音轨/大音频压缩）。
首次运行会从 HuggingFace 下载模型，需外网代理（见下方 _ensure_proxy）。

子命令（均支持 -h）：
    transcribe  音频/视频 → 字幕（--format srt/ass/txt/json）
    info        打印可用模型 / 语言提示

用法举例：
    asr.py transcribe -i talk.mp4 -o outputs/talk/talk.srt --language zh
    asr.py transcribe -i voice.mp3 --format ass --model small
    asr.py transcribe -i voice.mp3 --provider xiaomi-mimo --language zh
    asr.py info
    asr.py --selftest
"""
from __future__ import annotations

import argparse
import base64
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import uuid
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

# ── 常量 ──────────────────────────────────────────────────────────────
# 默认外网代理（faster-whisper 首次从 HuggingFace 下模型时用）。
# 环境里已设 https_proxy/http_proxy 则优先用环境变量，不覆盖。
_DEFAULT_PROXY = os.environ.get("EASEL_PROXY", "")  # lab 在 .env 设 EASEL_PROXY；不设则不走代理

_MODELS = ["tiny", "base", "small", "medium", "large-v3"]

_CLOUD_PROVIDERS = ("xiaomi-mimo", "siliconflow")

# 小米 MiMo ASR 限制：audio 的 base64 编码后不超过 10MB
_MAX_UPLOAD_B64 = 10 * 1024 * 1024

# 视频容器（需先用 ffmpeg 提取音轨）
_VIDEO_EXT = {".mp4", ".mkv", ".mov", ".avi", ".webm", ".flv", ".m4v", ".ts", ".wmv"}

# 中文断句标点（这些之后可以切）
_ZH_PUNCT = "，。！？；、：,.!?;:）】》」"
# 硬切标点（句末，优先在这里断）
_ZH_END_PUNCT = "。！？!?…"
_SENTENCE_BREAK = re.compile(r"(?<=[。！？!?；;…\.])\s*")

_ENV_CACHE: dict[str, str] | None = None


# ── 基础工具 ──────────────────────────────────────────────────────────
def _die(msg: str, code: int = 1) -> None:
    print(f"ERROR: {msg}", file=sys.stderr)
    sys.exit(code)


def _load_env() -> dict[str, str]:
    """读取项目 .env（进程环境变量优先），让脚本被 Agent 直接调用时也能拿到云端 key。"""
    global _ENV_CACHE
    if _ENV_CACHE is not None:
        return _ENV_CACHE
    values: dict[str, str] = {}
    candidates: list[Path] = []
    for base in (Path.cwd(), *Path.cwd().parents):
        if base not in candidates:
            candidates.append(base)
    for base in Path(__file__).resolve().parents:
        if base not in candidates:
            candidates.append(base)
    env_file = next((base / ".env" for base in candidates if (base / ".env").is_file()), None)
    if env_file is not None:
        try:
            for raw in env_file.read_text(encoding="utf-8-sig").splitlines():
                line = raw.strip()
                if not line or line.startswith("#") or "=" not in line:
                    continue
                key, value = line.split("=", 1)
                key = key.strip()
                if key.startswith("export "):
                    key = key[7:].strip()
                value = value.strip()
                if len(value) >= 2 and value[0] == value[-1] and value[0] in "\"'":
                    value = value[1:-1]
                if key:
                    values[key] = value
        except OSError:
            pass
    values.update(os.environ)
    _ENV_CACHE = values
    return values


def _env(name: str) -> str:
    return str(_load_env().get(name, "")).strip()


def _require_input(path: str) -> Path:
    p = Path(path).expanduser()
    if not p.is_file():
        _die(f"输入文件不存在: {p}", 2)
    return p


def _prep_out(path: str) -> Path:
    p = Path(path).expanduser().resolve()
    p.parent.mkdir(parents=True, exist_ok=True)
    return p


def _ensure_proxy() -> None:
    """若环境无代理，则注入默认代理（模型下载需外网）。已设则不动。"""
    has = any(os.environ.get(k) for k in
              ("https_proxy", "HTTPS_PROXY", "http_proxy", "HTTP_PROXY"))
    if not has and _DEFAULT_PROXY:
        os.environ["https_proxy"] = _DEFAULT_PROXY
        os.environ["http_proxy"] = _DEFAULT_PROXY
        print(f"[asr] 未检测到代理环境变量，已注入默认代理 {_DEFAULT_PROXY}（供模型下载）。\n"
              f"      如需自定义，请先 export https_proxy=... http_proxy=...",
              file=sys.stderr)


def _has_ffmpeg() -> bool:
    return shutil.which("ffmpeg") is not None


def _extract_audio(video: Path) -> Path:
    """从视频提取 16kHz 单声道 wav（whisper 友好），返回临时 wav 路径。"""
    if not _has_ffmpeg():
        _die("处理视频需要 ffmpeg 提取音轨，但未找到 ffmpeg。", 3)
    tmp = Path(tempfile.mkdtemp(prefix="asr_")) / "audio.wav"
    proc = subprocess.run(
        ["ffmpeg", "-y", "-i", str(video), "-vn",
         "-ac", "1", "-ar", "16000", "-f", "wav", str(tmp)],
        stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
    )
    if proc.returncode != 0 or not tmp.is_file():
        tail = "\n".join((proc.stderr or "").strip().splitlines()[-10:])
        _die(f"ffmpeg 提取音轨失败:\n{tail}", proc.returncode or 1)
    return tmp


# ── 云端 ASR ──────────────────────────────────────────────────────────
def _resolve_provider(explicit: str = "") -> str:
    provider = (explicit or _env("TRANSCRIBE_PROVIDER") or "auto").strip().lower()
    if provider in ("", "auto"):
        # 只有显式配置了 ASR 模型才自动选小米，避免把 TTS 的 MIMO_API_KEY 误当 ASR 授权
        if _env("MIMO_API_KEY") and _env("MIMO_ASR_MODEL"):
            provider = "xiaomi-mimo"
        elif _env("SILICONFLOW_API_KEY"):
            provider = "siliconflow"
        else:
            return "local"
    if provider in ("whisper", "faster-whisper", "faster_whisper"):
        return "local"
    if provider not in ("local", *_CLOUD_PROVIDERS):
        _die(f"未知 ASR provider: {provider}（可选 auto/local/xiaomi-mimo/siliconflow）", 2)
    if provider in _CLOUD_PROVIDERS:
        key_name = "MIMO_API_KEY" if provider == "xiaomi-mimo" else "SILICONFLOW_API_KEY"
        if not _env(key_name):
            print(f"[asr] {provider} 缺少 {key_name}，回退本地 whisper。", file=sys.stderr)
            return "local"
    return provider


def _cloud_model(a, env_name: str, default: str) -> str:
    requested = str(getattr(a, "model", "") or "").strip()
    if requested and requested not in _MODELS:
        return requested
    return _env(env_name) or default


def _audio_duration(path: Path) -> float:
    if path.suffix.lower() == ".wav":
        try:
            import wave
            with wave.open(str(path), "rb") as wav:
                rate = wav.getframerate()
                if rate:
                    return wav.getnframes() / rate
        except (OSError, EOFError, ValueError):
            pass
    if shutil.which("ffprobe"):
        proc = subprocess.run(
            ["ffprobe", "-v", "error", "-show_entries", "format=duration",
             "-of", "default=nk=1:nw=1", str(path)],
            capture_output=True, text=True, timeout=60,
        )
        try:
            return float(proc.stdout.strip().splitlines()[0])
        except (ValueError, IndexError):
            pass
    return 0.0


def _audio_for_upload(path: Path, max_b64: int | None = _MAX_UPLOAD_B64) -> tuple[str, bytes, str]:
    """返回 (mime, bytes, filename)。非 mp3/wav 或超过 max_b64 时用 ffmpeg 转 16k 单声道 mp3。"""
    mime = {".mp3": "audio/mpeg", ".wav": "audio/wav"}.get(path.suffix.lower())
    size = path.stat().st_size
    if mime and (max_b64 is None or size * 4 / 3 <= max_b64):
        return mime, path.read_bytes(), path.name
    if not _has_ffmpeg():
        _die("音频需要转码后才能上传（非 mp3/wav 或超过大小限制），但未找到 ffmpeg；"
             "请安装 ffmpeg 或改用 --provider local。", 3)
    with tempfile.TemporaryDirectory(prefix="asr_cloud_") as d:
        out = Path(d) / "upload.mp3"
        proc = subprocess.run(
            ["ffmpeg", "-y", "-i", str(path), "-vn", "-ac", "1", "-ar", "16000",
             "-b:a", "64k", "-f", "mp3", str(out)],
            stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
        )
        if proc.returncode != 0 or not out.is_file():
            tail = "\n".join((proc.stderr or "").strip().splitlines()[-10:])
            _die(f"ffmpeg 压缩音频失败:\n{tail}", proc.returncode or 1)
        data = out.read_bytes()
        if max_b64 is not None and len(data) * 4 / 3 > max_b64:
            _die("音频编码后 Base64 仍超过 10MB；请分段转写或改用 --provider local。", 2)
        return "audio/mpeg", data, "upload.mp3"


def _post_json(url: str, payload: dict, headers: dict[str, str],
               timeout: int = 600) -> dict:
    req = Request(
        url,
        data=json.dumps(payload, ensure_ascii=False).encode("utf-8"),
        method="POST",
        headers={"Content-Type": "application/json", **headers},
    )
    try:
        with urlopen(req, timeout=timeout) as resp:
            raw = resp.read().decode("utf-8", errors="replace")
    except HTTPError as exc:
        detail = exc.read().decode("utf-8", errors="replace")[:800]
        hint = ""
        if exc.code == 402:
            hint = "（账户余额不足）"
        elif exc.code in (401, 403):
            hint = "（请检查 API Key）"
        _die(f"{url} 请求失败 HTTP {exc.code}{hint}: {detail}", 5)
    except (URLError, OSError) as exc:
        _die(f"无法连接 {url}: {exc}", 5)
    try:
        data = json.loads(raw)
    except ValueError:
        _die(f"ASR 响应不是 JSON: {raw[:500]}", 5)
    if not isinstance(data, dict):
        _die(f"ASR 响应格式异常: {raw[:500]}", 5)
    return data


def _content_text(content: object) -> str:
    if isinstance(content, str):
        return content.strip()
    if isinstance(content, list):
        parts = []
        for item in content:
            if isinstance(item, str):
                parts.append(item)
            elif isinstance(item, dict):
                text = item.get("text")
                if isinstance(text, str):
                    parts.append(text)
        return "".join(parts).strip()
    return ""


def _chat_text(data: dict) -> str:
    choices = data.get("choices")
    if isinstance(choices, list) and choices:
        choice = choices[0] if isinstance(choices[0], dict) else {}
        message = choice.get("message")
        if isinstance(message, dict):
            for key in ("content", "text", "transcript"):
                text = _content_text(message.get(key))
                if text:
                    return text
        text = _content_text(choice.get("text"))
        if text:
            return text
    for key in ("text", "transcript", "result"):
        text = _content_text(data.get(key))
        if text:
            return text
    return ""


def _xiaomi_text(audio: Path, a) -> tuple[str, str, str]:
    key = _env("MIMO_API_KEY")
    if not key:
        _die("缺少 MIMO_API_KEY（小米 MiMo ASR）；请在设置页填写或改用 --provider local。", 3)
    base = (_env("MIMO_BASE_URL") or "https://api.xiaomimimo.com/v1").rstrip("/")
    model = _cloud_model(a, "MIMO_ASR_MODEL", "mimo-v2.5-asr")
    language = str(getattr(a, "language", "auto") or "auto").strip().lower()
    if language not in ("auto", "zh", "en"):
        language = "auto"
    mime, raw, _ = _audio_for_upload(audio)
    payload = {
        "model": model,
        "messages": [{
            "role": "user",
            "content": [{
                "type": "input_audio",
                "input_audio": {
                    "data": f"data:{mime};base64," + base64.b64encode(raw).decode("ascii"),
                },
            }],
        }],
        "asr_options": {"language": language},
    }
    print(f"[asr] 小米 MiMo ASR：{base}/chat/completions · model={model} · lang={language}",
          file=sys.stderr)
    data = _post_json(base + "/chat/completions", payload, {
        "Authorization": f"Bearer {key}",
        "api-key": key,
    })
    text = _chat_text(data)
    if not text:
        _die(f"小米 MiMo ASR 未返回文本: {json.dumps(data, ensure_ascii=False)[:500]}", 5)
    return text, model, language


def _siliconflow_text(audio: Path, a) -> tuple[str, list[dict], str, str]:
    key = _env("SILICONFLOW_API_KEY")
    if not key:
        _die("缺少 SILICONFLOW_API_KEY；请在设置页填写或改用 --provider local。", 3)
    base = (_env("SILICONFLOW_BASE_URL") or "https://api.siliconflow.cn/v1").rstrip("/")
    model = _cloud_model(a, "SILICONFLOW_ASR_MODEL", "SenseVoiceSmall")
    language = str(getattr(a, "language", "auto") or "auto").strip() or "auto"
    mime, raw, filename = _audio_for_upload(audio, None)

    boundary = "----EaselASR" + uuid.uuid4().hex
    crlf = b"\r\n"
    body = bytearray()
    fields = {"model": model, "response_format": "verbose_json"}
    if language != "auto":
        fields["language"] = language
    for name, value in fields.items():
        body += f"--{boundary}\r\n".encode()
        body += f'Content-Disposition: form-data; name="{name}"\r\n\r\n'.encode()
        body += f"{value}\r\n".encode()
    body += f"--{boundary}\r\n".encode()
    body += (f'Content-Disposition: form-data; name="file"; filename="{filename}"\r\n'
             f"Content-Type: {mime}\r\n\r\n").encode()
    body += raw + crlf
    body += f"--{boundary}--\r\n".encode()

    req = Request(base + "/audio/transcriptions", data=bytes(body), method="POST", headers={
        "Authorization": f"Bearer {key}",
        "Content-Type": f"multipart/form-data; boundary={boundary}",
    })
    print(f"[asr] SiliconFlow ASR：{base}/audio/transcriptions · model={model} · lang={language}",
          file=sys.stderr)
    try:
        with urlopen(req, timeout=600) as resp:
            raw_text = resp.read().decode("utf-8", errors="replace")
    except HTTPError as exc:
        detail = exc.read().decode("utf-8", errors="replace")[:800]
        hint = "（请检查 API Key）" if exc.code in (401, 403) else ""
        _die(f"SiliconFlow ASR 请求失败 HTTP {exc.code}{hint}: {detail}", 5)
    except (URLError, OSError) as exc:
        _die(f"无法连接 SiliconFlow ASR: {exc}", 5)
    try:
        data = json.loads(raw_text)
    except ValueError:
        data = {"text": raw_text}
    if not isinstance(data, dict):
        _die(f"SiliconFlow ASR 响应格式异常: {raw_text[:500]}", 5)
    text = str(data.get("text") or "").strip()
    segments = data.get("segments") if isinstance(data.get("segments"), list) else []
    if not text and not segments:
        _die(f"SiliconFlow ASR 未返回文本: {raw_text[:500]}", 5)
    return text, segments, model, language


def _text_to_cues(text: str, duration: float, max_chars: int) -> list[tuple[float, float, str]]:
    text = " ".join(text.split()).strip()
    if not text:
        return []
    if duration <= 0:
        duration = max(3.0, len(text) / 4.0)
    parts = [part.strip() for part in _SENTENCE_BREAK.split(text) if part.strip()] or [text]
    total = sum(len(part) for part in parts) or 1
    cues: list[tuple[float, float, str]] = []
    cursor = 0.0
    for part in parts:
        span = duration * (len(part) / total)
        start = cursor
        end = min(duration, cursor + span)
        cues.extend(_split_long_segment(part, start, max(end, start + 0.05), max_chars))
        cursor = end
    if cues:
        start, _, body = cues[-1]
        cues[-1] = (start, max(duration, start + 0.05), body)
    return cues


def _transcribe_cloud(audio: Path, a, provider: str) -> tuple[list[tuple[float, float, str]], dict]:
    duration = _audio_duration(audio)
    segments: list[dict] = []
    if provider == "xiaomi-mimo":
        text, model, language = _xiaomi_text(audio, a)
    else:
        text, segments, model, language = _siliconflow_text(audio, a)

    cues: list[tuple[float, float, str]] = []
    for seg in segments:
        body = str(seg.get("text") or "").strip()
        if not body:
            continue
        try:
            start = float(seg.get("start") or 0.0)
            end = float(seg.get("end") or start)
        except (TypeError, ValueError):
            start, end = 0.0, 0.0
        cues.extend(_split_long_segment(body, start, max(end, start + 0.05), a.max_line_chars))
    approx = not cues
    if not cues:
        cues = _text_to_cues(text, duration, a.max_line_chars)

    meta = {
        "source": str(audio),
        "provider": provider,
        "model": model,
        "language": language,
        "duration_sec": round(duration, 3) if duration else None,
        "num_segments": len(cues),
        "approx_timeline": approx,
    }
    return cues, meta


# ── 时间戳格式化 ──────────────────────────────────────────────────────
def _fmt_srt_ts(sec: float) -> str:
    """秒 → SRT 时间戳 HH:MM:SS,mmm"""
    if sec < 0:
        sec = 0.0
    ms = int(round(sec * 1000))
    h, ms = divmod(ms, 3600_000)
    m, ms = divmod(ms, 60_000)
    s, ms = divmod(ms, 1000)
    return f"{h:02d}:{m:02d}:{s:02d},{ms:03d}"


def _fmt_ass_ts(sec: float) -> str:
    """秒 → ASS 时间戳 H:MM:SS.cc（百分秒）"""
    if sec < 0:
        sec = 0.0
    cs = int(round(sec * 100))
    h, cs = divmod(cs, 360_000)
    m, cs = divmod(cs, 6000)
    s, cs = divmod(cs, 100)
    return f"{h:d}:{m:02d}:{s:02d}.{cs:02d}"


# ── 中文友好断行 ──────────────────────────────────────────────────────
def _wrap_line(text: str, max_chars: int) -> str:
    r"""把一行长文本按 max_chars 断成多行（\N 连接，供字幕换行）。
    优先在标点后断；无标点则按长度硬断。中文按字符数，英文单词尽量不拆。"""
    text = text.strip()
    if max_chars <= 0 or len(text) <= max_chars:
        return text
    lines: list[str] = []
    cur = ""
    for ch in text:
        cur += ch
        # 达到长度且落在标点后 → 断行；或严重超长（1.4x）强制断
        if len(cur) >= max_chars and (ch in _ZH_PUNCT or _is_ascii_space(ch)):
            lines.append(cur.strip())
            cur = ""
        elif len(cur) >= int(max_chars * 1.5):
            lines.append(cur.strip())
            cur = ""
    if cur.strip():
        lines.append(cur.strip())
    return "\\N".join(l for l in lines if l)


def _is_ascii_space(ch: str) -> bool:
    return ch == " "


def _split_long_segment(text: str, start: float, end: float,
                        max_chars: int) -> list[tuple[float, float, str]]:
    """一个 whisper segment 若过长（远超 max_chars），按句末标点切成多条字幕，
    时间按字符数比例分配。返回 [(start, end, text), ...]。"""
    text = text.strip()
    if not text:
        return []
    # 未超过 2 行的量级：不拆条，只在渲染时软换行
    if len(text) <= max_chars * 2:
        return [(start, end, text)]

    # 按句末标点切分成子句
    chunks: list[str] = []
    buf = ""
    for ch in text:
        buf += ch
        if ch in _ZH_END_PUNCT and len(buf.strip()) >= max(4, max_chars // 2):
            chunks.append(buf.strip())
            buf = ""
    if buf.strip():
        chunks.append(buf.strip())
    if len(chunks) <= 1:
        return [(start, end, text)]

    total = sum(len(c) for c in chunks) or 1
    out: list[tuple[float, float, str]] = []
    cursor = start
    span = max(end - start, 0.0)
    for c in chunks:
        seg = span * (len(c) / total)
        s, e = cursor, min(end, cursor + seg)
        out.append((s, e, c))
        cursor = e
    # 修正最后一条到 end
    if out:
        ls, _, lt = out[-1]
        out[-1] = (ls, end, lt)
    return out


# ── 渲染各格式 ────────────────────────────────────────────────────────
def _render_srt(cues: list[tuple[float, float, str]], max_chars: int) -> str:
    blocks = []
    for i, (s, e, t) in enumerate(cues, 1):
        body = _wrap_line(t, max_chars).replace("\\N", "\n")
        blocks.append(f"{i}\n{_fmt_srt_ts(s)} --> {_fmt_srt_ts(e)}\n{body}")
    return "\n\n".join(blocks) + "\n"


def _probe_video_wh(path: Path) -> tuple[int, int] | None:
    """探视频宽高（供字幕样式按横竖屏自适应）；无 ffprobe/非视频返回 None。"""
    if not shutil.which("ffprobe"):
        return None
    r = subprocess.run(["ffprobe", "-v", "error", "-select_streams", "v:0",
                        "-show_entries", "stream=width,height", "-of", "csv=p=0:s=x", str(path)],
                       capture_output=True, text=True)
    try:
        w, h = r.stdout.strip().splitlines()[0].split("x")
        return int(w), int(h)
    except Exception:
        return None


def _ass_header(w: int, h: int) -> str:
    """按目标视频宽高生成 ASS 头：PlayRes=真实宽高，**字号按短边**(min(w,h)*0.05)——
    竖屏(1080x1920)与横屏(1920x1080)都得到合适字号(≈54)，不再横屏过大/竖屏错位；
    底边距按高、左右边距按宽，描边/阴影按短边缩放。"""
    short = min(w, h)
    fs = max(16, round(short * 0.05))
    outline = max(1, round(short * 0.004))
    shadow = max(0, round(short * 0.0015))
    mv = round(h * 0.06)
    mlr = round(w * 0.045)
    return (
        "[Script Info]\nScriptType: v4.00+\n"
        f"PlayResX: {w}\nPlayResY: {h}\n"
        "WrapStyle: 0\nScaledBorderAndShadow: yes\n\n"
        "[V4+ Styles]\n"
        "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, "
        "Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, "
        "Shadow, Alignment, MarginL, MarginR, MarginV, Encoding\n"
        f"Style: Default,Noto Sans CJK SC,{fs},&H00FFFFFF,&H000000FF,&H00000000,&H80000000,"
        f"-1,0,0,0,100,100,0,0,1,{outline},{shadow},2,{mlr},{mlr},{mv},1\n\n"
        "[Events]\n"
        "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n"
    )


def _render_ass(cues: list[tuple[float, float, str]], max_chars: int,
                w: int = 1080, h: int = 1920) -> str:
    lines = [_ass_header(w, h)]
    for s, e, t in cues:
        body = _wrap_line(t, max_chars)  # ASS 用 \N 换行
        lines.append(
            f"Dialogue: 0,{_fmt_ass_ts(s)},{_fmt_ass_ts(e)},Default,,0,0,0,,{body}")
    return "\n".join(lines) + "\n"


def _render_txt(cues: list[tuple[float, float, str]]) -> str:
    return "\n".join(t for _, _, t in cues) + "\n"


def _render_json(cues: list[tuple[float, float, str]], meta: dict) -> str:
    data = {
        **meta,
        "segments": [
            {"index": i, "start": round(s, 3), "end": round(e, 3), "text": t}
            for i, (s, e, t) in enumerate(cues, 1)
        ],
    }
    return json.dumps(data, ensure_ascii=False, indent=2)


# ── 转录核心 ──────────────────────────────────────────────────────────
def _transcribe_audio(audio: Path, a) -> tuple[list[tuple[float, float, str]], dict]:
    try:
        from faster_whisper import WhisperModel
    except ImportError:
        _die("未安装 faster-whisper。请运行：pip install faster-whisper", 3)

    _ensure_proxy()
    # 模型解析：若传的是裸名（base/small…）且本地缓存目录已存在，优先用本地，
    # 规避某些代理下 huggingface_hub 自动下载失败的问题；否则交给 faster-whisper 自动下载。
    model_ref = a.model
    if "/" not in a.model and not Path(a.model).exists():
        local = Path.home() / ".cache" / "easel-models" / f"faster-whisper-{a.model}"
        if (local / "model.bin").is_file():
            model_ref = str(local)
            print(f"[asr] 使用本地缓存模型 {local}", file=sys.stderr)
    print(f"[asr] 加载模型 {model_ref}（device={a.device} compute={a.compute_type}）"
          f"，首次会下载，请耐心等待……", file=sys.stderr)
    try:
        model = WhisperModel(model_ref, device=a.device, compute_type=a.compute_type)
    except Exception as e:  # noqa: BLE001
        _die(f"加载模型失败（可能是模型下载失败/网络/代理问题）: {e}"
             f"\n提示：可手动下载模型到 ~/.cache/easel-models/faster-whisper-{a.model}/"
             f"（config.json/model.bin/tokenizer.json/vocabulary.txt）", 4)

    language = None if a.language in (None, "", "auto") else a.language
    segments, tinfo = model.transcribe(
        str(audio),
        language=language,
        vad_filter=True,
        beam_size=a.beam_size,
    )
    detected = getattr(tinfo, "language", None)
    duration = getattr(tinfo, "duration", None)
    print(f"[asr] 检测语言={detected} 时长={duration}s，开始转录……", file=sys.stderr)

    cues: list[tuple[float, float, str]] = []
    for seg in segments:
        text = (seg.text or "").strip()
        if not text:
            continue
        for s, e, t in _split_long_segment(text, seg.start, seg.end, a.max_line_chars):
            cues.append((s, e, t))

    meta = {
        "source": str(audio),
        "provider": "local",
        "model": a.model,
        "language": detected,
        "duration_sec": round(duration, 3) if duration else None,
        "num_segments": len(cues),
        "approx_timeline": False,
    }
    return cues, meta


def cmd_transcribe(a) -> int:
    src = _require_input(a.input)
    is_video = src.suffix.lower() in _VIDEO_EXT
    tmp_audio: Path | None = None
    try:
        audio = src
        if is_video:
            print(f"[asr] 视频输入，先提取音轨……", file=sys.stderr)
            tmp_audio = _extract_audio(src)
            audio = tmp_audio

        provider = _resolve_provider(getattr(a, "provider", ""))
        cues, meta = (_transcribe_audio(audio, a) if provider == "local"
                      else _transcribe_cloud(audio, a, provider))
        if not cues:
            print("[asr] 警告：未识别到任何语音内容（可能是静音或纯音乐）。",
                  file=sys.stderr)

        fmt = a.format
        if fmt == "srt":
            content = _render_srt(cues, a.max_line_chars)
        elif fmt == "ass":
            # 字幕样式按目标视频宽高自适应（横竖屏都合适）：--res 优先 > 视频输入探测 > 默认竖屏
            wh = None
            if getattr(a, "res", None):
                try:
                    ww, hh = str(a.res).lower().split("x")
                    wh = (int(ww), int(hh))
                except Exception:
                    _die("--res 格式应为 宽x高，如 1080x1920 或 1920x1080", 2)
            elif is_video:
                wh = _probe_video_wh(src)
            w, h = wh if wh else (1080, 1920)
            if not wh:
                print("[asr] 未探到目标视频尺寸，ASS 按竖屏 1080x1920 生成；横屏请加 --res 1920x1080。",
                      file=sys.stderr)
            content = _render_ass(cues, a.max_line_chars, w, h)
        elif fmt == "txt":
            content = _render_txt(cues)
        else:  # json
            content = _render_json(cues, meta)

        # 输出路径
        if a.output:
            out = _prep_out(a.output)
        else:
            out = _prep_out(f"outputs/{src.stem}/{src.stem}.{fmt}")
        out.write_text(content, encoding="utf-8")
        kb = out.stat().st_size / 1024
        print(f"[asr] 完成：{out} ({kb:.1f} KB, {len(cues)} 条字幕, 语言={meta['language']})")
        return 0
    finally:
        if tmp_audio is not None:
            shutil.rmtree(tmp_audio.parent, ignore_errors=True)


def cmd_info(a) -> int:
    print("可用模型（--model，越大越准越慢，CPU 建议 base/small）：")
    for m in _MODELS:
        tag = "（默认）" if m == "base" else ""
        print(f"  - {m}{tag}")
    print("\n云端 ASR（--provider）：")
    print("  - auto          按 .env 自动选择（小米 MiMo → SiliconFlow → 本地）")
    print("  - xiaomi-mimo   小米 MiMo ASR（MIMO_API_KEY / MIMO_ASR_MODEL）")
    print("  - siliconflow   SiliconFlow（SILICONFLOW_API_KEY / SILICONFLOW_ASR_MODEL）")
    print("  - local         faster-whisper（默认）")
    print(f"  当前：{_resolve_provider(getattr(a, 'provider', ''))}")
    print("\n语言（--language）：")
    print("  - auto  自动检测（默认）")
    print("  - zh    中文 / en 英文 / ja 日文 / ko 韩文 ...（ISO 639-1 码）")
    print("\n输出格式（--format）：srt（默认）/ ass / txt / json")
    print("\nCPU 友好参数：--device cpu --compute-type int8")
    print("每行字数：--max-line-chars（中文默认 18，超长自动断行/拆条）")
    print("\n模型下载走 HuggingFace，需外网代理；脚本会自动注入默认代理，")
    print("也可先 export https_proxy=... http_proxy=... 覆盖。")
    return 0


# ── selftest ─────────────────────────────────────────────────────────
def _selftest() -> int:
    """用 edge-tts 合成一句中文语音，再 transcribe 出 srt，断言非空含时间戳。"""
    if shutil.which("edge-tts") is None:
        print("[FAIL] 未找到 edge-tts，无法自检（pip install edge-tts）", file=sys.stderr)
        return 1
    if not _has_ffmpeg():
        print("[WARN] 未找到 ffmpeg，仅在纯音频路径下自检", file=sys.stderr)

    with tempfile.TemporaryDirectory() as d:
        mp3 = Path(d) / "asr_test.mp3"
        print("[selftest] edge-tts 合成测试语音……")
        proc = subprocess.run(
            ["edge-tts", "--voice", "zh-CN-XiaoxiaoNeural",
             "--text", "这是一段字幕测试", "--write-media", str(mp3)],
            stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
        )
        if proc.returncode != 0 or not mp3.is_file() or mp3.stat().st_size == 0:
            tail = "\n".join((proc.stderr or "").strip().splitlines()[-8:])
            print(f"[FAIL] edge-tts 合成失败:\n{tail}", file=sys.stderr)
            return 1

        srt = Path(d) / "asr_test.srt"
        ns = argparse.Namespace(
            input=str(mp3), output=str(srt), format="srt",
            model="base", language="zh", device="cpu", compute_type="int8",
            max_line_chars=18, beam_size=5, provider="local",
        )
        print("[selftest] transcribe → srt……")
        rc = cmd_transcribe(ns)
        if rc != 0:
            print("[FAIL] transcribe 返回非 0", file=sys.stderr)
            return 1
        text = srt.read_text(encoding="utf-8") if srt.is_file() else ""
        has_ts = "-->" in text and text.strip() != ""
        print("---- SRT 内容 ----")
        print(text.strip() or "(空)")
        print("------------------")
        if has_ts:
            print("[PASS] asr 自检通过（srt 非空且含时间戳）")
            return 0
        print("[FAIL] srt 为空或缺时间戳", file=sys.stderr)
        return 1


# ── argparse ─────────────────────────────────────────────────────────
def _add_transcribe_args(p) -> None:
    p.add_argument("-i", "--input", required=True, help="音频或视频文件路径")
    p.add_argument("-o", "--output",
                   help="输出路径（默认 outputs/<输入文件名>/<输入文件名>.<format>）")
    p.add_argument("--format", choices=["srt", "ass", "txt", "json"],
                   default="srt", help="输出格式（默认 srt）")
    p.add_argument("--model", default="base",
                   help=f"本地模型 {'/'.join(_MODELS)}（默认 base）；云端可填 MiMo/SiliconFlow 模型名")
    p.add_argument("--provider", choices=["auto", "local", "xiaomi-mimo", "siliconflow"],
                   default="", help="ASR 通道（默认读 .env 的 TRANSCRIBE_PROVIDER，否则 auto）")
    p.add_argument("--language", default="auto",
                   help="语言码如 zh/en，默认 auto 自动检测")
    p.add_argument("--device", default="cpu", help="cpu / cuda（默认 cpu）")
    p.add_argument("--compute-type", default="int8",
                   help="int8 / float16 / float32（CPU 建议 int8）")
    p.add_argument("--res", help="ASS 字幕目标视频宽高（宽x高，如 1080x1920/1920x1080）；"
                   "缺省时视频输入自动探测、纯音频按竖屏 1080x1920。字号/边距按此自适应")
    p.add_argument("--max-line-chars", type=int, default=18,
                   help="字幕每行字数，超长自动断行（中文默认 18）")
    p.add_argument("--beam-size", type=int, default=5, help="beam search 宽度（默认 5）")


def build_parser() -> argparse.ArgumentParser:
    ap = argparse.ArgumentParser(
        description="语音转字幕 ASR（faster-whisper 封装）。子命令均支持 -h。",
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    ap.add_argument("--selftest", action="store_true",
                    help="用 edge-tts 合成中文语音并转录，验证链路")
    sub = ap.add_subparsers(dest="cmd", metavar="<子命令>")

    p = sub.add_parser("transcribe", help="音频/视频 → 字幕文件")
    _add_transcribe_args(p)
    p.set_defaults(func=cmd_transcribe)

    p = sub.add_parser("info", help="打印可用模型 / 语言提示")
    p.set_defaults(func=cmd_info)

    return ap


def main() -> int:
    ap = build_parser()
    args = ap.parse_args()
    if args.selftest:
        return _selftest()
    if not getattr(args, "cmd", None):
        ap.print_help()
        return 1
    return args.func(args)


if __name__ == "__main__":
    sys.exit(main())
