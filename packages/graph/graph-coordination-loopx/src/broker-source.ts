/** Python source for the persistent LoopX CLI stdio broker. @module @deepseek-ai/dsh-graph-coordination-loopx/broker-source */

/**
 * Version-one newline-delimited broker. The launcher keeps one execution-world
 * bridge alive while each LoopX CLI invocation retains its own process,
 * timeout, output bounds, and cancellation.
 */
export const LOOPX_BROKER_SOURCE = String.raw`
import base64
import json
import queue
import subprocess
import sys
import threading
import time

PROTOCOL = 1
COMMAND = json.loads(sys.argv[1])
requests = queue.Queue()
active = {}
cancelled = set()
lock = threading.RLock()
stopping = threading.Event()

def send(value):
    data = json.dumps(value, separators=(",", ":"), ensure_ascii=True)
    with lock:
        sys.stdout.write(data + "\n")
        sys.stdout.flush()

def retain(pipe, maximum, result):
    kept = bytearray()
    lossy = False
    while True:
        chunk = pipe.read(65536)
        if not chunk:
            break
        kept.extend(chunk)
        if len(kept) > maximum:
            del kept[:len(kept) - maximum]
            lossy = True
    result.append((bytes(kept), lossy))

def stop_process(process, grace_seconds):
    if process.poll() is not None:
        return
    process.terminate()
    try:
        process.wait(timeout=grace_seconds)
    except subprocess.TimeoutExpired:
        process.kill()
        process.wait()

def execute(request):
    request_id = request["id"]
    with lock:
        if request_id in cancelled or stopping.is_set():
            cancelled.discard(request_id)
            send_cancelled = True
        else:
            send_cancelled = False
    if send_cancelled:
        send({"type":"response","protocol":PROTOCOL,"id":request_id,"cancelled":True})
        return
    try:
        process = subprocess.Popen(
            [*COMMAND, *request["args"]],
            cwd=request["cwd"],
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
        )
    except OSError as error:
        send({"type":"response","protocol":PROTOCOL,"id":request_id,"spawnError":str(error)})
        return
    cancel = threading.Event()
    with lock:
        active[request_id] = (process, cancel)
        if request_id in cancelled or stopping.is_set():
            cancel.set()
            cancelled.discard(request_id)
    stdout_result = []
    stderr_result = []
    stdout_thread = threading.Thread(target=retain, args=(process.stdout, request["stdoutMaxBytes"], stdout_result))
    stderr_thread = threading.Thread(target=retain, args=(process.stderr, request["stderrMaxBytes"], stderr_result))
    stdout_thread.start()
    stderr_thread.start()
    deadline = time.monotonic() + request["timeoutMs"] / 1000.0
    timed_out = False
    was_cancelled = False
    while process.poll() is None:
        if cancel.is_set() or stopping.is_set():
            was_cancelled = True
            stop_process(process, request["graceMs"] / 1000.0)
            break
        if time.monotonic() >= deadline:
            timed_out = True
            stop_process(process, request["graceMs"] / 1000.0)
            break
        time.sleep(0.02)
    stdout_thread.join()
    stderr_thread.join()
    with lock:
        active.pop(request_id, None)
        cancelled.discard(request_id)
    stdout, stdout_lossy = stdout_result[0]
    stderr, stderr_lossy = stderr_result[0]
    send({
        "type":"response",
        "protocol":PROTOCOL,
        "id":request_id,
        "exitCode":process.returncode,
        "timedOut":timed_out,
        "cancelled":was_cancelled,
        "stdout":base64.b64encode(stdout).decode("ascii"),
        "stderr":base64.b64encode(stderr).decode("ascii"),
        "stdoutLossy":stdout_lossy,
        "stderrLossy":stderr_lossy,
    })

def worker():
    while True:
        request = requests.get()
        if request is None:
            return
        execute(request)

thread = threading.Thread(target=worker)
thread.start()
send({"type":"ready","protocol":PROTOCOL})
for line in sys.stdin:
    try:
        message = json.loads(line)
    except json.JSONDecodeError as error:
        send({"type":"protocolError","protocol":PROTOCOL,"message":str(error)})
        continue
    if message.get("protocol") != PROTOCOL:
        send({"type":"protocolError","protocol":PROTOCOL,"message":"unsupported protocol"})
        continue
    if message.get("type") == "request":
        requests.put(message)
    elif message.get("type") == "cancel":
        request_id = message.get("id")
        with lock:
            cancelled.add(request_id)
            current = active.get(request_id)
            if current is not None:
                current[1].set()
    else:
        send({"type":"protocolError","protocol":PROTOCOL,"message":"unsupported message type"})
stopping.set()
with lock:
    for process, cancel in active.values():
        cancel.set()
requests.put(None)
thread.join()
`
