"""Queues cases from a question file for the page to run (plan D18).

  python3 test/enqueue.py test/questions.jsonl                     every case once
  python3 test/enqueue.py test/questions.jsonl --kind path --runs 3
  python3 test/enqueue.py test/questions.jsonl --only omelet,drift-cover-letter --turns 20

Appends to runs/queue.jsonl, which serve.py hands out one case at a time. Open the page from
serve.py with `?queue` (http://127.0.0.1:8765/?queue) and it runs them with the model the page
is set to, each in a new session, writing a transcript per case. `--clear` empties the queue.
The expected answers stay in the question file; the page is not shown them.
"""

import argparse
import json
from pathlib import Path

QUEUE = Path(__file__).resolve().parent.parent / "runs" / "queue.jsonl"


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("questions", type=Path, nargs="?")
    parser.add_argument("--only", help="comma-separated case ids")
    parser.add_argument("--kind", help="comma-separated kinds (path, count, guard)")
    parser.add_argument("--runs", type=int, default=1, help="times to run each case")
    parser.add_argument("--turns", type=int, help="model turns per message")
    parser.add_argument("--clear", action="store_true", help="empty the queue first")
    args = parser.parse_args()
    QUEUE.parent.mkdir(exist_ok=True)
    if args.clear:
        QUEUE.write_text("")
    if not args.questions:
        return
    cases = [json.loads(line) for line in args.questions.read_text().splitlines() if line.strip()]
    if args.only:
        wanted = args.only.split(",")
        unknown = set(wanted) - {c["case"] for c in cases}
        if unknown:
            raise SystemExit(f"no such case: {', '.join(sorted(unknown))}")
        cases = [c for c in cases if c["case"] in wanted]
    if args.kind:
        cases = [c for c in cases if c.get("kind") in args.kind.split(",")]
    lines = []
    for run in range(1, args.runs + 1):
        for c in cases:
            item = {"case": c["case"], "run": run, "messages": c["messages"]}
            if args.turns:
                item["turns"] = args.turns
            lines.append(json.dumps(item))
    with QUEUE.open("a") as queue:
        queue.writelines(line + "\n" for line in lines)
    waiting = sum(1 for line in QUEUE.read_text().splitlines() if line.strip())
    print(f"queued {len(lines)} ({len(cases)} cases × {args.runs}); {waiting} waiting in {QUEUE}")


if __name__ == "__main__":
    main()
