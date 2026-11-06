"""Serves dist/, the built site, and makes the browser revalidate every file.

python's http.server sends Last-Modified and no Cache-Control, so browsers cache
index.html heuristically and keep running an old build after a rebuild.

It is also the transcript recorder (plan D18). `GET /runs/` says it is one, and the page then
writes each conversation to runs/<id>.json with `PUT` as it grows. Only this page can write:
the Host must be this server's own, a cross-origin request is refused (a `PUT` with a JSON body
needs a preflight, which this server never grants), and a body must be a transcript.

It also feeds a queue of questions (D18). Each line of runs/queue.jsonl is a case, {"case":
id, "run": n, "messages": [text, …], "turns": n}; `GET /runs/next` hands out the first line and
removes it, or answers 204 when none is left. The page asks for it when opened with `?queue`,
and runs each case in a fresh session and conversation. test/enqueue.py writes the file.
"""

import http.server
import json
import os
import re
import sys
import threading
from pathlib import Path

HERE = Path(__file__).parent
RUNS = HERE / "runs"
QUEUE = RUNS / "queue.jsonl"
NAME = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,200}\.json$")
MAX_BYTES = 256 * 2**20
SCHEMA = "kgf-explorer.transcript/0"


LOCK = threading.Lock()


def queued() -> list[str]:
    """The cases still waiting, one JSON object a line."""
    if not QUEUE.is_file():
        return []
    return [line for line in QUEUE.read_text().splitlines() if line.strip()]


class Site(http.server.SimpleHTTPRequestHandler):
    port = 8765

    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(HERE / "dist"), **kwargs)

    def end_headers(self) -> None:
        self.send_header("Cache-Control", "no-cache")
        super().end_headers()

    def answer(self, status: int, body: dict | None = None) -> None:
        data = json.dumps(body).encode() if body is not None else b""
        self.send_response(status)
        if body is not None:
            self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def own(self) -> bool:
        """The request came from this page: our Host (no rebinding), our origin or none, and,
        where the browser says where a request came from, this site (an <img> sends no Origin)."""
        hosts = {f"127.0.0.1:{self.port}", f"localhost:{self.port}"}
        host = self.headers.get("Host", "")
        origin = self.headers.get("Origin")
        site = self.headers.get("Sec-Fetch-Site")
        return host in hosts and (origin is None or origin == f"http://{host}") and site in (None, "same-origin", "none")

    def do_GET(self) -> None:
        path = self.path.split("?")[0]
        if path not in ("/runs/", "/runs/next"):
            super().do_GET()
        elif not self.own():
            self.answer(403, {"error": "not this page"})
        elif path == "/runs/next":
            self.next_case()
        else:
            runs = sorted(p.name for p in RUNS.glob("*.json")) if RUNS.is_dir() else []
            self.answer(200, {"recorder": "kgf-explorer", "dir": "runs", "runs": runs, "queued": len(queued())})

    def next_case(self) -> None:
        with LOCK:
            lines = queued()
            if not lines:
                self.answer(204)
                return
            part = RUNS / ".queue.jsonl.part"
            part.write_text("".join(line + "\n" for line in lines[1:]))
            os.replace(part, QUEUE)
        try:
            self.answer(200, json.loads(lines[0]))
        except json.JSONDecodeError as error:
            self.answer(422, {"error": f"queue line is not JSON: {error}", "line": lines[0][:200]})

    def do_PUT(self) -> None:
        path = self.path.split("?")[0]
        name = path.removeprefix("/runs/")
        if not path.startswith("/runs/") or not NAME.match(name):
            self.answer(404, {"error": "transcripts go to /runs/<id>.json"})
            return
        if not self.own():
            self.answer(403, {"error": "not this page"})
            return
        if self.headers.get("Content-Type", "").split(";")[0].strip() != "application/json":
            self.answer(415, {"error": "a transcript is application/json"})
            return
        length = int(self.headers.get("Content-Length") or 0)
        if length > MAX_BYTES:
            self.answer(413, {"error": f"over {MAX_BYTES} bytes"})
            return
        data = self.rfile.read(length)
        try:
            schema = json.loads(data).get("schema")
        except (json.JSONDecodeError, AttributeError):
            schema = None
        if schema != SCHEMA:
            self.answer(422, {"error": f"not a {SCHEMA}"})
            return
        RUNS.mkdir(exist_ok=True)
        part = RUNS / f".{name}.part"
        part.write_bytes(data)
        os.replace(part, RUNS / name)
        self.answer(204)


if __name__ == "__main__":
    Site.port = int(sys.argv[1]) if len(sys.argv) > 1 else 8765
    http.server.ThreadingHTTPServer(("127.0.0.1", Site.port), Site).serve_forever()
