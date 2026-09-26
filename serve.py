"""Serves dist/, the built site, and makes the browser revalidate every file.

python's http.server sends Last-Modified and no Cache-Control, so browsers cache
index.html heuristically and keep running an old build after a rebuild.
"""

import http.server
import sys
from pathlib import Path


class NoCache(http.server.SimpleHTTPRequestHandler):
    def end_headers(self) -> None:
        self.send_header("Cache-Control", "no-cache")
        super().end_headers()


if __name__ == "__main__":
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8765
    root = str(Path(__file__).parent / "dist")
    handler = lambda *a, **k: NoCache(*a, directory=root, **k)  # noqa: E731 — handler factory
    http.server.ThreadingHTTPServer(("127.0.0.1", port), handler).serve_forever()
