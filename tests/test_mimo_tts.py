from __future__ import annotations

import base64
import os
import sys
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
SCRIPTS = ROOT / "skills" / "shared" / "scripts"
sys.path.insert(0, str(SCRIPTS))

import tts  # noqa: E402
import voice_clone  # noqa: E402


class MimoInstructionTests(unittest.TestCase):
    def test_style_emotion_and_speed_are_injected(self) -> None:
        with patch.dict(os.environ, {"MIMO_STYLE_PROMPT": "像同事在白板前讲清楚一件事"}):
            instruction = voice_clone.mimo_instruction("疑惑", 1.1)
        self.assertIn("像同事在白板前讲清楚一件事", instruction)
        self.assertIn("「疑惑」", instruction)
        self.assertIn("快10%", instruction)

    def test_no_style_keeps_emotion_only(self) -> None:
        with patch.dict(os.environ, {}, clear=True):
            instruction = voice_clone.mimo_instruction("冷静", 1.0)
        self.assertEqual(instruction, "这一句的情绪是「冷静」，按这个情绪演，但不要夸张。")

    def test_explicit_style_overrides_env(self) -> None:
        with patch.dict(os.environ, {"MIMO_STYLE_PROMPT": "env-style"}):
            instruction = voice_clone.mimo_instruction(None, 1.0, style="profile-style")
        self.assertIn("profile-style", instruction)
        self.assertNotIn("env-style", instruction)

    def test_clone_xiaomi_puts_style_in_user_message(self) -> None:
        captured: dict[str, object] = {}

        def fake_http_json(url, headers, payload, timeout=180):
            captured["url"] = url
            captured["payload"] = payload
            data = base64.b64encode(b"ID3-test").decode()
            return {"choices": [{"message": {"audio": {"data": data}}}]}

        args = SimpleNamespace(
            text="测试文本",
            voice_id="冰糖",
            emotion="冷静",
            speed=1.0,
            model="mimo-v2.5-tts",
            sample=None,
        )
        with patch.dict(
            os.environ,
            {"MIMO_API_KEY": "test-key", "MIMO_STYLE_PROMPT": "像同事在白板前讲清楚一件事"},
        ), patch.object(voice_clone, "http_json", fake_http_json), patch.object(
            voice_clone, "_save_bytes", lambda raw, out: out
        ):
            out = Path("unused.mp3")
            voice_clone.clone_xiaomi(args, out)

        payload = captured["payload"]
        messages = payload["messages"]
        self.assertEqual(messages[0]["role"], "user")
        self.assertIn("像同事在白板前讲清楚一件事", messages[0]["content"])
        self.assertIn("「冷静」", messages[0]["content"])
        self.assertEqual(messages[1], {"role": "assistant", "content": "测试文本"})
        self.assertEqual(payload["audio"]["voice"], "冰糖")
        self.assertEqual(payload["model"], "mimo-v2.5-tts")


class MimoProfileTests(unittest.TestCase):
    def test_profile_uses_reference_and_default_style(self) -> None:
        captured: dict[str, object] = {}

        def fake_http_json(url, headers, payload, timeout=180):
            captured["payload"] = payload
            data = base64.b64encode(b"ID3-test").decode()
            return {"choices": [{"message": {"audio": {"data": data}}}]}

        with tempfile.TemporaryDirectory() as td:
            profile = Path(td) / "tech-male"
            profile.mkdir()
            (profile / "reference.mp3").write_bytes(b"ID3-reference")
            (profile / "voice.json").write_text(
                """
                {
                  "model": "mimo-v2.5-tts-voiceclone",
                  "design_prompt": "清亮男声",
                  "reference": "reference.mp3",
                  "default_style": "像同事聊天"
                }
                """,
                encoding="utf-8",
            )
            args = SimpleNamespace(
                text="测试文本",
                voice_id=None,
                emotion=None,
                speed=1.0,
                model=None,
                sample=None,
                voice_profile=str(profile),
            )
            with patch.dict(
                os.environ,
                {"MIMO_API_KEY": "test-key", "MIMO_STYLE_PROMPT": ""},
            ), patch.object(voice_clone, "http_json", fake_http_json), patch.object(
                voice_clone, "_save_bytes", lambda raw, out: out
            ):
                voice_clone.clone_xiaomi(args, Path("unused.mp3"))

        payload = captured["payload"]
        self.assertEqual(payload["model"], "mimo-v2.5-tts-voiceclone")
        self.assertTrue(payload["audio"]["voice"].startswith("data:audio/mpeg;base64,"))
        self.assertIn("像同事聊天", payload["messages"][0]["content"])

    def test_profile_style_arg_overrides_default_style(self) -> None:
        captured: dict[str, object] = {}

        def fake_http_json(url, headers, payload, timeout=180):
            captured["payload"] = payload
            data = base64.b64encode(b"ID3-test").decode()
            return {"choices": [{"message": {"audio": {"data": data}}}]}

        with tempfile.TemporaryDirectory() as td:
            profile = Path(td) / "tech-male"
            profile.mkdir()
            (profile / "reference.mp3").write_bytes(b"ID3-reference")
            (profile / "voice.json").write_text(
                """
                {
                  "model": "mimo-v2.5-tts-voiceclone",
                  "design_prompt": "清亮男声",
                  "reference": "reference.mp3",
                  "default_style": "像同事聊天"
                }
                """,
                encoding="utf-8",
            )
            args = SimpleNamespace(
                text="测试文本",
                voice_id=None,
                emotion=None,
                speed=1.0,
                model=None,
                sample=None,
                voice_profile=str(profile),
                style="冷静拆解",
            )
            with patch.dict(
                os.environ,
                {"MIMO_API_KEY": "test-key", "MIMO_STYLE_PROMPT": ""},
            ), patch.object(voice_clone, "http_json", fake_http_json), patch.object(
                voice_clone, "_save_bytes", lambda raw, out: out
            ):
                voice_clone.clone_xiaomi(args, Path("unused.mp3"))

        content = captured["payload"]["messages"][0]["content"]
        self.assertIn("冷静拆解", content)
        self.assertNotIn("像同事聊天", content)


class MimoChunkTests(unittest.TestCase):
    def test_rate_parsing(self) -> None:
        self.assertAlmostEqual(tts._rate_to_speed("+10%"), 1.1)
        self.assertAlmostEqual(tts._rate_to_speed("-10%"), 0.9)
        self.assertEqual(tts._rate_to_speed("fast"), 1.0)
        self.assertEqual(tts._rate_to_speed(None), 1.0)

    def test_short_paragraph_is_one_chunk(self) -> None:
        self.assertEqual(tts._split_mimo_chunks("第一段。\n\n第二段。"), ["第一段。", "第二段。"])

    def test_mp3_duration_fallback_counts_frames(self) -> None:
        header = bytes([0xFF, 0xF3, 0x84, 0xC4])  # MPEG-2 Layer III, 64kbps, 24kHz
        frame = header + b"\x00" * (72 * 64000 // 24000 - 4)
        with tempfile.TemporaryDirectory() as td:
            path = Path(td) / "frames.mp3"
            path.write_bytes(frame * 100)
            self.assertAlmostEqual(tts._mp3_duration(path), 2.4, places=3)

    def test_long_paragraph_is_grouped_not_split_mid_sentence(self) -> None:
        text = "".join(f"这是第{i}句，用来测试按语义分块。" for i in range(80))
        chunks = tts._split_mimo_chunks(text, max_chars=120)
        self.assertGreater(len(chunks), 1)
        self.assertTrue(all(len(chunk) <= 120 for chunk in chunks))
        self.assertEqual("".join(chunks), text)

    def test_run_closed_mimo_uses_one_request_for_short_script(self) -> None:
        calls: list[list[str]] = []

        def fake_run(cmd, **kwargs):
            calls.append(cmd)
            target = Path(cmd[cmd.index("-o") + 1])
            target.write_bytes(b"ID3-test")
            return SimpleNamespace(returncode=0, stdout="", stderr="")

        text = "".join(f"这是第{i}句，用来测试整段合成。" for i in range(40))
        with tempfile.TemporaryDirectory() as td:
            out = Path(td) / "vo.mp3"
            subtitle = Path(td) / "vo.srt"
            with patch.dict(
                os.environ,
                {
                    "VOICE_PROVIDER": "xiaomi-mimo",
                    "MIMO_API_KEY": "test-key",
                    "MIMO_TTS_VOICE": "冰糖",
                    "MIMO_STYLE_PROMPT": "像同事在白板前讲清楚一件事",
                },
            ), patch.object(tts.subprocess, "run", fake_run), patch.object(
                tts, "_probe_duration", lambda path: 10.0
            ), patch.object(tts, "_concat_mp3", lambda parts, dst: dst.write_bytes(b"ID3-test")), patch.object(
                tts, "_transcode", lambda src, dst, fmt: None
            ):
                tts._run_closed(text, out, "mp3", subtitle, None)

            self.assertEqual(len(calls), 1)
            cmd = calls[0]
            self.assertIn("xiaomi-mimo", cmd)
            self.assertIn("冰糖", cmd)
            self.assertIn(text, cmd)
            self.assertIn("-o", cmd)
            self.assertTrue(out.is_file())
            srt = subtitle.read_text(encoding="utf-8")
            self.assertIn("-->", srt)
            self.assertEqual(srt.count("-->"), len(tts._split_sentences(text)))

    def test_run_closed_mimo_style_overrides_env(self) -> None:
        seen_env: list[dict[str, str]] = []

        def fake_run(cmd, **kwargs):
            seen_env.append(kwargs["env"])
            target = Path(cmd[cmd.index("-o") + 1])
            target.write_bytes(b"ID3-test")
            return SimpleNamespace(returncode=0, stdout="", stderr="")

        with tempfile.TemporaryDirectory() as td:
            out = Path(td) / "vo.mp3"
            with patch.dict(
                os.environ,
                {
                    "VOICE_PROVIDER": "xiaomi-mimo",
                    "MIMO_API_KEY": "test-key",
                    "MIMO_STYLE_PROMPT": "env-style",
                },
            ), patch.object(tts.subprocess, "run", fake_run), patch.object(
                tts, "_concat_mp3", lambda parts, dst: dst.write_bytes(b"ID3-test")
            ):
                tts._run_closed_mimo(
                    "短句。", out, "mp3", None, None, style="per-video-style"
                )

        self.assertEqual(seen_env[0]["MIMO_STYLE_PROMPT"], "per-video-style")


if __name__ == "__main__":
    unittest.main()
