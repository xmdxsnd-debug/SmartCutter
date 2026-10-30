from __future__ import annotations

import asyncio
import hmac
import logging
import os
import subprocess
import tempfile
import threading
from pathlib import Path
from typing import Any

import torch
import whisperx
from fastapi import FastAPI, File, Form, Header, HTTPException, UploadFile

MODEL_NAME = os.environ.get("WHISPERX_MODEL", "large-v3")
MAX_UPLOAD_BYTES = 500 * 1024 * 1024
VIDEO_EXTENSIONS = {".mp4", ".mov", ".mkv", ".m4v", ".avi"}
API_KEY = os.environ.get("WHISPERX_API_KEY", "")
logger = logging.getLogger("smartcutter.whisperx")

state: dict[str, Any] = {
    "model": None,
    "device": "cpu",
    "cuda": False,
    "loading": True,
    "load_error": None,
    "aligners": {},
}
model_lock = threading.Lock()
inference_lock = threading.Lock()
aligner_lock = threading.Lock()

app = FastAPI(title="SmartCutter Local WhisperX Worker", version="1.0.0")


def require_api_key(value: str | None) -> None:
    if not API_KEY:
        raise HTTPException(status_code=503, detail="Local Worker API key is not configured.")
    if value is None or not hmac.compare_digest(value, API_KEY):
        raise HTTPException(status_code=401, detail="Invalid Worker API key.")


def load_alignment_model(language: str):
    with aligner_lock:
        cached = state["aligners"].get(language)
        if cached:
            return cached
        try:
            aligner = whisperx.load_align_model(
                language_code=language,
                device=state["device"],
            )
        except Exception as error:
            raise HTTPException(
                status_code=422,
                detail=f"WhisperX has no usable forced-alignment model for language '{language}': {error}",
            ) from error
        state["aligners"][language] = aligner
        return aligner


def initialize_models() -> None:
    try:
        if torch.cuda.is_available():
            try:
                model = whisperx.load_model(
                    MODEL_NAME,
                    "cuda",
                    compute_type="float16",
                    vad_method="silero",
                )
                state["device"] = "cuda"
                state["cuda"] = True
            except Exception:
                logger.exception("CUDA initialization failed; trying local CPU mode.")
                model = whisperx.load_model(
                    MODEL_NAME,
                    "cpu",
                    compute_type="int8",
                    vad_method="silero",
                )
                state["device"] = "cpu"
                state["cuda"] = False
        else:
            model = whisperx.load_model(
                MODEL_NAME,
                "cpu",
                compute_type="int8",
                vad_method="silero",
            )
            state["device"] = "cpu"
            state["cuda"] = False

        state["model"] = model
        load_alignment_model("ar")
        state["load_error"] = None
        logger.info(
            "WhisperX %s and Arabic forced alignment are ready on %s.",
            MODEL_NAME,
            state["device"],
        )
    except Exception as error:
        state["load_error"] = str(error)
        logger.exception("WhisperX local model initialization failed.")
    finally:
        state["loading"] = False


@app.on_event("startup")
async def start_model_loader() -> None:
    asyncio.create_task(asyncio.to_thread(initialize_models))


@app.get("/health")
async def health(x_api_key: str | None = Header(default=None)) -> dict[str, Any]:
    require_api_key(x_api_key)
    ready = state["model"] is not None and "ar" in state["aligners"]
    return {
        "status": "ok" if ready else "loading" if state["loading"] else "error",
        "model": MODEL_NAME,
        "model_loaded": state["model"] is not None,
        "alignment_ready": "ar" in state["aligners"],
        "cuda": state["cuda"],
        "device": state["device"],
        "error": state["load_error"],
    }


def prepare_media(source: Path, work_dir: Path) -> Path:
    if source.suffix.lower() not in VIDEO_EXTENSIONS:
        return source
    extracted = work_dir / "smartcutter-audio.wav"
    command = [
        os.environ.get("FFMPEG_BINARY", "ffmpeg"),
        "-y",
        "-hide_banner",
        "-loglevel",
        "error",
        "-i",
        str(source),
        "-vn",
        "-ac",
        "1",
        "-ar",
        "16000",
        "-f",
        "wav",
        str(extracted),
    ]
    try:
        subprocess.run(command, check=True, capture_output=True, text=True)
    except FileNotFoundError as error:
        raise HTTPException(status_code=503, detail="FFmpeg is required to extract audio from video.") from error
    except subprocess.CalledProcessError as error:
        detail = error.stderr.strip() or "The video did not contain readable audio."
        raise HTTPException(status_code=422, detail=detail[-800:]) from error
    return extracted


def transcribe_file(media_path: Path, language: str) -> dict[str, Any]:
    model = state["model"]
    if model is None:
        message = state["load_error"] or "WhisperX large-v3 is still loading."
        raise HTTPException(status_code=503, detail=message)

    audio = whisperx.load_audio(str(media_path))
    duration = len(audio) / 16_000
    forced_language = None if language.strip().lower() == "auto" else language.strip().lower()

    with inference_lock:
        result = model.transcribe(
            audio,
            batch_size=4 if state["cuda"] else 1,
            language=forced_language,
        )
        detected_language = result.get("language") or forced_language
        if not detected_language:
            raise HTTPException(status_code=422, detail="WhisperX could not detect a language.")
        align_model, metadata = load_alignment_model(detected_language)
        aligned = whisperx.align(
            result.get("segments", []),
            align_model,
            metadata,
            audio,
            state["device"],
            return_char_alignments=False,
        )

    segments = [
        {
            "start": float(segment["start"]),
            "end": float(segment["end"]),
            "text": str(segment.get("text", "")).strip(),
        }
        for segment in aligned.get("segments", [])
        if segment.get("text") and segment.get("start") is not None and segment.get("end") is not None
    ]
    word_segments = []
    for segment in aligned.get("segments", []):
        for word in segment.get("words", []):
            word_text = str(word.get("word", "")).strip()
            start = word.get("start")
            end = word.get("end")
            if word_text and start is not None and end is not None and float(end) > float(start):
                word_segments.append(
                    {
                        "word": word_text,
                        "start": float(start),
                        "end": float(end),
                    }
                )

    if not segments or not word_segments:
        raise HTTPException(
            status_code=422,
            detail="WhisperX did not return aligned word timestamps for this media.",
        )

    return {
        "language": str(detected_language),
        "duration": float(duration),
        "segments": segments,
        "word_segments": word_segments,
    }


@app.post("/v1/transcribe")
async def transcribe(
    audio: UploadFile = File(...),
    language: str = Form(default="auto"),
    x_api_key: str | None = Header(default=None),
) -> dict[str, Any]:
    require_api_key(x_api_key)
    if state["model"] is None:
        if state["loading"]:
            raise HTTPException(status_code=503, detail="WhisperX large-v3 is loading locally. Try again shortly.")
        raise HTTPException(
            status_code=503,
            detail=state["load_error"] or "WhisperX local model is unavailable.",
        )

    extension = Path(audio.filename or "recording.bin").suffix.lower()
    with tempfile.TemporaryDirectory(prefix="smartcutter-whisperx-") as temporary:
        work_dir = Path(temporary)
        source_path = work_dir / f"source{extension or '.bin'}"
        total = 0
        try:
            with source_path.open("wb") as destination:
                while chunk := await audio.read(1024 * 1024):
                    total += len(chunk)
                    if total > MAX_UPLOAD_BYTES:
                        raise HTTPException(status_code=413, detail="Media exceeds the 500 MB local limit.")
                    destination.write(chunk)
        finally:
            await audio.close()

        if total == 0:
            raise HTTPException(status_code=400, detail="The uploaded media file is empty.")
        ready_path = prepare_media(source_path, work_dir)
        return await asyncio.to_thread(transcribe_file, ready_path, language)
