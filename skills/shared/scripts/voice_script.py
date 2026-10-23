"""口播稿标签工具：一套带标注的稿子，同时产出「合成用」和「字幕用」两版。

设计动机
--------
MiMo TTS 支持在 assistant 文本里内嵌音频标签（[停顿]/[语速加快]/[轻笑]…），
开头还可用 (风格) 指定整体调性。但标签绝不能进字幕，也不能干扰 ASR 对齐。

用法
----
  # 校验 + 拆分
  python voice_script.py split 口播稿_标注.txt -o assets/

  # 只校验
  python voice_script.py check 口播稿_标注.txt

  # 看标签统计
  python voice_script.py stats 口播稿_标注.txt

标注语法
--------
  行首 (风格 风格)      → 仅作用于紧跟的段落，整体调性
  [停顿] [语速加快] …   → 内嵌音频标签，就地生效
  # 开头的行            → 注释，不参与合成

输出
----
  <stem>.tts.txt   合成用（保留标签，去掉注释）
  <stem>.sub.txt   字幕用（剥离全部标签）
  <stem>.tags.json 标签清单，供核查
"""
import argparse
import json
import re
import sys
from collections import Counter
from pathlib import Path

# MiMo 文档给出的可用标签类别（自建白名单，防止写错标签被当正文朗读）
STYLE_TAGS = {
    "自然", "口语", "平静", "克制", "严肃", "轻松", "略带疲惫", "略带笑意",
    "低声", "干练", "深沉", "磁性", "醇厚", "慵懒", "疑惑", "欣慰", "无奈",
    "略带兴奋", "略带无奈", "略带惊讶", "略带得意", "克制地兴奋",
}
AUDIO_TAGS = {
    "停顿", "短停", "长停", "语速加快", "放慢语速", "重音", "轻声",
    "吸气", "深呼吸", "叹气", "长叹一口气", "喘息", "屏息",
    "轻笑", "笑", "苦笑", "冷笑", "清嗓子", "咳嗽",
    "提高音量", "压低声音", "拖长", "强调", "放慢", "加快",
}

TAG_RE = re.compile(r"[\[【]([^\]】]{1,12})[\]】]")
STYLE_RE = re.compile(r"^[（(]([^)）]{1,40})[)）]")


def load_lines(path: Path):
    lines = path.read_text(encoding="utf-8").splitlines()
    return [l for l in lines if not l.lstrip().startswith("#")]


def scan(lines):
    """返回 (style_tags, audio_tags, unknown)。"""
    styles, audios, unknown = [], [], []
    for ln in lines:
        m = STYLE_RE.match(ln.strip())
        if m:
            for t in re.split(r"[,\s，、]+", m.group(1)):
                t = t.strip()
                if t:
                    (styles if t in STYLE_TAGS else unknown).append(t)
        for t in TAG_RE.findall(ln):
            t = t.strip()
            (audios if t in AUDIO_TAGS else unknown).append(t)
    return styles, audios, unknown


def to_tts(lines):
    """合成文本：保留标签，去掉行首 (风格) 前的空白整理。"""
    out = []
    for ln in lines:
        s = ln.rstrip()
        if not s.strip():
            out.append("")
            continue
        out.append(s.strip())
    # 压缩多余空行
    txt = "\n\n".join(p for p in "\n".join(out).split("\n\n") if p.strip())
    return txt.strip() + "\n"


def to_sub(lines):
    """字幕文本：剥离 (风格) 与 [标签]，句子照原样保留标点。"""
    out = []
    for ln in lines:
        s = ln.strip()
        if not s:
            out.append("")
            continue
        s = STYLE_RE.sub("", s)
        s = TAG_RE.sub("", s)
        s = re.sub(r"\s{2,}", " ", s).strip()
        if s:
            out.append(s)
    return "\n".join(out).strip() + "\n"


def cmd_check(a):
    p = Path(a.script)
    lines = load_lines(p)
    styles, audios, unknown = scan(lines)
    ok = True
    if unknown:
        ok = False
        print(f"❌ 未知标签 {len(unknown)} 个：{sorted(set(unknown))}")
        print(f"   风格白名单：{sorted(STYLE_TAGS)}")
        print(f"   音频白名单：{sorted(AUDIO_TAGS)}")
    if not audios:
        print("⚠️  没有任何音频标签——活人感会打折，建议至少给关键转折加 [停顿]/[长叹一口气]")
    else:
        print(f"✅ 音频标签 {len(audios)} 个：{dict(Counter(audios))}")
    if styles:
        print(f"✅ 风格标签 {len(styles)} 个：{dict(Counter(styles))}")
    body = TAG_RE.sub("", STYLE_RE.sub("", "\n".join(lines)))
    chars = len(re.sub(r"\s", "", body))
    print(f"   正文 {chars} 字（不含标签）")
    return 0 if ok else 1


def cmd_stats(a):
    p = Path(a.script)
    lines = load_lines(p)
    styles, audios, _ = scan(lines)
    body = TAG_RE.sub("", STYLE_RE.sub("", "\n".join(lines)))
    chars = len(re.sub(r"\s", "", body))
    per = 100 * len(audios) / chars if chars else 0
    print(f"正文 {chars} 字 / 音频标签 {len(audios)} 个 → 每百字 {per:.1f} 个")
    print(f"风格标签 {len(styles)} 个：{dict(Counter(styles))}")
    print(f"音频标签 {dict(Counter(audios))}")
    print(f"粗估时长 {chars/4.2:.0f}s（4.2 字/秒，带标签会再慢 10-25%）")
    return 0


def cmd_split(a):
    p = Path(a.script)
    outdir = Path(a.out)
    outdir.mkdir(parents=True, exist_ok=True)
    lines = load_lines(p)
    styles, audios, unknown = scan(lines)
    if unknown:
        print(f"❌ 未知标签：{sorted(set(unknown))}", file=sys.stderr)
        return 1
    stem = p.stem
    tts_p = outdir / f"{stem}.tts.txt"
    sub_p = outdir / f"{stem}.sub.txt"
    tts_p.write_text(to_tts(lines), encoding="utf-8")
    sub_p.write_text(to_sub(lines), encoding="utf-8")
    (outdir / f"{stem}.tags.json").write_text(
        json.dumps({"style": styles, "audio": audios}, ensure_ascii=False, indent=1),
        encoding="utf-8")
    body = TAG_RE.sub("", STYLE_RE.sub("", "\n".join(lines)))
    chars = len(re.sub(r"\s", "", body))
    print(f"✅ {tts_p}  合成用（含 {len(audios)} 个标签）")
    print(f"✅ {sub_p}  字幕用（{chars} 字，已剥离全部标签）")
    return 0


def main():
    ap = argparse.ArgumentParser()
    sub = ap.add_subparsers(dest="cmd", required=True)
    for name, fn in (("check", cmd_check), ("stats", cmd_stats), ("split", cmd_split)):
        s = sub.add_parser(name)
        s.add_argument("script")
        if name == "split":
            s.add_argument("-o", "--out", required=True)
        s.set_defaults(func=fn)
    a = ap.parse_args()
    sys.exit(a.func(a))


if __name__ == "__main__":
    main()
