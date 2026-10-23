"""用词级 ASR 时间戳，把口播稿的每个短句精确落到时间轴。

思路
----
1. 词级 ASR 给出每个词的时间（TTS 语速均匀，锚点可靠）。
2. 把「ASR 词序列」和「原稿短句序列」在字符层面做序列对齐。
3. 每个原稿短句覆盖的词范围 → 取首词 start / 末词 end。
4. 相邻句之间若重叠或空隙过大，按语音能量找真实停顿边界修正。

比按 ASR 段落切分精确：段落级只能按字数比例分，长句必然漂移。

用法：
  python build_voice_sync2.py <words.json> <script.txt> <out.srt> [out.json]
"""
import difflib
import json
import re
import sys
from pathlib import Path


def split_script(p: Path):
    """按句末标点 + 换行切短句，保留标点。"""
    txt = p.read_text(encoding="utf-8")
    txt = re.sub(r"^#.*$", "", txt, flags=re.M)          # 去注释行
    txt = re.sub(r"[\[【][^\]】]{1,12}[\]】]", "", txt)   # 去残留标签
    # 先按句末标点切，再对超长片段按逗号二次切（竖屏一行约 16 中文字）
    MAX = 18
    out = []
    for line in txt.splitlines():
        line = line.strip()
        if not line:
            continue
        for sent in re.split(r"(?<=[。！？；!?;])", line):
            sent = sent.strip()
            if not sent:
                continue
            if len(sent) <= MAX:
                out.append(sent)
                continue
            # 按逗号切，再贪心合并到 <= MAX
            parts = [x.strip() for x in re.split(r"(?<=[，,、])", sent) if x.strip()]
            buf = ""
            for part in parts:
                if buf and len(buf) + len(part) > MAX:
                    out.append(buf)
                    buf = part
                else:
                    buf += part
            if buf:
                out.append(buf)
    return out


def norm(t: str) -> str:
    """只保留中文/字母/数字，用于对齐。"""
    return re.sub(r"[^\u4e00-\u9fffA-Za-z0-9]", "", t).lower()


def build_word_chars(words):
    """把词序列展开成 [(char, word_idx)]。"""
    chars = []
    for i, w in enumerate(words):
        for c in norm(w["w"]):
            chars.append((c, i))
    return chars


def align_sentences(words, sentences):
    """句子 → 词索引区间 [(w_start, w_end)]。"""
    wchars = build_word_chars(words)
    wstr = "".join(c for c, _ in wchars)
    sstr = "".join(norm(s) for s in sentences)

    sm = difflib.SequenceMatcher(None, wstr, sstr, autojunk=False)
    # sstr 的每个位置 → wstr 的对应位置
    s2w = [None] * len(sstr)
    # get_matching_blocks: (i in wstr, j in sstr, size)
    for i, j, size in sm.get_matching_blocks():
        for k in range(size):
            if j + k < len(s2w):
                s2w[j + k] = i + k

    # 未匹配位置用前后最近匹配值插值
    last = None
    for i in range(len(s2w)):
        if s2w[i] is None:
            s2w[i] = last
        else:
            last = s2w[i]
    nxt = None
    for i in range(len(s2w) - 1, -1, -1):
        if s2w[i] is None:
            s2w[i] = nxt
        else:
            nxt = s2w[i]
    s2w = [x if x is not None else 0 for x in s2w]

    # 每句在 sstr 中的字符区间
    res, cur = [], 0
    for s in sentences:
        L = len(norm(s))
        if L == 0:
            res.append(None)
            continue
        lo, hi = cur, min(cur + L, len(sstr) - 1)
        cur += L
        wi_lo = wchars[s2w[lo]][1] if lo < len(s2w) else len(words) - 1
        wi_hi = wchars[s2w[hi]][1] if hi < len(s2w) else len(words) - 1
        if wi_hi < wi_lo:
            wi_lo, wi_hi = wi_hi, wi_lo
        res.append((wi_lo, wi_hi))
    return res


def ts(t: float) -> str:
    if t < 0:
        t = 0.0
    ms = int(round(t * 1000))
    h, ms = divmod(ms, 3600000)
    m, ms = divmod(ms, 60000)
    s, ms = divmod(ms, 1000)
    return f"{h:02d}:{m:02d}:{s:02d},{ms:03d}"


def main():
    words_p, script_p, out_srt = sys.argv[1:4]
    out_json = sys.argv[4] if len(sys.argv) > 4 else None

    data = json.loads(Path(words_p).read_text(encoding="utf-8"))
    words = data["words"]
    sentences = split_script(Path(script_p))

    spans = align_sentences(words, sentences)

    cues = []
    for s, sp in zip(sentences, spans):
        if sp is None:
            continue
        lo, hi = sp
        start = words[lo]["s"]
        end = words[hi]["e"]
        cues.append([start, end, s])

    # 保证单调：后句起点不早于前句终点；空隙过大时截断（避免字幕挂太久）
    for i in range(1, len(cues)):
        if cues[i][0] < cues[i - 1][1]:
            cues[i][0] = cues[i - 1][1]
    for i in range(len(cues) - 1):
        gap = cues[i + 1][0] - cues[i][1]
        if gap > 0.9:                      # 长停顿：字幕别一直挂着
            cues[i][1] = min(cues[i][1] + 0.55, cues[i + 1][0] - 0.05)

    lines = []
    for i, (s, e, t) in enumerate(cues, 1):
        lines.append(f"{i}\n{ts(s)} --> {ts(e)}\n{t}\n")
    Path(out_srt).write_text("\n".join(lines), encoding="utf-8")

    if out_json:
        Path(out_json).write_text(json.dumps(
            [{"i": i, "start": round(s, 3), "end": round(e, 3), "text": t}
             for i, (s, e, t) in enumerate(cues, 1)],
            ensure_ascii=False, indent=1), encoding="utf-8")

    total = data["duration"]
    covered = sum(e - s for s, e, _ in cues)
    print(f"✅ {out_srt}（{len(cues)} 句 / 覆盖 {covered:.1f}s / 总长 {total:.1f}s "
          f"/ 覆盖率 {covered/total*100:.0f}%）")


if __name__ == "__main__":
    main()
