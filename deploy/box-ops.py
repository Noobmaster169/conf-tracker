#!/usr/bin/env python3
"""
The box's hands and eyes for whoever cannot log in to it. auto-deploy.sh runs this from the clone on every cron pass:

  box-ops.py jobs      takes the jobs queued through the api (POST /ops/jobs) and runs the ones it knows
  box-ops.py oneshots  runs each deploy/ops.d/*.sh once, ever, and keeps what it printed
  box-ops.py report    posts what the box looks like to the api (GET /ops/status shows it under "box")

It talks to the api on loopback with the key from ~/conf-tracker/.env, so nothing here is reachable from outside the
box except through the api's own bearer key. A job is one of the fixed verbs below, never a shell line. Standard
library only, and written for an old python3: the box's system interpreter is whatever Ubuntu shipped.
"""
import json
import os
import re
import subprocess
import sys
import time
import urllib.error
import urllib.request

HOME = os.path.expanduser("~")
CLONE = os.environ.get("CLONE", os.path.join(HOME, "projects", "conf-tracker"))
STACK = os.environ.get("STACK", os.path.join(HOME, "conf-tracker"))
API = os.environ.get("API", "http://127.0.0.1:8094").rstrip("/")
SPEECH_DATA = os.environ.get("SPEECH_DATA", os.path.join(HOME, "yt-stream", "data"))
SPEECH_LOG = os.environ.get("SPEECH_LOG", os.path.join(HOME, "yt-stream", "speech.log"))
SPEECH_HEALTH = os.environ.get("SPEECH_HEALTH", "http://172.17.0.1:8100/healthz")
NGROK_API = os.environ.get("NGROK_API", "http://127.0.0.1:4044/api/tunnels")

SERVICES = ("api", "llm-proxy", "web", "postgres")
# What set-env may change, and the container that reads it. The api key and the database password are not here on
# purpose: changing either from outside would lock the outside out.
ENV_KEYS = {"CLAUDE_CODE_OAUTH_TOKEN": "llm-proxy", "LOG_LEVEL": "api", "ACCESS_PASSWORD": "web"}
LOG_FILES = {
    "deploy": os.path.join(STACK, "deploy.log"),
    "ngrok": os.path.join(STACK, "ngrok.log"),
    "ops": os.path.join(STACK, "box-ops.log"),
    "speech": SPEECH_LOG,
}
UUID = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$")
MAX_OUTPUT = 300000


def read_env():
    values = {}
    try:
        with open(os.path.join(STACK, ".env")) as handle:
            for line in handle:
                line = line.strip()
                if not line or line.startswith("#") or "=" not in line:
                    continue
                key, value = line.split("=", 1)
                value = value.strip()
                if len(value) >= 2 and value[0] == value[-1] and value[0] in "'\"":
                    value = value[1:-1]
                values[key.strip()] = value
    except OSError:
        pass
    return values


def call(method, path, body=None, timeout=15):
    """One request to the api. Returns (status, parsed body or None); status 0 when it could not be reached."""
    data = None if body is None else json.dumps(body).encode()
    request = urllib.request.Request(API + path, data=data, method=method)
    request.add_header("authorization", "Bearer " + read_env().get("API_SHARED_SECRET", ""))
    request.add_header("content-type", "application/json")
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            raw = response.read()
            return response.status, (json.loads(raw.decode()) if raw else None)
    except urllib.error.HTTPError as error:
        return error.code, None
    except Exception:
        return 0, None


def run(args, timeout=60, cwd=None):
    """A command's exit code and everything it printed. Never raises."""
    try:
        done = subprocess.run(args, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, timeout=timeout, cwd=cwd)
        return done.returncode, done.stdout.decode(errors="replace")
    except subprocess.TimeoutExpired as error:
        return 124, (error.stdout or b"").decode(errors="replace") + "\n(timed out after %ds)" % timeout
    except Exception as error:
        return 127, str(error)


def compose(*args, **kwargs):
    return run(["docker", "compose"] + list(args), cwd=STACK, **kwargs)


def tail_file(path, lines):
    try:
        with open(path, "rb") as handle:
            handle.seek(0, 2)
            size = handle.tell()
            handle.seek(max(0, size - 400 * lines))
            return "\n".join(handle.read().decode(errors="replace").splitlines()[-lines:])
    except OSError as error:
        return "(%s)" % error


def read_file(path):
    try:
        with open(path) as handle:
            return handle.read().strip()
    except OSError:
        return None


def number(value, default, low, high):
    try:
        return max(low, min(high, int(value)))
    except (TypeError, ValueError):
        return default


def set_env(key, value):
    """Rewrites one line of .env through a temporary file, so a crash never leaves half a file."""
    path = os.path.join(STACK, ".env")
    if not re.match(r"^[A-Za-z0-9_.:/+=@%,~-]*$", value):
        value = "'" + value + "'"
    with open(path) as handle:
        lines = handle.read().splitlines()
    replaced = False
    for index, line in enumerate(lines):
        if line.split("=", 1)[0].strip() == key:
            lines[index] = key + "=" + value
            replaced = True
    if not replaced:
        lines.append(key + "=" + value)
    temporary = path + ".new"
    handle = os.fdopen(os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600), "w")
    with handle:
        handle.write("\n".join(lines) + "\n")
    os.replace(temporary, path)


def do_job(verb, args):
    """Returns (ok, output). Every verb is a fixed action on this stack; anything else is refused."""
    if verb == "ps":
        code, out = compose("ps", "-a")
        return code == 0, out
    if verb == "logs":
        service = args.get("service")
        if service not in SERVICES:
            return False, "service: one of " + ", ".join(SERVICES)
        code, out = compose("logs", "--no-color", "--tail", str(number(args.get("lines"), 200, 1, 3000)), service)
        return code == 0, out
    if verb == "tail":
        path = LOG_FILES.get(args.get("file"))
        if not path:
            return False, "file: one of " + ", ".join(sorted(LOG_FILES))
        return True, tail_file(path, number(args.get("lines"), 100, 1, 3000))
    if verb == "resources":
        parts = []
        for title, command in (
            ("disk", ["df", "-h", "/", HOME]),
            ("memory", ["free", "-h"]),
            ("gpu", ["nvidia-smi"]),
            ("recordings", ["du", "-sh", SPEECH_DATA]),
            ("docker", ["docker", "system", "df"]),
            ("load", ["uptime"]),
        ):
            parts.append("## %s\n%s" % (title, run(command, timeout=60)[1].strip()))
        return True, "\n\n".join(parts)
    if verb == "restart":
        service = args.get("service")
        if service not in SERVICES:
            return False, "service: one of " + ", ".join(SERVICES)
        code, out = compose("restart", service, timeout=180)
        return code == 0, out
    if verb == "deploy-now":
        open(os.path.join(STACK, ".force"), "w").close()
        return True, "the next deploy will not wait for running videos to end"
    if verb == "redeploy":
        for name in (".deployed", ".failed"):
            try:
                os.remove(os.path.join(STACK, name))
            except OSError:
                pass
        return True, "forgot what is deployed; this pass rebuilds every image from main (held back while a video runs, unless deploy-now)"
    if verb == "set-env":
        key, value = args.get("key"), args.get("value")
        if key not in ENV_KEYS:
            return False, "key: one of " + ", ".join(sorted(ENV_KEYS))
        if not isinstance(value, str) or not value or "\n" in value or "\r" in value or "'" in value:
            return False, "value: one line of text with no single quote"
        set_env(key, value)
        code, out = compose("up", "-d", "--no-deps", "--no-build", ENV_KEYS[key], timeout=180)
        return code == 0, "%s written; %s recreated\n%s" % (key, ENV_KEYS[key], out)
    if verb == "prune":
        _, images = run(["docker", "image", "prune", "-f", "--filter", "label=com.docker.compose.project=conf-tracker"], timeout=300)
        _, cache = run(["docker", "builder", "prune", "-f", "--filter", "until=48h"], timeout=300)
        return True, images + "\n" + cache
    if verb == "ngrok-restart":
        code, out = run(["pkill", "-f", "ngrok http --config " + os.path.join(STACK, "ngrok.yml")])
        return code == 0, out or ("the tunnel was stopped; run-ngrok.sh starts it again in five seconds" if code == 0 else "no ngrok process of this stack was found")
    if verb == "speech-restart":
        if args.get("confirm") != "ends-every-running-video":
            return False, 'confirm: "ends-every-running-video"'
        code, out = run(["pkill", "-f", "python -m speech.server"])
        return code == 0, out or ("speech was stopped; run-speech.sh starts it again in five seconds" if code == 0 else "no speech process was found")
    if verb == "recordings-clean":
        removed, missing = [], []
        for session_id in args.get("session_ids") or []:
            if not isinstance(session_id, str) or not UUID.match(session_id):
                return False, "session_ids: uuids only"
            path = os.path.join(SPEECH_DATA, session_id, "audio.raw")
            try:
                size = os.path.getsize(path)
                os.remove(path)
                removed.append("%s (%.1f GB)" % (session_id, size / 1e9))
            except OSError:
                missing.append(session_id)
        return True, "removed: %s\nnot there: %s" % (", ".join(removed) or "none", ", ".join(missing) or "none")
    return False, "this box does not know the verb %r" % verb


def finish(job_id, ok, output):
    # The job may have restarted the api itself, so the answer waits for it to come back.
    body = {"ok": ok, "output": output[-MAX_OUTPUT:]}
    for _ in range(30):
        status, _body = call("POST", "/ops/jobs/%s/result" % job_id, body)
        if status and status < 500:
            return
        time.sleep(5)


def jobs():
    for _ in range(10):
        status, job = call("POST", "/ops/jobs/claim")
        if status != 200 or not job:
            return
        try:
            ok, output = do_job(job.get("verb"), job.get("args") or {})
        except Exception as error:  # a broken verb must still answer, or the job stays "running" for ever
            ok, output = False, "box-ops failed: %r" % error
        print("[%s] job %s %s -> %s" % (time.strftime("%FT%T"), job.get("id"), job.get("verb"), "ok" if ok else "failed"))
        finish(job.get("id"), ok, output)


def oneshots():
    """Each deploy/ops.d/*.sh runs once, in name order, the first pass after it reaches main. Its name is recorded
    before it starts, so a script that hangs or kills the pass is never run twice."""
    directory = os.path.join(CLONE, "deploy", "ops.d")
    done_path = os.path.join(STACK, ".ops-done")
    done = set((read_file(done_path) or "").split())
    try:
        names = sorted(name for name in os.listdir(directory) if name.endswith(".sh"))
    except OSError:
        return
    out_dir = os.path.join(STACK, "ops-out")
    for name in names:
        if name in done:
            continue
        os.makedirs(out_dir, exist_ok=True)
        with open(done_path, "a") as handle:
            handle.write(name + "\n")
        code, output = run(["bash", os.path.join(directory, name)], timeout=600, cwd=STACK)
        with open(os.path.join(out_dir, name + ".log"), "w") as handle:
            handle.write("exit %d at %s\n%s" % (code, time.strftime("%FT%T%z"), output[-MAX_OUTPUT:]))
        print("[%s] one-shot %s -> exit %d" % (time.strftime("%FT%T"), name, code))


def fetch(url):
    try:
        with urllib.request.urlopen(url, timeout=4) as response:
            return response.read().decode(errors="replace")
    except Exception as error:
        return "(%s)" % error


def report():
    def text(args, timeout=15, cwd=None):
        return run(args, timeout=timeout, cwd=cwd)[1].strip()

    tunnels = fetch(NGROK_API)
    try:
        tunnels = [tunnel.get("public_url") for tunnel in json.loads(tunnels).get("tunnels", [])]
    except ValueError:
        pass
    out_dir = os.path.join(STACK, "ops-out")
    try:
        newest = sorted(os.listdir(out_dir), key=lambda name: os.path.getmtime(os.path.join(out_dir, name)))[-5:]
    except OSError:
        newest = []
    body = {
        "at": time.strftime("%FT%T%z"),
        # The commit whose images are running, the commit the clone holds, and what is in the way of the two meeting.
        "deployed": read_file(os.path.join(STACK, ".deployed")),
        "clone_head": text(["git", "rev-parse", "HEAD"], cwd=CLONE),
        "origin_main": text(["git", "rev-parse", "origin/main"], cwd=CLONE),
        "clone_dirty": text(["git", "status", "--porcelain"], cwd=CLONE)[:500],
        "held_back": read_file(os.path.join(STACK, ".deferred")),
        "failed": read_file(os.path.join(STACK, ".failed")),
        "force_waiting": os.path.exists(os.path.join(STACK, ".force")),
        "deploy_log": tail_file(os.path.join(STACK, "deploy.log"), 25),
        "containers": text(["docker", "compose", "ps", "-a", "--format", "table {{.Service}}\t{{.State}}\t{{.Status}}"], cwd=STACK),
        "disk": text(["df", "-h", "--output=target,size,used,avail,pcent", "/", HOME]),
        "memory": text(["free", "-h"]),
        "load": text(["uptime"]),
        "gpu": text(["nvidia-smi", "--query-gpu=name,memory.used,memory.total,utilization.gpu,temperature.gpu", "--format=csv,noheader"]),
        "recordings": text(["du", "-sh", SPEECH_DATA], timeout=30),
        "speech_health": fetch(SPEECH_HEALTH)[:300],
        "speech_log": tail_file(SPEECH_LOG, 12),
        "ngrok_tunnels": tunnels,
        "ngrok_log": tail_file(os.path.join(STACK, "ngrok.log"), 5),
        "proxy_log": text(["docker", "compose", "logs", "--no-color", "--tail", "15", "llm-proxy"], cwd=STACK)[-4000:],
        "api_log": text(["docker", "compose", "logs", "--no-color", "--tail", "15", "api"], cwd=STACK)[-4000:],
        "oneshots": dict((name, (read_file(os.path.join(out_dir, name)) or "")[-3000:]) for name in newest),
        "compose_version": text(["docker", "compose", "version", "--short"]),
    }
    call("POST", "/ops/box-report", body)


def trim_own_log():
    path = os.path.join(STACK, "box-ops.log")
    try:
        if os.path.getsize(path) > 2000000:
            kept = tail_file(path, 2000)
            with open(path, "w") as handle:
                handle.write(kept + "\n")
    except OSError:
        pass


if __name__ == "__main__":
    mode = sys.argv[1] if len(sys.argv) > 1 else ""
    if mode == "jobs":
        jobs()
    elif mode == "oneshots":
        oneshots()
    elif mode == "report":
        trim_own_log()
        report()
    else:
        sys.exit("usage: box-ops.py jobs|oneshots|report")
