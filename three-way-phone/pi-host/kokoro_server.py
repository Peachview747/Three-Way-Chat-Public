# Keeps the Kokoro voice model loaded so each spoken reply skips the load.
# POST /speak with JSON {"voice": "af_heart", "text": "..."} returns WAV audio.
# Started by voice.mjs on 127.0.0.1 only; installed in /opt/ai-room-voice/kokoro.
import io, json, sys, threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
import soundfile as sf
from kokoro_onnx import Kokoro

here = Path(__file__).resolve().parent
port = int(sys.argv[1]) if len(sys.argv) > 1 else 5011
model = Kokoro(str(here / "kokoro-v1.0.onnx"), str(here / "voices-v1.0.bin"))
lock = threading.Lock()  # one synthesis at a time keeps the Pi's four cores free for each reply

class Handler(BaseHTTPRequestHandler):
    def do_POST(self):
        if self.path != "/speak":
            self.send_error(404); return
        body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
        voice, text = body["voice"], body["text"]
        # British voices start with "b", American with "a".
        lang = "en-gb" if voice.startswith("b") else "en-us"
        with lock:
            samples, rate = model.create(text, voice=voice, speed=1.0, lang=lang)
        out = io.BytesIO()
        sf.write(out, samples, rate, format="WAV")
        data = out.getvalue()
        self.send_response(200)
        self.send_header("Content-Type", "audio/wav")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def log_message(self, *args):
        pass

ThreadingHTTPServer(("127.0.0.1", port), Handler).serve_forever()
