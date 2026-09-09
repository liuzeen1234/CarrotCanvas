"""One-tool-per-process speech evaluator worker.

Each invocation loads exactly one heavyweight model, processes every item in the
batch serially, prints one marked JSON result, and exits so Windows releases the
CUDA context and model memory completely.
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import tempfile
from pathlib import Path

RESULT_PREFIX = "CARROT_SPEECH_EVALUATOR_RESULT="


def normalized_text(value: str) -> str:
    return "".join(ch.lower() for ch in value if ch.isalnum())


def edit_distance(left: str, right: str) -> int:
    prior = list(range(len(right) + 1))
    for i, a in enumerate(left, 1):
        current = [i]
        for j, b in enumerate(right, 1):
            current.append(min(current[-1] + 1, prior[j] + 1, prior[j - 1] + (a != b)))
        prior = current
    return prior[-1]


def run_funasr(items: list[dict], device: str) -> list[dict]:
    from funasr import AutoModel

    model = AutoModel(
        model="paraformer-zh",
        vad_model="fsmn-vad",
        punc_model="ct-punc",
        device=device,
        disable_update=True,
        trust_remote_code=False,
    )
    results = []
    for item in items:
        generated = model.generate(
            input=item["path"], batch_size_s=60, batch_size_threshold_s=30,
            sentence_timestamp=True,
        )
        first = generated[0] if generated else {}
        transcript = str(first.get("text") or "")
        target = normalized_text(str(item.get("targetText") or ""))
        recognized = normalized_text(transcript)
        cer = edit_distance(target, recognized) / max(1, len(target)) if target else None
        results.append({
            "transcript": transcript,
            "timestamps": first.get("timestamp") or [],
            "sentenceInfo": first.get("sentence_info") or [],
            "targetNormalized": target or None,
            "recognizedNormalized": recognized,
            "cer": round(cer, 6) if cer is not None else None,
        })
    return results


def readable_wav(path: str, temp_dir: str) -> str:
    if Path(path).suffix.lower() == ".wav":
        return path
    import librosa
    import soundfile

    audio, rate = librosa.load(path, sr=16000, mono=True)
    converted = str(Path(temp_dir) / f"{Path(path).stem}.wav")
    soundfile.write(converted, audio, rate, subtype="PCM_16")
    return converted


def run_wespeaker(items: list[dict], device: str) -> list[dict]:
    from wespeaker.cli.hub import Hub
    from wespeaker.cli.speaker import Speaker

    speaker = Speaker(Hub.get_model("campplus"))
    speaker.set_device(device)
    results = []
    with tempfile.TemporaryDirectory(prefix="carrot-speaker-") as temp_dir:
        for item in items:
            reference = item.get("referencePath")
            if not reference:
                results.append({"status": "unavailable", "reason": "未提供参考音频"})
                continue
            target_path = readable_wav(item["path"], temp_dir)
            reference_path = readable_wav(reference, temp_dir)
            similarity = float(speaker.compute_similarity(target_path, reference_path))
            results.append({"status": "succeeded", "cosineSimilarity": round(similarity, 6)})
    return results


def run_utmosv2(items: list[dict], device: str) -> list[dict]:
    import importlib
    import random
    import numpy as np
    import torch
    import timm
    import utmosv2
    from modelscope import snapshot_download
    import utmosv2.model.ssl as utmos_ssl

    random.seed(42)
    np.random.seed(42)
    torch.manual_seed(42)
    if torch.cuda.is_available():
        torch.cuda.manual_seed_all(42)
    # Prefer the ModelScope mirror for the SSL backbone. UTMOSv2 itself has no
    # official ModelScope checkpoint, so only its final MOS checkpoint uses the
    # upstream project's release source.
    ssl_path = snapshot_download("facebook/wav2vec2-base", local_files_only=True)
    config = importlib.import_module("utmosv2.config.fusion_stage3")
    config.model.ssl.name = ssl_path
    original_shape = utmos_ssl.get_ssl_output_shape
    utmos_ssl.get_ssl_output_shape = lambda name: (13, 768) if name == ssl_path else original_shape(name)
    checkpoint = os.environ.get("UTMOSV2_CHECKPOINT")
    if not checkpoint or not Path(checkpoint).is_file():
        raise FileNotFoundError("UTMOSV2_CHECKPOINT 未指向已部署的官方模型权重")
    original_timm_create = timm.create_model
    timm.create_model = lambda *args, **kwargs: original_timm_create(
        *args, **{**kwargs, "pretrained": False}
    )
    try:
        model = utmosv2.create_model(pretrained=True, checkpoint_path=checkpoint, device=device)
    finally:
        timm.create_model = original_timm_create
    results = []
    with tempfile.TemporaryDirectory(prefix="carrot-utmos-") as temp_dir:
        for item in items:
            path = readable_wav(item["path"], temp_dir)
            mos = float(model.predict(
                input_path=path, device=device, num_workers=0,
                num_repetitions=5, remove_silent_section=True, verbose=False,
            ))
            results.append({"predictedMos": round(mos, 6), "scale": [1, 5], "numRepetitions": 5})
    return results


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--tool", choices=["funasr", "wespeaker", "utmosv2"], required=True)
    parser.add_argument("--device", default="cuda:0")
    args = parser.parse_args()
    payload = json.load(sys.stdin)
    items = payload.get("items") or []
    if not items:
        raise ValueError("items cannot be empty")
    if args.tool == "funasr":
        output = run_funasr(items, args.device)
    elif args.tool == "wespeaker":
        output = run_wespeaker(items, args.device)
    else:
        output = run_utmosv2(items, args.device)
    print(RESULT_PREFIX + json.dumps({"tool": args.tool, "items": output}, ensure_ascii=False), flush=True)


if __name__ == "__main__":
    main()
