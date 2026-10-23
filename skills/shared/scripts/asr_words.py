"""词级 ASR：输出每个词的时间戳，供精确字幕对齐。

比段落级 SRT 精确得多——TTS 语速均匀，词级锚点能直接反推每句起止。

用法：
  python asr_words.py <audio> <out.json> [--model small] [--language zh]
"""
import argparse
import json
import sys
from pathlib import Path

import av

# 绕开 faster-whisper 与 PyAV 版本不兼容（av.open 不接受 metadata_errors）
_orig = av.open
def _patched(*a, **kw):
    kw.pop("metadata_errors", None)
    return _orig(*a, **kw)
av.open = _patched
import faster_whisper.audio as fa  # noqa: E402
fa.av.open = _patched

from faster_whisper import WhisperModel  # noqa: E402


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("audio")
    ap.add_argument("out")
    ap.add_argument("--model", default="small")
    ap.add_argument("--language", default="zh")
    a = ap.parse_args()

    ref = a.model
    if "/" not in a.model and not Path(a.model).exists():
        local = Path.home() / ".cache/easel-models" / f"faster-whisper-{a.model}"
        if (local / "model.bin").is_file():
            ref = str(local)
    print(f"[asr-words] 加载 {ref}", file=sys.stderr)
    m = WhisperModel(ref, device="cpu", compute_type="int8")
    segs, info = m.transcribe(
        a.audio, language=None if a.language in ("auto", "") else a.language,
        vad_filter=True, beam_size=5, word_timestamps=True,
    )
    words = []
    for s in segs:
        for w in (s.words or []):
            t = (w.word or "").strip()
            if t:
                words.append({"w": t, "s": round(w.start, 3), "e": round(w.end, 3)})
    Path(a.out).write_text(
        json.dumps({"duration": round(info.duration, 3), "words": words},
                   ensure_ascii=False, indent=0),
        encoding="utf-8")
    print(f"[asr-words] {len(words)} 词 / {info.duration:.1f}s → {a.out}", file=sys.stderr)


if __name__ == "__main__":
    main()
