#!/usr/bin/env python3
"""Centel bridge: lets Hermes Agent on this Mac answer the in-app chat at centel.app.

It only makes outgoing requests, so nothing on the Mac is opened to the internet:
  1. long-polls https://centel.app/api/bridge/next with the token from
     Centel › บัญชี › ผู้ช่วย AI,
  2. sends the prompt Centel built to Hermes Agent's OpenAI-compatible API
     (hermes gateway with API_SERVER_ENABLED=true, http://127.0.0.1:8642/v1),
  3. posts the answer back to /api/bridge/jobs/<id>.
Any OpenAI-compatible server works too (Ollama: HERMES_URL=http://127.0.0.1:11434/v1,
HERMES_MODEL=hermes3). Settings come from the environment or ~/.centel-bridge.env.
Voice questions are turned into text on this Mac with whisper.cpp (brew install whisper-cpp
ffmpeg, plus a model file in WHISPER_MODEL); without them the bridge only takes typed questions.
Python 3.8+ standard library only.
"""

import json
import os
import platform
import shutil
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request

ENV_FILE = os.path.expanduser("~/.centel-bridge.env")


def load_env():
    if os.path.exists(ENV_FILE):
        with open(ENV_FILE, encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if not line or line.startswith("#") or "=" not in line:
                    continue
                k, v = line.split("=", 1)
                os.environ.setdefault(k.strip(), v.strip().strip('"').strip("'"))


load_env()
CENTEL_URL = os.environ.get("CENTEL_URL", "https://centel.app").rstrip("/")
TOKEN = os.environ.get("CENTEL_TOKEN", "")
HERMES_URL = os.environ.get("HERMES_URL", "http://127.0.0.1:8642/v1").rstrip("/")
HERMES_KEY = os.environ.get("HERMES_KEY", "")
HERMES_MODEL = os.environ.get("HERMES_MODEL", "hermes-agent")
HERMES_TIMEOUT = int(os.environ.get("HERMES_TIMEOUT", "240"))
INFO = f"{platform.node()[:40]} · {HERMES_MODEL}"
WHISPER_CMD = os.environ.get("WHISPER_CMD", "whisper-cli")
WHISPER_MODEL = os.path.expanduser(os.environ.get("WHISPER_MODEL", "~/.centel-bridge/ggml-large-v3-turbo.bin"))
WHISPER_LANG = os.environ.get("WHISPER_LANG", "auto")
# launchd starts with a bare PATH, so look where Homebrew puts things too.
TOOL_PATH = os.pathsep.join([os.environ.get("PATH", ""), "/opt/homebrew/bin", "/usr/local/bin"])


def tool(name):
    return shutil.which(name, path=TOOL_PATH)


def can_transcribe():
    return bool(tool(WHISPER_CMD) and tool("ffmpeg") and os.path.exists(WHISPER_MODEL))


def log(*a):
    print(time.strftime("%Y-%m-%d %H:%M:%S"), *a, flush=True)


def call(method, url, body=None, headers=None, timeout=60):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(url, data=data, method=method)
    req.add_header("content-type", "application/json")
    req.add_header("user-agent", "centel-bridge/1")
    for k, v in (headers or {}).items():
        req.add_header(k, v)
    with urllib.request.urlopen(req, timeout=timeout) as res:
        raw = res.read()
        return res.status, (json.loads(raw) if raw else None)


def centel(method, path, body=None, timeout=60):
    headers = {"authorization": f"Bearer {TOKEN}", "x-bridge-info": INFO}
    if STT:
        headers["x-bridge-caps"] = "stt"
    return call(method, CENTEL_URL + path, body, headers, timeout)


def ask_hermes(messages):
    headers = {"authorization": f"Bearer {HERMES_KEY}"} if HERMES_KEY else {}
    _, out = call("POST", HERMES_URL + "/chat/completions",
                  {"model": HERMES_MODEL, "messages": messages, "stream": False},
                  headers, HERMES_TIMEOUT)
    return (out["choices"][0]["message"].get("content") or "").strip()


def transcribe(job):
    """Recording (m4a/webm from the phone) → 16 kHz wav → whisper.cpp → text."""
    import base64
    with tempfile.TemporaryDirectory() as d:
        src, wav = os.path.join(d, "in.audio"), os.path.join(d, "in.wav")
        with open(src, "wb") as f:
            f.write(base64.b64decode(job["audio"]))
        subprocess.run([tool("ffmpeg"), "-loglevel", "error", "-y", "-i", src, "-ar", "16000", "-ac", "1", wav],
                       check=True, timeout=60)
        out = subprocess.run([tool(WHISPER_CMD), "-m", WHISPER_MODEL, "-l", WHISPER_LANG, "-nt", "-np", "-f", wav],
                             check=True, timeout=180, capture_output=True, text=True)
        return " ".join(line.strip() for line in out.stdout.splitlines() if line.strip())


STT = False


def main():
    global STT
    if not TOKEN.startswith("cb_"):
        sys.exit(f"Set CENTEL_TOKEN (from Centel › บัญชี › ผู้ช่วย AI) in {ENV_FILE}")
    STT = can_transcribe()
    log(f"centel bridge → {CENTEL_URL}, Hermes at {HERMES_URL} ({HERMES_MODEL}), voice {'on' if STT else 'off'}")
    backoff = 2
    while True:
        try:
            status, job = centel("GET", "/api/bridge/next?wait=25", timeout=45)
            backoff = 2
            if status == 204 or not job:
                continue
            if job.get("kind") == "transcribe":
                log("voice", job["id"][:8])
                try:
                    text = transcribe(job)
                    centel("POST", f"/api/bridge/jobs/{job['id']}", {"text": text})
                    log("heard", job["id"][:8], f"{len(text)} chars")
                except Exception as e:
                    log("whisper failed:", e)
                    centel("POST", f"/api/bridge/jobs/{job['id']}", {"error": str(e)[:300]})
                continue
            log("question", job["id"][:8])
            try:
                reply = ask_hermes(job["messages"])
                centel("POST", f"/api/bridge/jobs/{job['id']}", {"reply": reply})
                log("answered", job["id"][:8], f"{len(reply)} chars")
            except Exception as e:  # Hermes down or slow: tell the chat instead of going quiet.
                log("hermes failed:", e)
                centel("POST", f"/api/bridge/jobs/{job['id']}", {"error": str(e)[:300]})
        except urllib.error.HTTPError as e:
            if e.code == 401:
                log("token refused: make a new one in Centel › บัญชี › ผู้ช่วย AI")
                time.sleep(60)
            else:
                log("centel error", e.code)
                time.sleep(backoff)
                backoff = min(backoff * 2, 60)
        except Exception as e:  # offline, asleep, DNS…
            log("waiting for network:", e)
            time.sleep(backoff)
            backoff = min(backoff * 2, 60)


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        pass
