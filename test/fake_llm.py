"""A stand-in OpenAI-compatible chat endpoint for testing the page's turn loop without a key.

Every request asks for one `list_graphs` call, unless it sets tool_choice "none", in which
case it answers in text. GET /log returns what each request carried.
"""

import json
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

LOG: list[dict] = []

# The closing answer exercises the page's Markdown rendering, including two injection attempts
# that must come out inert.
MARKDOWN_ANSWER = """**44 graphs** are listed in (t1). A few, by *size*:

- `babel` — 1.51 B triples
- `kwg-hazards` — 1.28 B triples
- see [the KGF endpoint](https://apps.okn.us/kgf) for all of them

| graph | triples |
|---|---|
| scales | 1.08 B |

Not a table ref: t99. Code stays code: `t1`.

<img src=x onerror="window.__pwned = 1"> [click](javascript:window.__pwned=2)"""


class Fake(BaseHTTPRequestHandler):
    def cors(self) -> None:
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header(
            "Access-Control-Allow-Headers", self.headers.get("Access-Control-Request-Headers", "*")
        )

    def reply(self, body: dict) -> None:
        data = json.dumps(body).encode()
        self.send_response(200)
        self.cors()
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_OPTIONS(self) -> None:
        self.send_response(204)
        self.cors()
        self.end_headers()

    def do_GET(self) -> None:
        self.reply({"requests": LOG})

    def do_POST(self) -> None:
        body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
        closing = body.get("tool_choice") == "none"
        last = body["messages"][-1]
        LOG.append({"tool_choice": body.get("tool_choice"), "last_role": last["role"],
                    "last_content": str(last.get("content"))[:160], "messages": len(body["messages"])})
        n = len(LOG)
        if closing:
            message = {"role": "assistant", "content": MARKDOWN_ANSWER}
        else:
            message = {"role": "assistant", "content": None, "tool_calls": [{
                "id": f"call_{n}", "type": "function",
                "function": {"name": "list_graphs", "arguments": "{}"}}]}
        self.reply({"id": f"fake-{n}", "object": "chat.completion", "created": 0, "model": body["model"],
                    "choices": [{"index": 0, "message": message,
                                 "finish_reason": "stop" if closing else "tool_calls"}]})

    def log_message(self, *args) -> None:
        pass


ThreadingHTTPServer(("127.0.0.1", 8766), Fake).serve_forever()
