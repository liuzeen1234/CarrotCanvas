import argparse
import base64
import gc
import json
import os
import sys
import tempfile
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
RUNTIME = ROOT / "backend" / "data" / "tts-runtime"
MODELS = ROOT / "backend" / "data" / "tts-models"


class Engine:
    def __init__(self, provider: str):
        self.provider = provider
        self.model = None
        self.model_variant = None
        self.lock = threading.RLock()

    def load(self):
        with self.lock:
            if self.model is not None:
                return
            if self.provider == "cosyvoice3":
                source = RUNTIME / "CosyVoice"
                sys.path[:0] = [str(source), str(source / "third_party" / "Matcha-TTS")]
                from cosyvoice.cli.cosyvoice import AutoModel
                self.model = AutoModel(model_dir=str(MODELS / "Fun-CosyVoice3-0.5B-2512"), fp16=True)
            elif self.provider == "indextts2":
                source = RUNTIME / "index-tts"
                sys.path.insert(0, str(source))
                from indextts.infer_v2 import IndexTTS2
                model_dir = MODELS / "IndexTTS-2"
                self.model = IndexTTS2(
                    cfg_path=str(model_dir / "config.yaml"), model_dir=str(model_dir),
                    use_fp16=True, device="cuda:0", use_cuda_kernel=False,
                    use_deepspeed=False, use_qwen_emo=True,
                )
            else:
                self._load_qwen("custom")

    def _load_qwen(self, variant: str):
        if self.model is not None and self.model_variant == variant:
            return
        if self.model is not None:
            self.unload()
        import torch
        from qwen_tts import Qwen3TTSModel
        folder = "Qwen3-TTS-12Hz-0.6B-CustomVoice" if variant == "custom" else "Qwen3-TTS-12Hz-1.7B-VoiceDesign"
        self.model = Qwen3TTSModel.from_pretrained(
            str(MODELS / folder), device_map="cuda:0", dtype=torch.bfloat16,
        )
        self.model_variant = variant

    def unload(self):
        with self.lock:
            self.model = None
            self.model_variant = None
            gc.collect()
            try:
                import torch
                if torch.cuda.is_available():
                    torch.cuda.empty_cache()
                    torch.cuda.ipc_collect()
            except Exception:
                pass

    def infer(self, payload: dict) -> bytes:
        with self.lock, tempfile.TemporaryDirectory(prefix="carrot-tts-") as tmp:
            self.load()
            if self.provider == "qwen3tts":
                return self._infer_qwen(payload)
            reference = base64.b64decode(payload["referenceAudioBase64"])
            emotion_raw = payload.get("emotionReferenceAudioBase64")
            prompt = Path(tmp) / "prompt.wav"
            output = Path(tmp) / "output.wav"
            prompt.write_bytes(reference)
            if self.provider == "cosyvoice3":
                import torch
                import torchaudio
                reference_text = str(payload.get("referenceText") or "").strip()
                if not reference_text:
                    raise ValueError("CosyVoice 3 需要参考音频对应的 referenceText")
                instruction = str(payload.get("instruction") or "You are a helpful assistant.").strip()
                prompt_text = f"{instruction}<|endofprompt|>{reference_text}"
                chunks = [item["tts_speech"] for item in self.model.inference_zero_shot(
                    str(payload["text"]), prompt_text, str(prompt), stream=False,
                    speed=float(payload.get("speed") or 1.0),
                )]
                if not chunks:
                    raise RuntimeError("CosyVoice 3 未返回音频")
                torchaudio.save(str(output), torch.cat(chunks, dim=1), self.model.sample_rate)
            else:
                emotion = None
                if emotion_raw:
                    emotion = Path(tmp) / "emotion.wav"
                    emotion.write_bytes(base64.b64decode(emotion_raw))
                instruction = str(payload.get("instruction") or "").strip()
                self.model.infer(
                    spk_audio_prompt=str(prompt), text=str(payload["text"]), output_path=str(output),
                    emo_audio_prompt=str(emotion) if emotion else None,
                    use_emo_text=bool(instruction), emo_text=instruction or None,
                    use_random=False, verbose=False,
                )
            return output.read_bytes()

    def _infer_qwen(self, payload: dict) -> bytes:
        import io
        import soundfile as sf
        mode = "design" if payload.get("voiceMode") == "design" else "custom"
        self._load_qwen(mode)
        common = {"text": str(payload["text"]), "language": str(payload.get("language") or "Auto")}
        instruction = str(payload.get("instruction") or "").strip()
        if mode == "design":
            wavs, sample_rate = self.model.generate_voice_design(**common, instruct=instruction)
        else:
            speaker = str(payload.get("nativeSpeaker") or "").strip()
            if not speaker:
                raise ValueError("Qwen3-TTS 预设音色缺少 speaker")
            wavs, sample_rate = self.model.generate_custom_voice(**common, speaker=speaker, instruct=instruction or None)
        stream = io.BytesIO()
        sf.write(stream, wavs[0], sample_rate, format="WAV", subtype="PCM_16")
        return stream.getvalue()


class Handler(BaseHTTPRequestHandler):
    engine: Engine

    def do_GET(self):
        if self.path != "/health":
            self.send_error(404)
            return
        metrics = {"pid": os.getpid(), "rssBytes": None, "vmsBytes": None, "cudaAllocatedBytes": 0, "cudaReservedBytes": 0, "modelVariant": self.engine.model_variant}
        try:
            import psutil
            memory = psutil.Process().memory_info()
            metrics.update({"rssBytes": memory.rss, "vmsBytes": memory.vms})
        except Exception:
            pass
        try:
            import torch
            if torch.cuda.is_available():
                metrics.update({"cudaAllocatedBytes": torch.cuda.memory_allocated(), "cudaReservedBytes": torch.cuda.memory_reserved()})
        except Exception:
            pass
        self.json_response(200, {"ok": True, "provider": self.engine.provider, "loaded": self.engine.model is not None, **metrics})

    def do_POST(self):
        try:
            if self.path == "/load":
                self.engine.load()
                self.json_response(200, {"ok": True, "loaded": True})
            elif self.path == "/unload":
                self.engine.unload()
                self.json_response(200, {"ok": True, "loaded": False})
            elif self.path == "/shutdown":
                self.json_response(200, {"ok": True, "stopping": True, "pid": os.getpid()})
                threading.Thread(target=self.server.shutdown, daemon=True).start()
            elif self.path == "/infer":
                size = int(self.headers.get("content-length", "0"))
                payload = json.loads(self.rfile.read(size))
                audio = self.engine.infer(payload)
                self.send_response(200)
                self.send_header("Content-Type", "audio/wav")
                self.send_header("Content-Length", str(len(audio)))
                self.end_headers()
                self.wfile.write(audio)
            else:
                self.send_error(404)
        except Exception as error:
            self.json_response(500, {"ok": False, "error": str(error), "type": type(error).__name__})

    def json_response(self, status: int, body: dict):
        data = json.dumps(body, ensure_ascii=False).encode("utf-8")
        try:
            self.send_response(status)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)
        except (BrokenPipeError, ConnectionAbortedError, ConnectionResetError):
            pass

    def log_message(self, fmt, *args):
        sys.stderr.write(f"[{self.engine.provider}] {fmt % args}\n")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--provider", choices=("cosyvoice3", "indextts2", "qwen3tts"), required=True)
    parser.add_argument("--port", type=int, required=True)
    args = parser.parse_args()
    Handler.engine = Engine(args.provider)
    server = ThreadingHTTPServer(("127.0.0.1", args.port), Handler)
    server.serve_forever()


if __name__ == "__main__":
    main()
