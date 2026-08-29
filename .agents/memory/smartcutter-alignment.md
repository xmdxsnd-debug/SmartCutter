---
name: SmartCutter alignment confidence
description: Accuracy boundaries for SmartCutter speech-to-still alignment in environments without WhisperX.
---

SmartCutter must treat waveform-assisted alignment as an approximate fallback, not word-level transcription. Rows without a reliable onset should remain flagged for review, and export should stay blocked until the user approves those rows.

**Why:** The current runtime may not have WhisperX or another word-level aligner available. Silences can suggest speech onsets, but they cannot prove which spoken words belong to each script line.

**How to apply:** Preserve the original script wording, keep timestamps as hints, expose the alignment source and confidence, and never silently convert fallback timings into approved timings.