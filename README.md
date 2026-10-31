# SmartCutter

<p align="center">
  <strong>Local-first audio and video transcription for Windows</strong><br>
  Transcribe, align, and prepare media from your terminal—with no remote inference service.
</p>

<p align="center">
  <img src="https://img.shields.io/badge/Platform-Windows-0078D4?style=flat-square&logo=windows&logoColor=white" alt="Windows">
  <img src="https://img.shields.io/badge/Inference-Local-2ea44f?style=flat-square" alt="Local inference">
  <img src="https://img.shields.io/badge/ASR-WhisperX%20large--v3-6f42c1?style=flat-square" alt="WhisperX large-v3">
</p>

SmartCutter runs as a text-based Windows workflow in PowerShell or Command Prompt. It uses **WhisperX large-v3** for transcription and forced alignment for word-level timestamps. The project also includes a workflow for preparing an MP4 from a media file, a timestamped script, and images.

> Audio and video are processed by a local worker on your computer. No external WhisperX worker, ngrok tunnel, or transcription API key is required.

## Features

- Transcribe common audio and video formats.
- Automatically detect the language or provide a language code.
- Generate word-level timestamps with WhisperX forced alignment.
- Copy timestamped text to the clipboard or save it as TXT or JSON.
- Prepare an MP4 using a media file, timestamped script, and ordered images.
- Review timeline entries and adjust their timing or image assignment.
- Use an NVIDIA GPU when available, or run with PyTorch on CPU.

## Quick start

Install [Git for Windows](https://git-scm.com/download/win), open a terminal, and run:

```powershell
git clone https://github.com/xmdxsnd-debug/SmartCutter.git
cd SmartCutter
.\setup.cmd
.\run.cmd
```

Run `setup.cmd` once. It installs the project prerequisites and dependencies, then `run.cmd` starts the local terminal workflow. In Command Prompt, run `setup.cmd` and `run.cmd` without the `.\` prefix.

You can also run `setup.ps1` and `run.ps1` directly from PowerShell.

## What setup installs

When available, `winget` installs any missing prerequisites:

- Node.js 22 or newer
- Python 3.11
- FFmpeg
- pnpm and the project packages
- A local Python environment with WhisperX and the worker dependencies

If `winget` is unavailable, install the prerequisites above manually, reopen your terminal, and run `setup.cmd` again.

The setup script checks for `nvidia-smi`. If it is available, setup installs CUDA-enabled PyTorch; otherwise, it installs the CPU build. CPU transcription works but can be much slower, especially for long recordings.

## First run and model downloads

On first use, SmartCutter downloads WhisperX `large-v3` and the required alignment model. Model files are cached under:

```text
%LOCALAPPDATA%\SmartCutter\huggingface
```

The initial download requires an internet connection and enough free disk space. Later runs use the cached models. The `large-v3` model can require substantial memory; an NVIDIA GPU is recommended for faster processing.

## Using the terminal workflow

After `run.cmd` starts, choose an option from the text menu.

### Transcribe audio or video

1. Enter the path to a media file. You can paste paths that contain spaces.
2. Choose automatic language detection or enter a language code.
3. Wait for local transcription and forced alignment to finish.
4. Copy the timestamped transcript, or save it as TXT, JSON, or both.

TXT output uses timestamped segments, for example:

```text
[0:00] The first sentence begins here.
[0:05] The next sentence starts after a pause.
```

JSON output contains `language`, `duration`, `segments`, and `word_segments`.

### Prepare an MP4

Provide a media file, a timestamped TXT script, and image paths in the order you want to use them. Review the proposed timeline and adjust a line's timing or image assignment before rendering. FFmpeg is required for media processing and MP4 creation.

## Local processing and privacy

- Inference and forced alignment run through the local WhisperX worker.
- Your media is not sent to a cloud transcription service by this terminal workflow.
- Model files are downloaded the first time they are needed; after that, they are read from the local cache.
- No paid transcription API or API key is needed. Check the license terms for the software and model weights you use.

## Project layout

| Path | Purpose |
| --- | --- |
| `scripts/` | Windows terminal workflow |
| `workers/local-whisperx/` | Local WhisperX transcription and alignment worker |
| `artifacts/api-server/` | SmartCutter API server |
| `artifacts/smartcutter/` | Existing browser-based SmartCutter interface |

The browser interface remains part of the repository. `run.cmd` and `run.ps1` start the local terminal workflow; they do not open the browser interface.

## Troubleshooting

- **`winget` is not found:** Install App Installer from the Microsoft Store, or install the prerequisites manually.
- **The model is still loading:** The first run downloads large model files. Keep the terminal open and check your internet connection and available disk space.
- **Transcription is slow:** Confirm that the NVIDIA driver is installed and `nvidia-smi` works before running setup. Otherwise, SmartCutter uses CPU mode.
- **Video processing fails:** Confirm FFmpeg is available in your terminal by running `ffmpeg -version`.

## Repository

[View SmartCutter on GitHub](https://github.com/xmdxsnd-debug/SmartCutter)
