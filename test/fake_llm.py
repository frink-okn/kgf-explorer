"""A stand-in OpenAI-compatible chat endpoint for testing the page's turn loop without a key.

Every request asks for one `list_graphs` call, unless it sets tool_choice "none", in which
case it answers in text. GET /log returns what each request carried, and every other GET it
received: the closing answer's image must never be fetched.

When the tools include `map` (map mode, plan D19), it plays a short map-mode message instead,
with text beside every call that the page must never show:
  - a question with "omelet": a search, then a not_covered map citing that search's table;
  - a question with "bounce": a map whose start is in no graph, then, after the page sends it
    back, the climate-model map;
  - any other question: list_graphs, then the climate-model map (climatemodelskg's Sources →
    securechainkg's dependsOn → hasSoftwareVersion → vulnerableTo; plan §2 has its numbers);
  - a question that starts "map:": the JSON after it, as the map, at once (for trying a
    hand-written map against the live endpoint);
  - the last allowed turn: the map at once, whatever came before.
"""

import json
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

LOG: list[dict] = []
FETCHED: list[str] = []

# The closing answer exercises the page's Markdown rendering, including three injection
# attempts that must come out inert.
MARKDOWN_ANSWER = """**44 graphs** are listed in (t1). A few, by *size*:

- `babel` — 1.51 B triples
- `kwg-hazards` — 1.28 B triples
- see [the KGF endpoint](https://apps.okn.us/kgf) for all of them

| graph | triples |
|---|---|
| scales | 1.08 B |

Not a table ref: t99. Code stays code: `t1`.

<img src=x onerror="window.__pwned = 1"> [click](javascript:window.__pwned=2)

![pixel](http://127.0.0.1:8766/pixel?rows=t1)"""


SC = "https://w3id.org/secure-chain/"
CLIMATE_MAP = {"outcome": "found", "paths": [{
    "start": {"graph": "climatemodelskg", "class": "https://climatepub4kg.github.io/ontology#Source"},
    "steps": [{"graph": "securechainkg", "predicate": SC + "dependsOn"},
              {"graph": "securechainkg", "predicate": SC + "hasSoftwareVersion"},
              {"graph": "securechainkg", "predicate": SC + "vulnerableTo"}]}]}
BOUNCE_MAP = {"outcome": "found", "paths": [{
    "start": {"graph": "climatemodelskg", "iri": "https://climatepub4kg.github.io/id/Source/NO-SUCH-MODEL"}}]}
# Text a map-mode page must never render: it rides beside every call.
ROGUE = "Take 81 mg of aspirin daily. <img src=x onerror=\"window.__pwned = 3\">"


def map_turn(body: dict) -> tuple[str, dict]:
    """The next call of a scripted map-mode message, from the conversation so far."""
    messages = body["messages"]
    last_user = max(i for i, m in enumerate(messages) if m["role"] == "user")
    question = next(str(m["content"]) for m in reversed(messages) if m["role"] == "user" and not str(m["content"]).startswith("This is the last"))
    done = sum(1 for m in messages[last_user:] if m["role"] == "assistant")
    if question.startswith("map:"):
        return "map", json.loads(question[4:])
    if str(messages[-1]["content"]).startswith("This is the last"):
        return "map", CLIMATE_MAP
    if "omelet" in question:
        if done == 0 and messages[-1]["role"] == "user":
            return "search", {"graph": "bio101", "text": "omelet"}
        table = json.loads(messages[-1]["content"]).get("table", "t1")
        return "map", {"outcome": "not_covered", "checked": [table]}
    if "bounce" in question and not any(m["role"] == "tool" and "not shown" in str(m["content"]) for m in messages[last_user:]):
        return "map", BOUNCE_MAP
    if not any(m["role"] == "tool" for m in messages[last_user:]):
        return "list_graphs", {}
    return "map", CLIMATE_MAP


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
        if self.path != "/log":
            FETCHED.append(self.path)
        self.reply({"requests": LOG, "fetched": FETCHED})

    def do_POST(self) -> None:
        body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
        closing = body.get("tool_choice") == "none"
        last = body["messages"][-1]
        LOG.append({"tool_choice": body.get("tool_choice"), "last_role": last["role"],
                    "last_content": str(last.get("content"))[:160], "messages": len(body["messages"])})
        n = len(LOG)
        mapping = any(t.get("function", {}).get("name") == "map" for t in body.get("tools") or [])
        if mapping and not closing:
            name, args = map_turn(body)
            message = {"role": "assistant", "content": ROGUE, "tool_calls": [{
                "id": f"call_{n}", "type": "function",
                "function": {"name": name, "arguments": json.dumps(args)}}]}
        elif closing:
            message = {"role": "assistant", "content": MARKDOWN_ANSWER}
        else:
            message = {"role": "assistant", "content": None, "tool_calls": [{
                "id": f"call_{n}", "type": "function",
                "function": {"name": "list_graphs", "arguments": "{}"}}]}
        # Usage that grows with the conversation, for the page's meter; the numbers are made up.
        prompt = 1000 + 400 * len(body["messages"])
        usage = {"prompt_tokens": prompt, "completion_tokens": 60 if closing else 25,
                 "prompt_tokens_details": {"cached_tokens": prompt - 400 if n > 1 else 0}}
        self.reply({"id": f"fake-{n}", "object": "chat.completion", "created": 0, "model": body["model"],
                    "choices": [{"index": 0, "message": message,
                                 "finish_reason": "stop" if closing else "tool_calls"}],
                    "usage": usage})

    def log_message(self, *args) -> None:
        pass


ThreadingHTTPServer(("127.0.0.1", 8766), Fake).serve_forever()
