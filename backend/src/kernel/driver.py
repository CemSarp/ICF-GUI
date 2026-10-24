"""ICF Control Center kernel driver (ADR-031). Runs inside an srun step on the allocated node.

Relays between the app (JSON lines on stdin/stdout, carried by the app's SSH session) and one
ipykernel started here over IPC sockets in a private 0700 directory: no TCP port, no server, no
token outside this process tree. Exits on stdin EOF, "stop", SIGTERM/SIGHUP, kernel death or
IDLE_SECS without an execution.
"""
import json
import os
import queue
import secrets
import shutil
import signal
import subprocess
import sys
import tempfile
import threading
import time

IDLE_SECS = 30 * 60
MAX_PAYLOAD = 2 * 1024 * 1024
OUT = sys.stdout
OUT_LOCK = threading.Lock()
TERM = []  # set by SIGTERM/SIGHUP; checked by the main loop (never write from a signal handler)


def emit(obj):
    line = json.dumps(obj, separators=(",", ":"), ensure_ascii=True)
    with OUT_LOCK:
        OUT.write(line + "\n")
        OUT.flush()


def bye(reason, code=0):
    try:
        emit({"t": "bye", "reason": reason})
    except Exception:
        pass
    raise SystemExit(code)


try:
    from jupyter_client import BlockingKernelClient
    from jupyter_client.connect import write_connection_file
except Exception:
    bye("jupyter_client_missing", 3)


def capped(data):
    """Large MIME payloads become a short notice so one plot cannot flood the connection."""
    out = {}
    for mime, value in (data or {}).items():
        text = value if isinstance(value, str) else json.dumps(value)
        if len(text) > MAX_PAYLOAD:
            out = {"text/plain": "[output of %d bytes not shown: larger than %d MiB]" % (len(text), MAX_PAYLOAD // 1048576)}
            break
        out[mime] = value
    return out


def to_output(msg_type, c):
    """nbformat v4 output dict for one iopub message, or None."""
    if msg_type == "stream":
        text = c.get("text", "")
        if len(text) > MAX_PAYLOAD:
            text = text[:MAX_PAYLOAD] + "\n[stream output truncated]"
        return {"output_type": "stream", "name": c.get("name", "stdout"), "text": text}
    if msg_type in ("display_data", "update_display_data"):
        return {"output_type": "display_data", "data": capped(c.get("data")), "metadata": c.get("metadata", {})}
    if msg_type == "execute_result":
        return {"output_type": "execute_result", "data": capped(c.get("data")), "metadata": c.get("metadata", {}), "execution_count": c.get("execution_count")}
    if msg_type == "error":
        return {"output_type": "error", "ename": c.get("ename", ""), "evalue": c.get("evalue", ""), "traceback": c.get("traceback", [])[:200]}
    return None


class Kernel:
    def __init__(self):
        # Short node-local path: IPC socket paths must stay under ~100 characters.
        self.dir = tempfile.mkdtemp(prefix="icfcc-kernel-", dir="/tmp" if os.path.isdir("/tmp") else None)
        os.chmod(self.dir, 0o700)
        self.proc = None
        self.client = None

    def start(self):
        cf = os.path.join(self.dir, "kernel.json")
        if os.path.exists(cf):
            os.remove(cf)
        write_connection_file(cf, transport="ipc", ip=os.path.join(self.dir, "k"), key=secrets.token_hex(32).encode())
        env = dict(os.environ)
        env.pop("ICFCC_DRIVER", None)
        self.proc = subprocess.Popen(
            [sys.executable, "-m", "ipykernel_launcher", "-f", cf],
            stdin=subprocess.DEVNULL,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            env=env,
            cwd=os.getcwd(),
        )
        self.client = BlockingKernelClient(connection_file=cf)
        self.client.load_connection_file()
        self.client.start_channels()
        self.client.wait_for_ready(timeout=120)

    def alive(self):
        return self.proc is not None and self.proc.poll() is None

    def interrupt(self):
        if self.alive():
            self.proc.send_signal(signal.SIGINT)

    def shutdown(self):
        if self.client is not None:
            try:
                self.client.shutdown()
            except Exception:
                pass
            try:
                self.client.stop_channels()
            except Exception:
                pass
            self.client = None
        if self.proc is not None:
            try:
                self.proc.wait(timeout=5)
            except Exception:
                self.proc.kill()
                self.proc.wait()
            self.proc = None

    def cleanup(self):
        self.shutdown()
        shutil.rmtree(self.dir, ignore_errors=True)


def read_stdin(q):
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            msg = json.loads(line)
        except ValueError:
            continue
        if isinstance(msg, dict):
            q.put(msg)
    q.put({"t": "eof"})


def main():
    signal.signal(signal.SIGTERM, lambda *_: TERM.append(1))
    signal.signal(signal.SIGHUP, lambda *_: TERM.append(1))
    commands = queue.Queue()
    k = Kernel()
    try:
        try:
            k.start()
        except Exception as e:
            bye("kernel_start_failed: " + type(e).__name__, 3)
        emit({
            "t": "ready",
            "job": os.environ.get("SLURM_JOB_ID", ""),
            "node": os.environ.get("SLURMD_NODENAME", ""),
            "python": sys.version.split()[0],
        })
        threading.Thread(target=read_stdin, args=(commands,), daemon=True).start()
        loop(k, commands)
    finally:
        k.cleanup()


def loop(k, commands):
    pending = {}  # kernel msg_id -> app request id
    last_activity = time.monotonic()
    busy = False
    while True:
        if TERM:
            bye("terminated")
        try:
            cmd = commands.get(timeout=0.05 if pending else 0.5)
        except queue.Empty:
            cmd = None
        if cmd is not None:
            t = cmd.get("t")
            if t in ("eof", "stop"):
                bye("stopped" if t == "stop" else "eof")
            elif t == "exec" and isinstance(cmd.get("id"), str) and isinstance(cmd.get("code"), str):
                msg_id = k.client.execute(cmd["code"], allow_stdin=False, stop_on_error=True)
                pending[msg_id] = cmd["id"]
                last_activity = time.monotonic()
            elif t == "interrupt":
                k.interrupt()
            elif t == "restart":
                for rid in pending.values():
                    emit({"t": "done", "id": rid, "count": None, "status": "aborted"})
                pending.clear()
                k.shutdown()
                try:
                    k.start()
                except Exception as e:
                    bye("kernel_start_failed: " + type(e).__name__, 3)
                busy = False
                emit({"t": "restarted"})
                last_activity = time.monotonic()

        while True:
            try:
                msg = k.client.get_iopub_msg(timeout=0)
            except queue.Empty:
                break
            parent = msg.get("parent_header", {}).get("msg_id")
            rid = pending.get(parent)
            mt = msg.get("msg_type")
            c = msg.get("content", {})
            if mt == "status":
                now_busy = c.get("execution_state") == "busy"
                if now_busy != busy:
                    busy = now_busy
                    emit({"t": "status", "busy": busy})
                continue
            if rid is None:
                continue
            if mt == "clear_output":
                emit({"t": "clear", "id": rid, "wait": bool(c.get("wait"))})
                continue
            out = to_output(mt, c)
            if out is not None:
                emit({"t": "out", "id": rid, "output": out})

        while True:
            try:
                reply = k.client.get_shell_msg(timeout=0)
            except queue.Empty:
                break
            parent = reply.get("parent_header", {}).get("msg_id")
            rid = pending.pop(parent, None)
            if rid is not None and reply.get("msg_type") == "execute_reply":
                c = reply.get("content", {})
                emit({"t": "done", "id": rid, "count": c.get("execution_count"), "status": c.get("status", "ok")})
                last_activity = time.monotonic()

        if not k.alive():
            for rid in pending.values():
                emit({"t": "done", "id": rid, "count": None, "status": "aborted"})
            bye("kernel_died")
        if not pending and not busy and time.monotonic() - last_activity > IDLE_SECS:
            bye("idle_timeout")


if __name__ == "__main__":
    main()
