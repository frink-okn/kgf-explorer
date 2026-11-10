# kgf-explorer

A browser client over the KGF (Knowledge Graph Fragments) API. The operations — search,
count, schema, describe, fetch a pattern, SQL over the session's tables, and more — are
buttons; the same operations are the tools of a chat with whichever model the visitor brings
a key for. Every result is a table with a receipt. Nothing is hosted: the page talks to the
KGF endpoint and to the model provider directly.

`notes/plan.md` is the design of record.

## Build and run

Needs Node, Python 3, and `../kgf-sparql` checked out beside this directory and built
(`npm install && npm run build` there; set `KGF_SPARQL` to use another checkout).

```sh
npm install
npm run build      # ./build.sh: src/ → dist/, the whole site
npm run serve      # python3 serve.py 8765: dist/ with no-cache headers, transcripts to runs/
```

Open http://127.0.0.1:8765/. The endpoint defaults to https://apps.okn.us/kgf. `file://`
does not work, and a plain static server can hide a rebuild behind a cached `index.html`,
which `serve.py` prevents. To deploy, publish `dist/`.

### The free model

The provider "Free — RENCI's Qwen through the FRINK gate" needs no key: it goes through
[frink-llm-gate](../frink-llm-gate), which holds the model's key and runs only the prompt and
operations a build signed. The build signs them when it has the signing key, which is never in
this repository:

```sh
KGF_GATE_KEY=<file holding the build's Ed25519 seed> ./build.sh   # writes dist/gate-manifest.txt
```

`KGF_GATE_KEY_ID` names the key (`build1` by default), and `KGF_GATE_URL` the gate (the
development gate's `http://127.0.0.1:8787` by default). Without the key the build says so and
the free model is off. For development, the gate's `tools/dev_run.sh` with no question keeps a
gate up for the page, and its `dev/build-key` is the key that gate trusts.

## Layout

| file | what it is |
|---|---|
| `src/tools.js` | the one list of operations: each is a form and a model tool |
| `src/templates.js` | the five SPARQL templates, written by the page |
| `src/kgf.js` | KGF calls: templates through kgf-sparql's engine; `fetch`, `/labels` and direct calls through its `RunAccount`; receipts |
| `src/sql.js` | DuckDB-Wasm over the session's tables, locked down |
| `src/terms.js` | terms in table columns, as kgfq stores them |
| `src/workspace.js` | the session: tables, log, labels, what the model sees of a result |
| `src/llm.js` | the chat loop: Anthropic's SDK, the OpenAI chat-completions shape, and the FRINK gate |
| `src/prompt.js` | the full-mode prompt and the last-turn note, which the page sends and the build signs |
| `src/map.js` | map mode (plan D19): the `map` tool and its prompt; the page checks a map and runs its paths |
| `gate-manifest.js` | writes and signs the gate's manifest from `src/prompt.js` and `src/tools.js`, at build time |
| `src/sha256.js`, `src/pow-worker.js` | the gate's proof of work, in a worker |
| `src/transcript.js` | a conversation kept as evidence: prompt, tools, every model call, what each result showed the model, receipts |
| `src/markdown.js` | replies as sanitized Markdown |
| `src/app.js`, `index.html` | the page |
| `test/fake_llm.py` | a stand-in OpenAI-compatible model endpoint for testing the chat without a key |
| `test/meter_llm.py` | a metering proxy in front of a real OpenAI-compatible model server |
| `test/digest.py` | reads transcripts: a trace of each message, and flags to look at first |
| `test/pow_check.mjs` | checks the proof of work against Node's crypto and the gate's own vector |
| `test/questions.jsonl`, `test/enqueue.py` | cases with measured answers, and the queue the page runs with `?queue` |

## Testing the chat without a key

`python3 test/fake_llm.py` listens on port 8766. It asks for `list_graphs` on every turn
unless `tool_choice` is `none`, then answers in Markdown that includes three injection attempts,
which must come out inert. In the page choose "OpenAI-compatible — custom URL", base URL
`http://127.0.0.1:8766/v1`, any model name; `GET http://127.0.0.1:8766/log` shows what the page
sent, and under `fetched` any image the reply made the browser load, which must be none. The Anthropic branch has the same shape and runs only with a real key.

## Transcripts

Served by `serve.py`, the page writes each conversation to `runs/<id>.json` as it goes (plan
D18); anywhere else, "Transcript" under the chat downloads it. A transcript holds the settings,
the system prompt and tools, every model call (stop reason, time, tokens, cost), the exact
history the model was sent, thinking included where the provider returns it, and the session's
log with receipts. Never the key. `runs/` is not committed.

```sh
python3 test/digest.py runs/                # a trace of every message, with flags
python3 test/digest.py --table runs/        # one line per message
```

To run questions unattended: queue cases from `test/questions.jsonl`, which holds each case's
measured answer, then open the page from `serve.py` with `?queue`. It runs each case in a new
session with the model the page is set to, and writes one transcript per case.

```sh
python3 test/enqueue.py test/questions.jsonl --kind path --runs 3
open 'http://127.0.0.1:8765/?queue'
python3 test/digest.py --suite test/questions.jsonl runs/
```
