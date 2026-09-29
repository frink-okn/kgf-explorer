"""A metering proxy between the page and a real OpenAI-compatible model server.

The page's custom provider points here; every chat-completions request goes on to --upstream
unchanged, except for the fields --set adds. Each request is logged as one JSON line in
--out/requests.jsonl, with its full body in --out/bodies/, so a conversation can be replayed:

  tokens    usage as the server reported it; wall time
  calls     each tool call: arguments parsed, checked against the tool's schema as the
            request stated it, and any IRI in them that no system, user or tool message of
            that request contained ("unseen": invented, or expanded from a prefix)

GET /log returns every record. Unlike fake_llm.py, the model here is real.

  python3 test/meter_llm.py --upstream http://127.0.0.1:11435 --out /tmp/run1
"""

import argparse
import hashlib
import json
import re
import sys
import time
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

IRI = re.compile(r"https?://[^\s\"'<>\\`|)\]]+")
LOG: list[dict] = []


def text_of(content) -> str:
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        return " ".join(part.get("text", "") for part in content if isinstance(part, dict))
    return ""


def schema_errors(value, schema: dict, path: str = "") -> list[str]:
    """The subset of JSON Schema the page's tools use."""
    errors = []
    kind = schema.get("type")
    checks = {"object": dict, "array": list, "string": str, "boolean": bool}
    if kind == "integer":
        if not isinstance(value, int) or isinstance(value, bool):
            return [f"{path or 'input'}: expected integer, got {json.dumps(value)[:40]}"]
    elif kind in checks and not isinstance(value, checks[kind]):
        return [f"{path or 'input'}: expected {kind}, got {json.dumps(value)[:40]}"]
    if "enum" in schema and value not in schema["enum"]:
        errors.append(f"{path}: {json.dumps(value)} not in {schema['enum']}")
    if isinstance(value, (int, float)) and "minimum" in schema and value < schema["minimum"]:
        errors.append(f"{path}: {value} below minimum {schema['minimum']}")
    if isinstance(value, (int, float)) and "maximum" in schema and value > schema["maximum"]:
        errors.append(f"{path}: {value} above maximum {schema['maximum']}")
    if kind == "array":
        if len(value) < schema.get("minItems", 0) or len(value) > schema.get("maxItems", len(value)):
            errors.append(f"{path}: {len(value)} items")
        for i, item in enumerate(value):
            errors += schema_errors(item, schema.get("items", {}), f"{path}[{i}]")
    if kind == "object":
        props = schema.get("properties", {})
        for key in schema.get("required", []):
            if key not in value:
                errors.append(f"{path}.{key}: required, missing")
        for key, item in value.items():
            if key in props:
                errors += schema_errors(item, props[key], f"{path}.{key}")
            elif schema.get("additionalProperties") is False:
                errors.append(f"{path}.{key}: not a property of this tool")
    return errors


def examine(body: dict, response: dict) -> dict:
    messages = body.get("messages", [])
    seen = set()
    for m in messages:
        if m.get("role") in ("system", "user", "tool"):
            seen.update(IRI.findall(text_of(m.get("content"))))
    tools = {t["function"]["name"]: t["function"].get("parameters", {}) for t in body.get("tools", [])}
    choice = (response.get("choices") or [{}])[0]
    message = choice.get("message") or {}
    calls = []
    for call in message.get("tool_calls") or []:
        fn = call.get("function", {})
        record = {"name": fn.get("name"), "arguments": fn.get("arguments", "")[:400]}
        if fn.get("name") not in tools:
            record["errors"] = ["unknown tool"]
        else:
            try:
                args = json.loads(fn.get("arguments") or "{}")
                record["errors"] = schema_errors(args, tools[fn["name"]])
                unseen = sorted({i for i in IRI.findall(json.dumps(args)) if i not in seen})
                if unseen:
                    record["unseen_iris"] = unseen
            except json.JSONDecodeError as error:
                record["errors"] = [f"arguments not JSON: {error}"]
        calls.append(record)
    # The tool results this request delivers: those after the last assistant message.
    delivered = []
    for m in reversed(messages):
        if m.get("role") == "assistant":
            break
        if m.get("role") == "tool":
            delivered.append(text_of(m.get("content")))
    first_user = next((text_of(m.get("content")) for m in messages if m.get("role") == "user"), "")
    return {
        "model": body.get("model"),
        "conversation": hashlib.sha1(first_user.encode()).hexdigest()[:8],
        "returned_errors": sum(1 for t in delivered if '"contract": "error"' in t or '"contract":"error"' in t or t.startswith('{"error"')),
        "messages": len(messages),
        "request_chars": len(json.dumps(messages)),
        "last_role": messages[-1].get("role") if messages else None,
        "tool_choice": body.get("tool_choice"),
        "finish_reason": choice.get("finish_reason"),
        "usage": response.get("usage"),
        "content_chars": len(message.get("content") or ""),
        "reasoning_chars": len(message.get("reasoning") or message.get("reasoning_content") or ""),
        "content_head": (message.get("content") or "")[:200],
        "calls": calls,
    }


class Meter(BaseHTTPRequestHandler):
    upstream: str
    out: Path
    extra: dict

    def cors(self) -> None:
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", self.headers.get("Access-Control-Request-Headers", "*"))

    def reply(self, status: int, data: bytes, content_type: str = "application/json") -> None:
        self.send_response(status)
        self.cors()
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_OPTIONS(self) -> None:
        self.send_response(204)
        self.cors()
        self.end_headers()

    def do_GET(self) -> None:
        self.reply(200, json.dumps(LOG).encode())

    def do_POST(self) -> None:
        body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
        body.update(self.extra)
        n = len(LOG) + 1
        (self.out / "bodies" / f"{n:04d}.json").write_text(json.dumps(body))
        request = urllib.request.Request(self.upstream + self.path, data=json.dumps(body).encode(),
                                         headers={"Content-Type": "application/json"}, method="POST")
        started = time.time()
        try:
            with urllib.request.urlopen(request, timeout=900) as upstream:
                status, data = upstream.status, upstream.read()
        except urllib.error.HTTPError as error:
            status, data = error.code, error.read()
        record = {"n": n, "at": time.strftime("%H:%M:%S"), "status": status, "wall_ms": round((time.time() - started) * 1000)}
        try:
            record.update(examine(body, json.loads(data)) if status == 200 else {"error": data.decode()[:400]})
        except (json.JSONDecodeError, KeyError, TypeError) as error:
            record["examine_error"] = repr(error)
        LOG.append(record)
        with open(self.out / "requests.jsonl", "a") as log:
            log.write(json.dumps(record) + "\n")
        usage = record.get("usage") or {}
        bad = sum(1 for c in record.get("calls", []) if c.get("errors") or c.get("unseen_iris"))
        errored = record.get("returned_errors", 0)
        print(f"#{n} {record['at']} {record.get('model')} {record['wall_ms']:6d} ms  prompt {usage.get('prompt_tokens')} "
              f"out {usage.get('completion_tokens')}  calls {[c['name'] for c in record.get('calls', [])]}"
              f"{f'  BAD {bad}' if bad else ''}{f'  ERRORED {errored}' if errored else ''}", flush=True)
        self.reply(status, data)

    def log_message(self, *args) -> None:
        pass


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--upstream", default="http://127.0.0.1:11434")
    parser.add_argument("--port", type=int, default=8767)
    parser.add_argument("--out", type=Path, required=True)
    parser.add_argument("--set", action="append", default=[], metavar="KEY=JSON",
                        help="add a field to every request, e.g. reasoning_effort='\"low\"'")
    args = parser.parse_args()
    (args.out / "bodies").mkdir(parents=True, exist_ok=True)
    Meter.upstream = args.upstream.rstrip("/")
    Meter.out = args.out
    Meter.extra = {k: json.loads(v) for k, v in (s.split("=", 1) for s in args.set)}
    print(f"metering :{args.port} → {Meter.upstream}, logging to {args.out}", file=sys.stderr, flush=True)
    ThreadingHTTPServer(("127.0.0.1", args.port), Meter).serve_forever()


if __name__ == "__main__":
    main()
