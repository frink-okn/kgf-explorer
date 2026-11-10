"""Reads transcripts (kgf-explorer.transcript/0, plan D18) and prints what each run did.

  python3 test/digest.py runs/                 a trace of every message in every run
  python3 test/digest.py --table runs/*.json   one line per message, for comparing runs
  python3 test/digest.py --thinking 600 FILE   more of each turn's thinking
  python3 test/digest.py --suite test/questions.jsonl runs/   the expected answer beside each

A trace is one line per model turn: its thinking and text, cut short, then each tool call with
its input and what came back (table, rows, contract, unmatched values, errors). Then the answer
and the flags, which are what to look at first:

  no-tool      answered with no tool call in this message (D15 asks for a look first)
  uncited      a long answer that cites no table
  ghost-cite   cites a table id that does not exist
  unseen-iri   a tool input holds an IRI no prompt, message or result had shown (invented)
  tool-error   a call came back refused or failed; the server's words follow
  repeat       the same call with the same input, more than once in a message
  budget       a run stopped at a budget, or the message reached its model turns
  unmatched    a bound step lost values (D8); the sample follows
  big-result   one result over 20,000 characters of the model's context
  no-link      the answer says graphs do not connect; says whether overlap was called on them
  own-words    the answer marks something as not from the graphs
  refused      the provider declined a turn
"""

import argparse
import json
import re
import sys
from pathlib import Path

IRI = re.compile(r"https?://[^\s\"'<>\\`|)\]]+")
CITE = re.compile(r"\b([tsec]\d+)\b")
NO_LINK = re.compile(
    r"(do(es)?n['’]?t|do(es)? not|cannot|can['’]t)\s+(be\s+)?(connect|link|join|share|overlap)"
    r"|share[sd]? no\b|no shared|not (directly )?(connected|linked|joinable)|no (direct |cross-graph )?(link|connection|join|overlap)",
    re.I,
)
OWN = re.compile(r"not from the graphs|my own knowledge|general knowledge|outside the graphs|made up", re.I)
# The last-turn note: with a count from the page's own adapters, without one from the gate's.
CLOSING = ("This is the last of the ", "This is the last model turn ")
BIG = 20_000


def clip(text: str, n: int) -> str:
    text = " ".join((text or "").split())
    return text if len(text) <= n else text[: n - 1] + "…"


def iris(text: str) -> set[str]:
    return {i.rstrip(".,;:") for i in IRI.findall(text or "")}


def events(record: dict) -> list[tuple]:
    """The history as (kind, …) events in one shape, whichever adapter wrote it."""
    out = []
    anthropic = record["model"]["provider"] == "anthropic"
    for m in record.get("history") or []:
        role, content = m.get("role"), m.get("content")
        if anthropic:
            blocks = [{"type": "text", "text": content}] if isinstance(content, str) else content or []
            for b in blocks:
                kind = b.get("type")
                if kind == "text" and role == "user":
                    out.append(("note" if b["text"].startswith(CLOSING) else "user", b["text"]))
                elif kind == "text":
                    out.append(("say", b["text"]))
                elif kind == "thinking":
                    out.append(("think", b.get("thinking", "")))
                elif kind == "redacted_thinking":
                    out.append(("think", "[redacted]"))
                elif kind == "tool_use":
                    out.append(("call", b["id"], b["name"], b.get("input") or {}))
                elif kind == "tool_result":
                    text = b.get("content")
                    if isinstance(text, list):
                        text = " ".join(x.get("text", "") for x in text)
                    out.append(("result", b["tool_use_id"], text or "", bool(b.get("is_error"))))
        else:
            if role == "system":
                continue
            if role == "user":
                out.append(("note" if str(content).startswith(CLOSING) else "user", content or ""))
            elif role == "assistant":
                reasoning = m.get("reasoning") or m.get("reasoning_content")
                if reasoning:
                    out.append(("think", reasoning))
                if content:
                    out.append(("say", content))
                for c in m.get("tool_calls") or []:
                    try:
                        args = json.loads(c["function"].get("arguments") or "{}")
                    except json.JSONDecodeError:
                        args = {"_unparsed": c["function"].get("arguments")}
                    out.append(("call", c["id"], c["function"]["name"], args))
            elif role == "tool":
                out.append(("result", m.get("tool_call_id"), content or "", False))
    return out


def by_message(evs: list[tuple]) -> list[list[tuple]]:
    """Events split at each message the person sent."""
    groups: list[list[tuple]] = []
    for e in evs:
        if e[0] == "user":
            groups.append([e])
        elif groups:
            groups[-1].append(e)
    return groups


def headline(text: str) -> tuple[str, dict]:
    """What one tool result said, in a few words, and the parsed result."""
    try:
        r = json.loads(text)
    except (json.JSONDecodeError, TypeError):
        return clip(text, 120), {}
    if not isinstance(r, dict):
        return clip(text, 120), {}
    bits = []
    if "table" in r and "rows" in r and isinstance(r["rows"], int):
        bits.append(f"{r['table']} {r['rows']} rows")
    elif "table" in r and "total_rows" in r:
        bits.append(f"read {r['table']} {r.get('offset', 0)}+{len(r.get('rows') or [])} of {r['total_rows']}")
    elif "handle" in r:
        bits.append(str(r["handle"]))
    if r.get("contract") not in (None, "complete"):
        bits.append(str(r["contract"]))
    if r.get("aborted_at_budget"):
        bits.append(f"at budget {r['aborted_at_budget']}")
    if "text" in r:
        bits.append(f"text {len(r['text']):,} chars")
    b = r.get("bound_values")
    if b:
        bits.append(f"bound {b.get('matched')}/{b.get('sent')} matched")
    if r.get("limit_reached"):
        bits.append("limit reached")
    if r.get("error"):
        bits.append(f"ERROR {clip(str(r['error']), 160)}")
    return " · ".join(bits) or clip(text, 120), r


def money(n: float) -> str:
    return f"${n:.4f}" if n < 0.01 else f"${n:.3f}" if n < 1 else f"${n:.2f}"


def analyse(record: dict, args) -> list[dict]:
    """One summary per message of the run, with its trace lines and flags."""
    groups = by_message(events(record))
    tables = {r.get("table") for r in record.get("log") or [] if r.get("table")}
    seen: set[str] = set()
    for prompt in record.get("prompts", {}).values():
        seen |= iris(prompt.get("system", "")) | iris(json.dumps(prompt.get("tools", [])))
    overlapped: set[frozenset] = set()
    out = []
    for i, group in enumerate(groups):
        meta = record["messages"][i] if i < len(record["messages"]) else {}
        lines, flags = [], []
        names, inputs, graphs = [], {}, set()
        # Pass 1: model turns (thinking, text, calls) and results by call id.
        turns, results = [], {}
        assistant = False
        for e in group:
            kind = e[0]
            if kind in ("think", "say", "call"):
                if not assistant:
                    turns.append({"think": [], "say": [], "calls": []})
                    assistant = True
                turns[-1][{"think": "think", "say": "say", "call": "calls"}[kind]].append(e[1] if kind != "call" else e[1:])
                continue
            assistant = False
            if kind == "user":
                seen |= iris(e[1])
            elif kind == "note":
                flags.append("budget: reached the model-turn limit; answered with tools off")
            elif kind == "result":
                results[e[1]] = (e[2], e[3])
        # Pass 2: one line per turn, then its calls and what each returned.
        for n, t in enumerate(turns, 1):
            think = clip(" ".join(t["think"]), args.thinking) if t["think"] and args.thinking else ""
            say = clip(" ".join(t["say"]), args.text)
            parts = [f"think: {think}" if think else "", f"says: {say}" if say else ""]
            lines.append(f"  {n:>2} " + (" | ".join(x for x in parts if x) or "(no text)"))
            for cid, name, inp in t["calls"]:
                names.append(name)
                key = name + json.dumps(inp, sort_keys=True)
                inputs[key] = inputs.get(key, 0) + 1
                for g in [inp.get("graph")] + list(inp.get("graphs") or []):
                    if isinstance(g, str):
                        graphs.add(g)
                if name == "overlap" and len(inp.get("graphs") or []) >= 2:
                    gs = list(inp["graphs"])
                    overlapped.update(frozenset((a, b)) for a in gs for b in gs if a != b)
                unseen = sorted(x for x in iris(json.dumps(inp)) if x not in seen and not any(s.startswith(x) for s in seen))
                if unseen:
                    flags.append(f"unseen-iri: {name} {', '.join(unseen[:3])}{' …' if len(unseen) > 3 else ''}")
                lines.append(f"     → {name} {clip(json.dumps(inp, ensure_ascii=False), args.input)}")
                if cid not in results:
                    lines.append("       = (no result)")
                    continue
                text, is_error = results[cid]
                seen |= iris(text)
                head, r = headline(text)
                lines.append(f"       = {head}")
                if is_error or r.get("error") or r.get("contract") == "error":
                    flags.append(f"tool-error: {name}: {clip(str(r.get('error') or text), 200)}")
                if r.get("aborted_at_budget") or r.get("contract") == "aborted":
                    flags.append(f"budget: {name} stopped at {r.get('aborted_at_budget') or 'a budget'}")
                b = r.get("bound_values") or {}
                if b.get("unmatched"):
                    flags.append(f"unmatched: {name} {b['unmatched']}/{b.get('sent')} lost, e.g. {clip(json.dumps(b.get('unmatched_sample', [])[:3], ensure_ascii=False), 120)}")
                if len(text) > BIG:
                    flags.append(f"big-result: {name} {len(text):,} chars")
        # The answer is the text of the last turn, if that turn called nothing.
        answer = " ".join(turns[-1]["say"]) if turns and not turns[-1]["calls"] else ""

        calls = meta.get("calls") or []
        tool_count = len(names)
        if tool_count == 0 and answer:
            flags.insert(0, "no-tool: answered without calling a tool")
        cited = sorted(set(CITE.findall(answer)), key=lambda x: (x[0], int(x[1:])))
        if answer and len(answer) > 300 and not any(c.startswith("t") for c in cited) and record.get("mode") != "guided":
            flags.append("uncited: no table cited")
        ghosts = [c for c in cited if c.startswith("t") and c not in tables]
        if ghosts:
            flags.append(f"ghost-cite: {', '.join(ghosts)}")
        for key, n in inputs.items():
            if n > 1:
                flags.append(f"repeat: {clip(key, 100)} ×{n}")
        if NO_LINK.search(answer):
            pairs = [p for p in overlapped if p <= graphs] if len(graphs) >= 2 else []
            flags.append(f"no-link: says graphs do not connect; overlap {'was' if pairs else 'was not'} called on graphs it used ({', '.join(sorted(graphs)) or 'none named'})")
        if OWN.search(answer):
            flags.append(f"own-words: “{clip(OWN.search(answer).group(0), 40)}”")
        if any(c.get("stop") == "refusal" for c in calls):
            flags.append("refused: the provider declined a turn")
        for c in calls:
            if c.get("error"):
                flags.append(f"call-error: turn {c.get('turn')}: {clip(c['error'], 160)}")

        usage = [c["usage"] for c in calls if c.get("usage")]
        prompt_tokens = sum(u["input"] + u["cacheWrite"] + u["cacheRead"] for u in usage)
        cost = sum(u["cost"] for u in usage if u.get("cost") is not None) if usage and all(u.get("cost") is not None for u in usage) else None
        think_chars = sum(len(e[1]) for e in group if e[0] == "think")
        out.append({
            "run": record["id"], "case": (record.get("case") or {}).get("id"), "try": (record.get("case") or {}).get("run"), "model": record["model"].get("model"), "provider": record["model"]["provider"],
            "effort": meta.get("effort"), "mode": record.get("mode"), "build": record.get("build"),
            "prompt": meta.get("prompt"), "n": i + 1, "question": group[0][1], "outcome": meta.get("outcome", "?"),
            "calls": len(calls), "tools": tool_count, "tool_names": names, "graphs": sorted(graphs),
            "prompt_tokens": prompt_tokens, "output_tokens": sum(u["output"] for u in usage), "cost": cost,
            "model_s": sum(c.get("ms", 0) for c in calls) / 1000, "tool_s": sum(t.get("ms", 0) for t in meta.get("tools") or []) / 1000,
            "max_prompt": max((u["input"] + u["cacheWrite"] + u["cacheRead"] for u in usage), default=0),
            "think_chars": think_chars, "answer": answer, "cited": cited, "flags": flags, "lines": lines,
        })
    return out


def load(paths: list[str]) -> list[dict]:
    files = []
    for p in map(Path, paths):
        files += sorted(p.glob("*.json")) if p.is_dir() else [p]
    records = []
    for f in files:
        try:
            r = json.loads(f.read_text())
        except (OSError, json.JSONDecodeError) as error:
            print(f"{f}: {error}", file=sys.stderr)
            continue
        if r.get("schema") == "kgf-explorer.transcript/0":
            records.append(r)
    return records


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("paths", nargs="+", help="transcript files, or directories of them")
    parser.add_argument("--table", action="store_true", help="one line per message")
    parser.add_argument("--thinking", type=int, default=160, help="characters of thinking per turn (0: none)")
    parser.add_argument("--text", type=int, default=200, help="characters of text per turn")
    parser.add_argument("--input", type=int, default=160, help="characters of each tool input")
    parser.add_argument("--answer", type=int, default=700, help="characters of the answer")
    parser.add_argument("--suite", type=Path, help="the question file the runs came from, for expected answers")
    parser.add_argument("--case", help="only runs of these comma-separated cases")
    args = parser.parse_args()
    expected = {}
    if args.suite:
        for line in args.suite.read_text().splitlines():
            if line.strip():
                c = json.loads(line)
                expected[c["case"]] = c.get("expect")
    records = load(args.paths)
    if args.case:
        records = [r for r in records if (r.get("case") or {}).get("id") in args.case.split(",")]
    for record in records:
        for m in analyse(record, args):
            cost = money(m["cost"]) if m["cost"] is not None else "—"
            kinds = sorted({f.split(":")[0] for f in m["flags"]})
            if args.table:
                print("\t".join([m["case"] or m["run"][-30:], f"{m['model']}{'@' + m['effort'] if m['effort'] else ''}", m["mode"] or "",
                                 clip(m["question"], 50), m["outcome"], f"{m['calls']} calls", f"{m['tools']} tools",
                                 cost, f"{m['model_s'] + m['tool_s']:.0f}s", ",".join(kinds)]))
                continue
            label = f"{m['case']} (run {m['try']})  ·  " if m["case"] else ""
            print(f"\n{label}{m['run']}  ·  message {m['n']}")
            print(f"  {m['model']} ({m['provider']}{', effort ' + m['effort'] if m['effort'] else ''}) · {m['mode']} · build {m['build']} · prompt {m['prompt']}")
            print(f"  Q: {clip(m['question'], 300)}")
            print(f"  {m['outcome']} · {m['calls']} model calls · {m['tools']} tool calls · {m['prompt_tokens']:,} prompt tokens "
                  f"(largest {m['max_prompt']:,}) · {m['output_tokens']:,} out · {cost} · model {m['model_s']:.0f} s, tools {m['tool_s']:.0f} s"
                  f" · thinking {m['think_chars']:,} chars")
            print(f"  graphs: {', '.join(m['graphs']) or '—'}")
            print("\n".join(m["lines"]))
            print(f"  A: {clip(m['answer'], args.answer) or '—'}")
            print(f"  cites: {', '.join(m['cited']) or '—'}")
            if expected.get(m["case"]) and m["n"] == len(record["messages"]):
                print(f"  expected: {expected[m['case']]}")
            for f in m["flags"] or ["none"]:
                print(f"  flag {f}")


if __name__ == "__main__":
    main()
