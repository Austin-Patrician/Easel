#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""云端语音转录 API（小米 MiMo / 硅基流动）→ transcript.json。

【Easel 内置改造 · 三级转录 tier2】
无字幕稿、又不想下 3GB 本地 whisper 时，调云端 ASR。默认按 .env 自动选择：
小米 MiMo（mimo-v2.5-asr）→ 硅基流动 XingChenGSR。

鉴权/配置全从环境变量或项目 .env 读（key 绝不写进代码/命令/仓库）:
  TRANSCRIBE_PROVIDER  可选，auto（默认）/ xiaomi-mimo / siliconflow / local
  MIMO_API_KEY         小米 MiMo 必需
  MIMO_BASE_URL        可选，默认 https://api.xiaomimimo.com/v1
  MIMO_ASR_MODEL       可选，默认 mimo-v2.5-asr
  SILICONFLOW_API_KEY  硅基流动必需
  SILICONFLOW_BASE_URL 可选，默认 https://api.siliconflow.cn/v1
  SILICONFLOW_ASR_MODEL 可选，默认 XingChenAGI/XingChenGSR-V1.0

用法:
  python transcribe_api.py --src voice.mp3 --out transcript.json [--lang zh] [--provider auto]

返回处理:
  - 响应含 segments（verbose_json）→ 直接用。
  - 只有纯 text（小米 MiMo）→ 按中文标点切句 + 按音频时长比例估时间轴
    （近似，transcript.json 里 approx_timeline=true）。
外网访问走系统代理（HTTPS_PROXY/HTTP_PROXY），与内网 MaaS 不同。
"""
from __future__ import annotations

import argparse
import base64
import json
import os
import re
import subprocess
import sys
import tempfile
import uuid
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

DEFAULT_XIAOMI_BASE = "https://api.xiaomimimo.com/v1"
DEFAULT_XIAOMI_MODEL = "mimo-v2.5-asr"
DEFAULT_SILICONFLOW_BASE = "https://api.siliconflow.cn/v1"
DEFAULT_SILICONFLOW_MODEL = "XingChenAGI/XingChenGSR-V1.0"
MAX_UPLOAD_B64 = 10 * 1024 * 1024

_ENV_CACHE: dict[str, str] | None = None


def load_env() -> dict[str, str]:
    """进程环境优先；否则从 EASEL_ROOT / 当前目录向上找 .env。"""
    global _ENV_CACHE
    if _ENV_CACHE is not None:
        return _ENV_CACHE
    values: dict[str, str] = {}
    candidates: list[Path] = []
    root = os.environ.get("EASEL_ROOT", "").strip()
    if root:
        candidates.append(Path(root))
    candidates.extend([Path.cwd(), *Path.cwd().parents])
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


def env(name: str, default: str = "") -> str:
    return str(load_env().get(name, "")).strip() or default


def resolve_provider(explicit: str = "") -> str:
    provider = (explicit or env("TRANSCRIBE_PROVIDER") or "auto").strip().lower()
    if provider in ("", "auto"):
        if env("MIMO_API_KEY") and env("MIMO_ASR_MODEL"):
            return "xiaomi-mimo"
        if env("SILICONFLOW_API_KEY"):
            return "siliconflow"
        return "local"
    if provider in ("whisper", "faster-whisper", "faster_whisper"):
        return "local"
    return provider


def audio_duration(path: str) -> float:
    try:
        out = subprocess.run(
            ["ffprobe", "-v", "error", "-show_entries", "format=duration",
             "-of", "default=nk=1:nw=1", path],
            capture_output=True, text=True, timeout=60).stdout.strip()
        return float(out)
    except (ValueError, OSError, subprocess.SubprocessError):
        return 0.0


def audio_for_upload(path: str, max_b64: int | None = MAX_UPLOAD_B64) -> tuple[str, bytes, str]:
    """返回 (mime, bytes, filename)。非 mp3/wav 或超过 max_b64 时用 ffmpeg 转 16k 单声道 mp3。"""
    src = Path(path)
    mime = {".mp3": "audio/mpeg", ".wav": "audio/wav"}.get(src.suffix.lower())
    size = src.stat().st_size
    if mime and (max_b64 is None or size * 4 / 3 <= max_b64):
        return mime, src.read_bytes(), src.name
    with tempfile.TemporaryDirectory(prefix="asr_api_") as d:
        out = Path(d) / "upload.mp3"
        try:
            proc = subprocess.run(
                ["ffmpeg", "-y", "-i", str(src), "-vn", "-ac", "1", "-ar", "16000",
                 "-b:a", "64k", "-f", "mp3", str(out)],
                capture_output=True, text=True)
        except OSError as exc:
            raise RuntimeError(f"未找到 ffmpeg，无法把音/视频转成可上传音频：{exc}") from exc
        if proc.returncode != 0 or not out.is_file():
            tail = "\n".join((proc.stderr or "").strip().splitlines()[-10:])
            raise RuntimeError(f"ffmpeg 提取/压缩音频失败：\n{tail}")
        data = out.read_bytes()
        if max_b64 is not None and len(data) * 4 / 3 > max_b64:
            raise RuntimeError("音频编码后 Base64 仍超过 10MB；请分段转写或改用本地 whisper。")
        return "audio/mpeg", data, "upload.mp3"


def build_multipart(fields: dict, file_field: str, filename: str,
                    file_bytes: bytes, content_type: str) -> tuple[bytes, str]:
    boundary = "----EaselASR" + uuid.uuid4().hex
    crlf = b"\r\n"
    buf = bytearray()
    for name, value in fields.items():
        buf += b"--" + boundary.encode() + crlf
        buf += f'Content-Disposition: form-data; name="{name}"'.encode() + crlf + crlf
        buf += str(value).encode() + crlf
    buf += b"--" + boundary.encode() + crlf
    buf += (f'Content-Disposition: form-data; name="{file_field}"; '
            f'filename="{filename}"').encode() + crlf
    buf += f"Content-Type: {content_type}".encode() + crlf + crlf
    buf += file_bytes + crlf
    buf += b"--" + boundary.encode() + b"--" + crlf
    return bytes(buf), boundary


def split_sentences(text: str) -> list[str]:
    parts = re.split(r"(?<=[。！？!?…\.])\s*", text.strip())
    return [p.strip() for p in parts if p.strip()]


def text_to_segments(text: str, duration: float) -> list[dict]:
    """无时间轴时：按句切分 + 按字数比例分配时长（近似）。"""
    sents = split_sentences(text) or ([text.strip()] if text.strip() else [])
    if not sents:
        return []
    total_chars = sum(len(s) for s in sents) or 1
    dur = duration if duration > 0 else max(3.0, total_chars / 4.0)
    segs, t = [], 0.0
    for s in sents:
        span = dur * (len(s) / total_chars)
        segs.append({"start": round(t, 3), "end": round(t + span, 3), "text": s,
                     "words": [{"word": s, "start": round(t, 3), "end": round(t + span, 3)}]})
        t += span
    return segs


def normalize_response(data: dict, text: str, duration: float) -> dict:
    """把 API 返回归一成 transcript.json（含 approx 标记）。"""
    segments = data.get("segments") if isinstance(data, dict) else None
    if isinstance(segments, list) and segments:
        norm, approx = [], False
        for s in segments:
            if not isinstance(s, dict):
                continue
            st, en = s.get("start"), s.get("end")
            body = str(s.get("text", "")).strip()
            if not body:
                continue
            if st is None or en is None:
                approx = True
                st, en = 0.0, 0.0
            norm.append({"start": round(float(st), 3), "end": round(float(en), 3), "text": body,
                         "words": [{"word": body, "start": round(float(st), 3),
                                    "end": round(float(en), 3)}]})
        if norm:
            return {"segments": norm, "approx_timeline": approx}
    return {"segments": text_to_segments(text, duration), "approx_timeline": True}


def chat_text(data: dict) -> str:
    choices = data.get("choices")
    if isinstance(choices, list) and choices:
        choice = choices[0] if isinstance(choices[0], dict) else {}
        message = choice.get("message")
        if isinstance(message, dict):
            for key in ("content", "text", "transcript"):
                content = message.get(key)
                if isinstance(content, str) and content.strip():
                    return content.strip()
                if isinstance(content, list):
                    parts = []
                    for item in content:
                        if isinstance(item, str):
                            parts.append(item)
                        elif isinstance(item, dict):
                            part = item.get("text")
                            if isinstance(part, str):
                                parts.append(part)
                    text = "".join(parts).strip()
                    if text:
                        return text
        text = str(choice.get("text") or "").strip()
        if text:
            return text
    for key in ("text", "transcript", "result"):
        text = str(data.get(key) or "").strip()
        if text:
            return text
    return ""


def post_json(url: str, payload: dict, headers: dict[str, str]) -> dict:
    req = Request(
        url,
        data=json.dumps(payload, ensure_ascii=False).encode("utf-8"),
        method="POST",
        headers={"Content-Type": "application/json", **headers},
    )
    try:
        with urlopen(req, timeout=600) as resp:
            raw = resp.read().decode("utf-8", errors="replace")
    except HTTPError as exc:
        detail = exc.read().decode("utf-8", errors="replace")[:1000]
        hint = "（账户余额不足）" if exc.code == 402 else (
            "（请检查 API Key）" if exc.code in (401, 403) else "")
        raise RuntimeError(f"HTTP {exc.code}{hint}: {detail}") from exc
    except (URLError, OSError) as exc:
        raise RuntimeError(f"网络错误：{exc}") from exc
    try:
        data = json.loads(raw)
    except ValueError as exc:
        raise RuntimeError(f"响应不是 JSON：{raw[:500]}") from exc
    if not isinstance(data, dict):
        raise RuntimeError(f"响应格式异常：{raw[:500]}")
    return data


def xiaomi_request(path: str, lang: str, model: str) -> dict:
    key = env("MIMO_API_KEY")
    if not key:
        raise RuntimeError("缺 MIMO_API_KEY（小米 MiMo ASR 需要）")
    base = env("MIMO_BASE_URL", DEFAULT_XIAOMI_BASE).rstrip("/")
    mime, raw, _ = audio_for_upload(path)
    language = lang if lang in ("auto", "zh", "en") else "auto"
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
    print(f"调用 {base}/chat/completions · provider=xiaomi-mimo · model={model} · {Path(path).name}",
          flush=True)
    return post_json(base + "/chat/completions", payload, {
        "Authorization": f"Bearer {key}",
        "api-key": key,
    })


def siliconflow_request(path: str, lang: str, model: str) -> dict:
    key = env("SILICONFLOW_API_KEY")
    if not key:
        raise RuntimeError("缺 SILICONFLOW_API_KEY（云端转录需要）")
    base = env("SILICONFLOW_BASE_URL", DEFAULT_SILICONFLOW_BASE).rstrip("/")
    mime, raw, filename = audio_for_upload(path, None)
    fields = {"model": model, "response_format": "verbose_json"}
    if lang and lang != "auto":
        fields["language"] = lang
    body, boundary = build_multipart(fields, "file", filename, raw, mime)
    req = Request(base + "/audio/transcriptions", data=body, method="POST", headers={
        "Authorization": f"Bearer {key}",
        "Content-Type": f"multipart/form-data; boundary={boundary}",
    })
    print(f"调用 {base}/audio/transcriptions · provider=siliconflow · model={model} · {Path(path).name}",
          flush=True)
    try:
        with urlopen(req, timeout=600) as resp:
            raw_text = resp.read().decode("utf-8", errors="replace")
    except HTTPError as exc:
        detail = exc.read().decode("utf-8", errors="replace")[:1000]
        hint = "（请检查 API Key）" if exc.code in (401, 403) else ""
        raise RuntimeError(f"HTTP {exc.code}{hint}: {detail}") from exc
    except (URLError, OSError) as exc:
        raise RuntimeError(f"网络错误：{exc}") from exc
    try:
        data = json.loads(raw_text)
    except ValueError:
        data = {"text": raw_text}
    if not isinstance(data, dict):
        raise RuntimeError(f"响应格式异常：{raw_text[:500]}")
    return data


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--src", required=True, help="音/视频源")
    ap.add_argument("--out", required=True, help="输出 transcript.json")
    ap.add_argument("--lang", default="zh")
    ap.add_argument("--provider", choices=["auto", "local", "xiaomi-mimo", "siliconflow"],
                    default="", help="默认读 .env 的 TRANSCRIBE_PROVIDER")
    ap.add_argument("--model", default="", help="默认按 provider 从 .env 取")
    args = ap.parse_args()

    load_env()
    provider = resolve_provider(args.provider)
    if provider == "local":
        print("transcribe_api.py 只负责云端 ASR；当前 provider=local，请改用 tools/transcribe.py。",
              file=sys.stderr)
        return 1
    if provider not in ("xiaomi-mimo", "siliconflow"):
        print(f"未知 ASR provider：{provider}", file=sys.stderr)
        return 1
    if not os.path.isfile(args.src):
        print(f"源不存在：{args.src}", file=sys.stderr)
        return 1

    if provider == "xiaomi-mimo":
        model = args.model.strip() or env("MIMO_ASR_MODEL", DEFAULT_XIAOMI_MODEL)
    else:
        model = args.model.strip() or env("SILICONFLOW_ASR_MODEL", DEFAULT_SILICONFLOW_MODEL)

    try:
        if provider == "xiaomi-mimo":
            data = xiaomi_request(args.src, args.lang, model)
            text, segments = chat_text(data), []
        else:
            data = siliconflow_request(args.src, args.lang, model)
            text = str(data.get("text") or "").strip()
            segments = data.get("segments") if isinstance(data.get("segments"), list) else []
    except RuntimeError as exc:
        print(f"ASR API 失败（{provider}）：{exc}", file=sys.stderr)
        return 1

    duration = audio_duration(args.src)
    norm = normalize_response({"segments": segments}, text, duration)
    if not norm["segments"]:
        raw = json.dumps(data, ensure_ascii=False)
        print(f"API 返回无可用文本：{raw[:300]}", file=sys.stderr)
        return 1

    result = {
        "language": args.lang,
        "duration": round(duration, 3),
        "source_kind": "asr-api",
        "asr_provider": provider,
        "source": os.path.abspath(args.src),
        "asr_model": model,
        "approx_timeline": norm["approx_timeline"],
        "segments": norm["segments"],
    }
    os.makedirs(os.path.dirname(os.path.abspath(args.out)) or ".", exist_ok=True)
    with open(args.out, "w", encoding="utf-8") as f:
        json.dump(result, f, ensure_ascii=False, indent=2)
    flag = "（时间轴为近似估算）" if norm["approx_timeline"] else ""
    print(f"DONE ASR {len(result['segments'])} 段 · {duration:.2f}s → {args.out} {flag}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
