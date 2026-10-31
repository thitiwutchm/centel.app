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
In the เลขาช่วยเหลือ room (jobs with "web": true) the model can also search the web (DuckDuckGo)
and read a page, for live things like showtimes or the news, unless WEB_TOOLS=0; the model must
support tool calls (qwen3 does). The app's own assistant room never gets the web.
Once a minute it also reports how the Mac is doing (CPU, memory, disk, uptime, Ollama models,
Hermes gateway, voice/web) for the สถานะ Mac page in Centel › บัญชี; STATUS_REPORT=0 turns that off.
Python 3.8+ standard library only.
"""

import html
import ipaddress
import json
import os
import platform
import re
import shutil
import socket
import subprocess
import sys
import tempfile
import threading
import time
import urllib.error
import urllib.parse
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
WEB_TOOLS = os.environ.get("WEB_TOOLS", "1").lower() not in ("0", "false", "off", "no")
STATUS_REPORT = os.environ.get("STATUS_REPORT", "1").lower() not in ("0", "false", "off", "no")
OLLAMA_URL = os.environ.get("OLLAMA_URL", "").rstrip("/") or (
    HERMES_URL[:-3] if ":11434" in HERMES_URL and HERMES_URL.endswith("/v1") else "http://127.0.0.1:11434")
VERSION = "2"
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


# Web tools the model may call: a search and a page reader. Only reads public pages; nothing on the Mac.
TOOLS = [
    {"type": "function", "function": {
        "name": "web_search",
        "description": "Search the web for current information (showtimes, news, opening hours, prices, weather). Returns titles, links and snippets.",
        "parameters": {"type": "object", "properties": {"query": {"type": "string", "description": "Search words, Thai or English"}}, "required": ["query"]}}},
    {"type": "function", "function": {
        "name": "read_page",
        "description": "Read the text of a web page found by web_search.",
        "parameters": {"type": "object", "properties": {"url": {"type": "string"}}, "required": ["url"]}}},
]
BROWSER_UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15"


def public_url(url):
    """Only public web pages: a link the model was handed must not reach this Mac or the home
    network (Ollama on 127.0.0.1:11434 has no password, nor do most routers and printers)."""
    u = urllib.parse.urlparse(url or "")
    if u.scheme not in ("http", "https") or not u.hostname:
        raise ValueError("ใช้ได้เฉพาะลิงก์ http/https")
    try:
        infos = socket.getaddrinfo(u.hostname, u.port or (443 if u.scheme == "https" else 80), proto=socket.IPPROTO_TCP)
    except socket.gaierror:
        raise ValueError("หาเว็บนี้ไม่เจอ")
    for info in infos:
        ip = ipaddress.ip_address(info[4][0].split("%")[0])
        if not ip.is_global or ip.is_multicast:
            raise ValueError("ลิงก์นี้ชี้เข้าเครื่องหรือเครือข่ายในบ้าน เปิดไม่ได้")
    return url


class PublicRedirects(urllib.request.HTTPRedirectHandler):
    # Each hop of a redirect is checked too, so a public page cannot bounce the bridge inward.
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        public_url(newurl)
        return super().redirect_request(req, fp, code, msg, headers, newurl)


WEB = urllib.request.build_opener(PublicRedirects)


def fetch_text(url, data=None, timeout=20):
    req = urllib.request.Request(public_url(url), data=data, headers={"user-agent": BROWSER_UA, "accept-language": "th,en;q=0.8"})
    with WEB.open(req, timeout=timeout) as res:
        return res.read(2_000_000).decode(res.headers.get_content_charset() or "utf-8", "replace")


def strip_html(s):
    s = re.sub(r"(?is)<(script|style|noscript|svg|head)[^>]*>.*?</\1>", " ", s)
    s = re.sub(r"(?s)<[^>]+>", " ", s)
    return re.sub(r"\s+", " ", html.unescape(s)).strip()


def web_search(query):
    page = fetch_text("https://html.duckduckgo.com/html/", urllib.parse.urlencode({"q": query, "kl": "th-th"}).encode())
    out = []
    for m in re.finditer(r'(?s)class="result__a"[^>]*href="([^"]+)"[^>]*>(.*?)</a>.*?class="result__snippet"[^>]*>(.*?)</a>', page):
        link = html.unescape(m.group(1))
        q = urllib.parse.parse_qs(urllib.parse.urlparse(link).query)
        link = q.get("uddg", [link])[0]
        out.append(f"- {strip_html(m.group(2))}\n  {link}\n  {strip_html(m.group(3))}")
        if len(out) >= 6:
            break
    return "\n".join(out) or "ไม่พบผลการค้นหา"


def read_page(url):
    if not re.match(r"^https?://", url or ""):
        return "ลิงก์ไม่ถูกต้อง"
    return strip_html(fetch_text(url))[:6000] or "หน้านี้ไม่มีข้อความ"


def run_tool(name, args):
    try:
        if name == "web_search":
            return web_search(str(args.get("query", ""))[:200])
        if name == "read_page":
            return read_page(str(args.get("url", "")))
        return "ไม่มีเครื่องมือนี้"
    except Exception as e:  # a dead site should not end the answer
        return f"ใช้ไม่ได้: {e}"


def chat(messages, tools):
    headers = {"authorization": f"Bearer {HERMES_KEY}"} if HERMES_KEY else {}
    body = {"model": HERMES_MODEL, "messages": messages, "stream": False}
    if tools:
        body["tools"] = TOOLS
    _, out = call("POST", HERMES_URL + "/chat/completions", body, headers, HERMES_TIMEOUT)
    return out["choices"][0]["message"]


def ask_hermes(messages, web=False):
    messages = list(messages)
    tools = web and WEB_TOOLS
    for _ in range(5):
        try:
            msg = chat(messages, tools)
        except urllib.error.HTTPError as e:
            if tools and e.code in (400, 404, 422, 500):  # a server without tool calls: ask plainly
                tools = False
                continue
            raise
        calls = msg.get("tool_calls") or []
        if not calls:
            return (msg.get("content") or "").strip()
        messages.append({"role": "assistant", "content": msg.get("content") or "", "tool_calls": calls})
        for c in calls:
            fn = c.get("function") or {}
            try:
                args = json.loads(fn.get("arguments") or "{}") if isinstance(fn.get("arguments"), str) else (fn.get("arguments") or {})
            except ValueError:
                args = {}
            log("tool", fn.get("name"), json.dumps(args, ensure_ascii=False)[:120])
            messages.append({"role": "tool", "tool_call_id": c.get("id", ""), "name": fn.get("name"),
                             "content": run_tool(fn.get("name"), args)})
    # Out of rounds: one last answer without tools.
    return (chat(messages, False).get("content") or "").strip()


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


# ---------- Mac status (Centel › บัญชี › สถานะ Mac) ----------

STATS = {"since": time.strftime("%Y-%m-%dT%H:%M:%S%z"), "answered": 0, "failed": 0, "heard": 0,
         "lastMs": None, "times": [], "lastError": None, "lastErrorAt": None}


def answered(ms):
    STATS["answered"] += 1
    STATS["lastMs"] = round(ms)
    STATS["times"] = (STATS["times"] + [ms])[-20:]


def note_error(e):
    STATS["failed"] += 1
    STATS["lastError"] = str(e)[:200]
    STATS["lastErrorAt"] = time.strftime("%Y-%m-%dT%H:%M:%S%z")


def sh(*cmd, timeout=10):
    """Output of a small system command, or "" when it is missing or fails."""
    path = tool(cmd[0])
    if not path:
        return ""
    try:
        return subprocess.run([path, *cmd[1:]], capture_output=True, text=True, timeout=timeout).stdout.strip()
    except Exception:
        return ""


def num_in(s, pattern, default=None):
    m = re.search(pattern, s or "")
    return float(m.group(1)) if m else default


def mac_memory():
    total = int(sh("sysctl", "-n", "hw.memsize") or 0)
    vm = sh("vm_stat")
    if total and vm:
        page = int(num_in(vm, r"page size of (\d+)", 16384))
        pages = lambda name: num_in(vm, rf'"?{name}"?:\s+(\d+)', 0)
        anon = pages("Anonymous pages")
        # Like Activity Monitor's "Memory Used": app memory + wired + compressed.
        app = (anon - pages("Pages purgeable")) if anon else pages("Pages active")
        used = (app + pages("Pages wired down") + pages("Pages occupied by compressor")) * page
        swap = num_in(sh("sysctl", "-n", "vm.swapusage"), r"used = ([\d.]+)M", 0) * 1024 * 1024
        return {"total": total, "used": min(used, total), "swap": swap}
    if os.path.exists("/proc/meminfo"):  # Linux, for trying the bridge elsewhere
        info = open("/proc/meminfo").read()
        t, a = num_in(info, r"MemTotal:\s+(\d+)", 0) * 1024, num_in(info, r"MemAvailable:\s+(\d+)", 0) * 1024
        return {"total": t, "used": t - a}
    return {}


def cpu_usage(cores):
    # top samples twice, a second apart; the second "CPU usage" line is the real one.
    out = sh("top", "-l", "2", "-n", "0", "-s", "1", timeout=15)
    idle = re.findall(r"CPU usage:.*?([\d.]+)% idle", out)
    if idle:
        return round(100 - float(idle[-1]), 1)
    try:
        return round(min(100.0, os.getloadavg()[0] / max(cores, 1) * 100), 1)
    except OSError:
        return None


def uptime_sec():
    boot = num_in(sh("sysctl", "-n", "kern.boottime"), r"sec = (\d+)")
    if boot:
        return round(time.time() - boot)
    try:
        return round(float(open("/proc/uptime").read().split()[0]))
    except Exception:
        return None


def get_json(url, headers=None, timeout=5):
    req = urllib.request.Request(url, headers={"user-agent": "centel-bridge/1", **(headers or {})})
    with urllib.request.urlopen(req, timeout=timeout) as res:
        return json.loads(res.read() or b"null")


def ollama_status():
    out = {"up": False}
    try:
        out["version"] = (get_json(OLLAMA_URL + "/api/version") or {}).get("version")
        out["up"] = True
        out["running"] = [{"name": m.get("name"), "size": m.get("size"), "vram": m.get("size_vram"), "until": m.get("expires_at")}
                          for m in (get_json(OLLAMA_URL + "/api/ps") or {}).get("models", [])]
        out["models"] = [{"name": m.get("name"), "size": m.get("size")}
                         for m in (get_json(OLLAMA_URL + "/api/tags") or {}).get("models", [])]
    except Exception:
        pass
    return out


def hermes_status():
    started = time.time()
    try:
        get_json(HERMES_URL + "/models", {"authorization": f"Bearer {HERMES_KEY}"} if HERMES_KEY else {})
        return {"up": True, "ms": round((time.time() - started) * 1000), "url": HERMES_URL}
    except Exception:
        return {"up": False, "url": HERMES_URL}


def mac_status():
    cores = os.cpu_count() or 1
    disk_path = "/System/Volumes/Data" if os.path.exists("/System/Volumes/Data") else "/"
    du = shutil.disk_usage(disk_path)
    try:
        load = [round(x, 2) for x in os.getloadavg()]
    except OSError:
        load = []
    mac_ver = platform.mac_ver()[0]
    times = STATS["times"]
    return {
        "host": platform.node()[:40],
        "model": sh("sysctl", "-n", "hw.model") or platform.machine(),
        "chip": sh("sysctl", "-n", "machdep.cpu.brand_string") or platform.processor(),
        "os": f"macOS {mac_ver}" if mac_ver else platform.platform(terse=True),
        "uptime": uptime_sec(),
        "cpu": {"cores": cores, "load": load, "usage": cpu_usage(cores)},
        "mem": mac_memory(),
        "disk": {"total": du.total, "free": du.free},
        "ollama": ollama_status(),
        "hermes": hermes_status() if HERMES_URL.rstrip("/") != OLLAMA_URL + "/v1" else {"up": None, "url": HERMES_URL},
        "voice": STT, "web": WEB_TOOLS,
        "bridge": {"version": VERSION, "since": STATS["since"], "answered": STATS["answered"], "failed": STATS["failed"],
                   "heard": STATS["heard"], "lastMs": STATS["lastMs"], "avgMs": round(sum(times) / len(times)) if times else None,
                   "lastError": STATS["lastError"], "lastErrorAt": STATS["lastErrorAt"]},
    }


def report_loop():
    every = 60
    while True:
        try:
            _, out = centel("POST", "/api/bridge/status", mac_status(), timeout=30)
            every = int((out or {}).get("every") or 60)
        except urllib.error.HTTPError as e:
            if e.code == 404:  # an older Centel without the status page
                every = 900
        except Exception:
            pass
        time.sleep(max(every, 20))


STT = False


def main():
    global STT
    if not TOKEN.startswith("cb_"):
        sys.exit(f"Set CENTEL_TOKEN (from Centel › บัญชี › ผู้ช่วย AI) in {ENV_FILE}")
    STT = can_transcribe()
    log(f"centel bridge → {CENTEL_URL}, Hermes at {HERMES_URL} ({HERMES_MODEL}), voice {'on' if STT else 'off'}, web {'on' if WEB_TOOLS else 'off'}")
    if STATUS_REPORT:
        threading.Thread(target=report_loop, daemon=True).start()
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
                    STATS["heard"] += 1
                except Exception as e:
                    log("whisper failed:", e)
                    note_error(e)
                    centel("POST", f"/api/bridge/jobs/{job['id']}", {"error": str(e)[:300]})
                continue
            log("question", job["id"][:8])
            try:
                started = time.time()
                reply = ask_hermes(job["messages"], bool(job.get("web")))
                centel("POST", f"/api/bridge/jobs/{job['id']}", {"reply": reply})
                log("answered", job["id"][:8], f"{len(reply)} chars")
                answered((time.time() - started) * 1000)
            except Exception as e:  # Hermes down or slow: tell the chat instead of going quiet.
                log("hermes failed:", e)
                note_error(e)
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
