# kgf-explorer — project norms

A static page over the KGF API: the operations are buttons, and the same operations are a
bring-your-own-model chat's tools. Sister to `../kgfq`: it shares kgfq's decisions where the
same reasoning applies and none of its code. `notes/plan.md` is the design of record; read it
before changing anything, and the decision (D1–D15) a change touches.

## Build and run

- npm owns dependencies (`npm install`); `./build.sh` (`npm run build`) bundles with esbuild
  into `dist/`, which is the whole site. No framework.
- `../kgf-sparql` must be checked out and built; the page bundles its compiled engine
  unmodified. `KGF_SPARQL` points elsewhere.
- Serve with `python3 serve.py 8765` (`npm run serve`): `dist/` with no-cache headers. A plain
  static server can serve a stale `index.html` after a rebuild. `file://` does not work.
- `dist/` is built, never edited or committed.

## Tests: real servers, never mocks

- No automated suite yet (plan §3 item 2). Check a change in a browser against the live
  endpoint `https://apps.okn.us/kgf`, and say what was and was not checked.
- Never mock the KGF server. The traps this page absorbs were found against a live one.
- `test/fake_llm.py` stands in for a model, never for KGF: it tests the chat loop, the closing
  turn and the Markdown sanitizer without a key.

## Architecture rules (from the plan; do not relitigate silently)

- One list of operations (`src/tools.js`), two surfaces. A click and a model's call both go
  through `Workspace.run`; nothing else creates a table.
- The model never writes SPARQL. Templates are the page's; `sql` is DuckDB SQL over the
  session's own tables only, with the DuckDB locked before any SQL runs.
- Every request goes through kgf-sparql's `RunAccount`; every table has a receipt and a grade.
- Terms are stored as kgfq stores them (`x, x_kind, x_lang, x_datatype`); a kind is stated,
  never guessed from a value's shape.
- Labels come from each graph's `/labels` and sit beside a table, never in it.
- Caps come from the endpoint's service descriptor; never hard-code one. The visitor's budget
  bounds every run, and a run that reaches it stops, keeps what arrived and says so.
- Errors from a server are its problem document, verbatim.
- Model output is sanitized before it is rendered. The key goes only to the provider the
  visitor chose. Nothing is hosted.

## Keeping the plan current

- When a decision changes, change it in `notes/plan.md` and say why; decisions are surfaced,
  not quietly replaced. Landed work gets a dated note under its decision.
- Server gaps go to kgf-rs issues; what this page needs from kgf-sparql goes in
  `../kgf-sparql/handoff/`. Edits to neighbours and any commit happen only when asked.
- Match the voice of `notes/`: short declaratives, cross-references to plan items and to kgfq's
  decisions, measurements over adjectives.

## Neighbours

```
../kgfq            the local analysis client; receipts, log and term encoding to share
../kgf-sparql      Comunica + the KGF actors; bundled here from its compiled lib/
../kgf-rs          the server; its issues are where server gaps go
../kgf             design docs (doc 03 = API, doc 06 = clients, doc 19 = labels)
../frink-query-ui  the FRINK web UI (Vite, React); also wants kgf-sparql in the browser
```
