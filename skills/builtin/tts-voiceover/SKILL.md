---
name: tts-voiceover
description: "文字转语音配音：把文案/脚本合成为 AI 语音口播、旁白、朗读音频。**配了 VOICE_PROVIDER 默认走闭源云 TTS（CosyVoice2 等，有情感、像真人），edge 仅无 key 时兜底**（edge 偏机械/AI 味）；同步输出分句 SRT 字幕、mp3/wav/m4a。合成后可与 BGM 混音或加到视频作旁白。当用户说“配音”“文字转语音”“TTS”“AI 配音”“口播语音”“旁白”“朗读”“把这段文字读出来”“生成语音”“语音合成”时使用。"
layer: produce
---

# 文字转语音配音（TTS Voiceover）

> **配置检查路径铁律**：先 `cd` 到运行时说明给出的 Easel 项目根，确认当前目录有 `.env` 和 `skills/shared/scripts/`。云 TTS 配置只能用项目根的 `skills/shared/scripts/model_registry.py configured --group voice --env-file .env` 和 `skills/shared/scripts/voice_clone.py check ... --env-file .env` 判断；不得在 workspace 跑共享脚本副本，也不得用 `env` / `printenv` 推断 Key/URL 缺失。

把文案 / 脚本合成为 AI 语音（口播、旁白、朗读）。共享脚本 `skills/shared/scripts/tts.py speak`：
**默认闭源优先**——配了 `.env` 的 `VOICE_PROVIDER`(+ VOICE_API_KEY) 就走闭源云 TTS（voice_clone，
有情感、像真人），**没 key 才退 edge**（AI 味、生硬，仅兜底）。
`--engine closed/edge` 可强制；闭源音色用 `--voice` 传 voice-id（如 `FunAudioLLM/CosyVoice2-0.5B:alex`），
旁白默认 alex，可用 `VOICE_NARRATOR_VOICE_ID` 覆盖。小米 MiMo 用 `MIMO_API_KEY` + `MIMO_TTS_VOICE`（默认 `mimo_default`），
还会把 `MIMO_STYLE_PROMPT` 作为导演指令传给模型；MiMo 按整段/语义块合成（不再逐句重新起调），
字幕仍按句比例估时。其它 provider 仍按句合成+拼接+分句 SRT。合成后语音可交 `audio_ops.py`/`video_ops.py` 混音或加到视频。

## 输入

| 字段 | 必填 | 说明 |
|------|------|------|
| text / file | 是 | 待配音的文本，或文本文件路径（长文本推荐 --file） |
| voice | 否 | 音色，默认 `zh-CN-XiaoxiaoNeural`（晓晓） |
| rate/volume/pitch | 否 | 语速 / 音量 / 音调微调 |
| output | 否 | 默认 `outputs/主题名/{name}.mp3` |

## 输出

- 配音音频文件（mp3，可选 wav/m4a），放入 `outputs/主题名/`
- 可选同步输出 SRT 字幕（`--subtitle`），供视频烧字幕用
- 打印实际执行的 edge-tts 命令 + 输出文件时长/大小/音色

## 前置：外网代理

edge-tts 调微软在线服务，**必须能访问外网**。内网环境先设代理：

```bash
export https_proxy=http://<代理host>:<端口> http_proxy=http://<代理host>:<端口>
```

脚本会自动读环境变量代理并透传给 edge-tts（也可用 `--proxy` 覆盖）。

## 执行步骤

脚本路径（相对项目根）：`skills/shared/scripts/tts.py`。每个子命令支持 `-h`。

### 0. 挑音色（可选）

```bash
python skills/shared/scripts/tts.py voices          # 常用中文音色 + 简介
python skills/shared/scripts/tts.py voices --all    # 拉全量 zh- 音色（需外网）
```

MiMo 音色：`mimo_default` / `冰糖` / `茉莉` / `苏打` / `白桦` / `Mia` / `Chloe` / `Milo` / `Dean`。
要压掉“播音腔/广告腔”，在 `.env` 配 `MIMO_STYLE_PROMPT`（自然语言描述角色、场景、停顿、重音），例如：

```bash
MIMO_STYLE_PROMPT=像同事在会议室白板前讲清楚一件事：结论先行，语速正常偏慢，判断句和数字前后留半拍，句尾自然落下，不要播音腔。
```

### 1. 合成配音 speak

```bash
# 最简：一句话 → mp3
python skills/shared/scripts/tts.py speak --text "欢迎来到本期内容" \
  -o outputs/主题名/intro.mp3

# 长文本从文件读 + 换音色 + 加速 10%
python skills/shared/scripts/tts.py speak --file script.txt \
  -o outputs/主题名/narration.mp3 --voice zh-CN-YunxiNeural --rate +10%

# 同步出 SRT 字幕（视频烧字幕用）
python skills/shared/scripts/tts.py speak --file script.txt \
  -o outputs/主题名/vo.mp3 --subtitle outputs/主题名/vo.srt

# 输出 wav（需 ffmpeg，便于后续无损处理）
python skills/shared/scripts/tts.py speak --text "……" \
  -o outputs/主题名/vo.wav --format wav
```

参数：`--rate +10%`（语速）、`--volume +20%`（音量）、`--pitch +2Hz`（音调）。

### 2. 后处理（可选，复用已有共享脚本）

配音出来后按需接下游脚本，无需在本 SKILL 重造能力：

```bash
# ① 音频文件内配音 + BGM 混音（配音 1.0 / BGM 0.3）→ 用 audio_mix.py
python skills/shared/scripts/audio_mix.py mix --voice vo.mp3 --bgm bgm.mp3 \
  --voice-volume 1.0 --bgm-volume 0.3 -o vo_bgm.mp3

# ② 配音音量归一化到社媒响度（-14 LUFS）
python skills/shared/scripts/audio_ops.py normalize vo.mp3 -o vo_norm.mp3

# ③ 把配音作为旁白加到视频
python skills/shared/scripts/video_ops.py bgm -i clip.mp4 -o clip_vo.mp4 \
  --music vo.mp3 --voice-volume 0.4 --music-volume 1.0 --music-loop-off
```


## 去 AI 味：标签化口播稿（MiMo 专用）

MiMo 文档给了两条控制通道，**只用自然语言指令会得到「每句同一个升降弧线」的 AI 腔**。
第二条通道是音频标签，必须内嵌在正文里才会生效。

### 诊断口径（先量再改）

| 指标 | 真人参考 | AI 味信号 |
|---|---|---|
| 句尾下降占比 | 40–50% | **>65% = 每句一条抛物线** |
| 句间停顿中位 | 150–300ms（同语流） | **>450ms = 像在等提示** |
| 句内音高 std | 2.5–4.0 半音 | <1.8 偏平 |
| 呼吸声 | 每 8–12 秒一次 | 完全没有 |

用 `librosa.pyin` 算基频轨迹、`librosa.effects.split` 算停顿，比主观听感可靠。

### 三层写法

**① 段落调性**：行首 `(风格)`，只作用于紧跟段落，不是每段都换。

```text
(自然 口语 略带兴奋)
这两天有个消息，我看了三遍才敢信。

(略带疲惫)
难的不是看不懂，[停顿]是猜。
```

**② 音频标签**：正文任意位置，就地生效，不会被朗读（已用 ASR 验证）。

| 类别 | 可用标签 |
|---|---|
| 停顿 | `[停顿]` `[短停]` `[长停]` |
| 语速 | `[语速加快]` `[放慢语速]` |
| 重音 | `[重音]` `[强调]` `[拖长]` |
| 呼吸 | `[吸气]` `[深呼吸]` `[叹气]` `[长叹一口气]` `[喘息]` |
| 笑 | `[轻笑]` `[笑]` `[苦笑]` `[冷笑]` |
| 音量 | `[提高音量]` `[压低声音]` `[轻声]` |
| 其他 | `[清嗓子]` `[咳嗽]` `[屏息]` |

**用量：每百字约 2 个。** 逐句堆标签会变成话剧腔，比 AI 腔更难听。
`[停顿]` 只加在判断句前和段落转折处；`[长叹一口气]` 每片限 1 次。

**③ 精简指令**：`MIMO_STYLE_PROMPT` 控制在 60 字内，只说「做什么」。
实测 200 字长指令（堆满「不要播音腔/不要广告腔」）会让模型过度表演，
时长从 177s 涨到 194s、停顿中位从 511ms 拉到 650ms。

```bash
MIMO_STYLE_PROMPT="你在跟同事讲一个技术判断。不是朗读，是说话。句尾自然落下，别每句都收成同一个弧线；列举时平推，转折处停一下，反问带点笑意。允许换气和不完美。"
```

### 脚本流程

```bash
# 1. 校验标签（写错的标签会被当正文念出来）
python skills/shared/scripts/voice_script.py check 口播稿_标注.txt
python skills/shared/scripts/voice_script.py stats 口播稿_标注.txt

# 2. 拆成「合成用」和「字幕用」两版（字幕必须剥离标签）
python skills/shared/scripts/voice_script.py split 口播稿_标注.txt -o assets/
#   → assets/口播稿_标注.tts.txt   保留标签，喂 TTS
#   → assets/口播稿_标注.sub.txt   剥离标签，喂字幕对齐

# 3. 合成（用 .tts.txt）
python skills/shared/scripts/tts.py speak --file assets/口播稿_标注.tts.txt \
  -o assets/voice.mp3 --engine closed --voice 苏打

# 4. 词级 ASR（段落级 SRT 不够用，逗号长句不拆会导致对齐失败）
python skills/shared/scripts/asr_words.py assets/voice.mp3 assets/words.json

# 5. 词级时间戳对齐到短句（覆盖率应达 100%）
python skills/shared/scripts/build_voice_sync2.py \
  assets/words.json assets/口播稿_标注.sub.txt assets/voice_sync.srt
```

**为什么必须词级对齐**：`tts.py` 自带的 SRT 按字数估时，长稿必然漂移；
段落级 ASR 只按句末标点切，逗号长句整块输出，动态规划映射会断（38 条 vs 84 句 → 0 条）。
词级时间戳 + 字符序列对齐能稳定到 100% 覆盖。

### 实测效果（746 字 / 177 秒样本）

| | 无标签 | 精简指令 + 标签 |
|---|---|---|
| 音高起伏 | 5.33 半音 | **6.79 半音（+27%）** |
| 时长 | 181.7s | 177.2s |
| 停顿中位 | 534ms | 511ms |

起伏提升是靠轮廓变化，不是靠拖时间——所以时长没有变长。

### 代价

- 标签让音频变长 10–25%（`[停顿]` 最占时间）
- 强口语改写（加「呢/啊/唉」）再加 28%，且和人设克制调性冲突，按需选用

## 常用中文音色

| 音色 | 特点 |
|------|------|
| `zh-CN-XiaoxiaoNeural` | 晓晓 · 女声，温暖亲和，通用首选（默认） |
| `zh-CN-XiaoyiNeural` | 晓伊 · 女声，活泼年轻，口播/种草 |
| `zh-CN-YunxiNeural` | 云希 · 男声，清朗自然，旁白/解说 |
| `zh-CN-YunyangNeural` | 云扬 · 男声，专业沉稳，新闻/播报 |
| `zh-CN-YunjianNeural` | 云健 · 男声，浑厚有力，激情内容 |

粤语用 `zh-HK-HiuMaanNeural`（曉曼），台式用 `zh-TW-HsiaoChenNeural`（曉臻）。

## 规则

1. **绝不覆盖原始素材** — 只写新文件到 `outputs/主题名/`。
2. **长文本走 --file** — 避免命令行过长 / 换行转义问题。
3. **先设代理** — edge-tts 需外网，网络失败脚本会给明确提示。
4. **不重造能力** — 混音/归一化/加视频旁白复用 audio_ops.py / video_ops.py。
5. **无 Profile 也能用** — 无画像时用默认音色晓晓。

## Profile 感知

有 Profile 时可读取账号偏好音色 / 语速 / 平台调性（如口播偏活泼晓伊、
知识类偏沉稳云扬）作为默认参数；无 Profile 退到通用默认（晓晓、正常语速）。
