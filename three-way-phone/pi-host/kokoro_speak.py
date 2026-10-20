# Text to WAV with Kokoro, for AI Room's voices. Text comes in on stdin:
#   kokoro_speak.py <voice> <out.wav>
# Installed in /opt/ai-room-voice/kokoro with its own venv and model files.
import sys
from pathlib import Path
import soundfile as sf
from kokoro_onnx import Kokoro

here = Path(__file__).resolve().parent
voice, out = sys.argv[1], sys.argv[2]
text = sys.stdin.read().strip()
model = Kokoro(str(here / "kokoro-v1.0.onnx"), str(here / "voices-v1.0.bin"))
# British voices start with "b", American with "a".
lang = "en-gb" if voice.startswith("b") else "en-us"
samples, rate = model.create(text, voice=voice, speed=1.0, lang=lang)
sf.write(out, samples, rate)
