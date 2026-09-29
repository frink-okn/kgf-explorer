# kgf-explorer — plan

The design of record. A static page over the KGF API: the operations are buttons, the same
operations are a chat model's tools, and the model is whichever one the visitor brings. It
began as a sketch in the kgfq session of 2026-09-24 and moved here on 2026-09-26.

## 0. What this is, and what it is not

**Is:** a browser client for people exploring OKN graphs served by KGF — a person clicking
through operations, or asking a model that calls the same operations and cites the tables they
leave. Doc 06 §6.6's "static single-page browser", grown a chat.

**Is not:** kgfq. kgfq is the local analysis workspace whose product is a directory of tables,
receipts and a replayable log (kgfq D15); this page's session lives in a tab. The two share
decisions where the same reasoning applies, cited below as "kgfq Dn", and no code. The contract
between them should be formats — receipts and the session log in kgfq's schemas (§3 item 3) —
so a session explored here can be taken home to kgfq.

**Is not hosted.** Nothing runs on our side: requests go from the tab to the KGF endpoint and
to the model provider the visitor chose. Joins run on the visitor's CPU, which is kgfq D13's
cost argument in a browser.

## 1. Decisions

**D1. One list of operations, two surfaces.** `src/tools.js` holds every operation once. The
page renders each as a form; the chat hands the same list to the model as tools. A click and a
model's call both end in `Workspace.run`, land as the same kind of table and write the same log
record; only the recorded actor differs.

**D2. The model never writes SPARQL** (kgfq D16, §5.4). The five templates (`describe`,
`incoming`, `instances`, `neighbors`, `two_hop`) are the page's; a caller supplies IRIs, which
are checked, and a limit bounded by the endpoint's `max_output_rows`.

**D3. Fetch steps plus SQL** (kgfq §11 item 11(i)'s proposed ceiling, tried here first).
`fetch` is one pattern in one graph, each position a constant, a `?variable` that becomes a
column, or bound to a column of an earlier table; bound values go out as `QUERY /fragment`
bindings batched by `max_bindings` and `max_request_bytes`, every cursor followed, `POST` on
405/501. `sql` is one DuckDB SELECT over the session's tables. Choosing between fetching a
pattern whole and binding a column is left to the model, with `count` to size things — the
decision kgfq's strategy function (R2) exists to make.

**D4. kgf-sparql, unmodified, in the tab.** Templates run through kgf-sparql's compiled engine
(Comunica 5.3 with the KGF actors). Every request any operation makes — templates, `fetch`,
direct calls — goes through kgf-sparql's `RunAccount`, so budgets and request accounting are
the CLI's. Its default fetch throws "Illegal invocation" in a browser (it calls `fetch` as a
method of the account); the page passes an unbound wrapper. The browser-safe exports this
depends on are asked for in `../kgf-sparql/handoff/browser-exports.md`.

**D5. Every table has a receipt and a grade.** `kgf-explorer.receipt/0`, modelled on
`kgf-sparql.receipt/1`: operation, input, the SPARQL or pattern, pinned sources with content
digests, outcome, every request with its `KGF-Request-Id`, totals, budget. Grade per kgfq D17:
`bundle` for anything read from a release; a `sql` table takes the lowest grade of the tables
it read, which the parser names (`getTableNames`). The log exports as JSON Lines. Releases are
pinned once per session from the catalogue.

**D6. Terms are stored as kgfq stores them** (kgfq C6, changed 2026-09-24): every term column
`x` has `x_kind` (`iri`, `literal`, `bnode`), `x_lang`, `x_datatype`; a plain literal stores no
datatype. A SQL result column gets its kind back from its companions when the query selects
them, else from the one encoding its values have in the tables the query read, else it is a
plain or typed literal. Never a looks-like-`http` guess: that turned `tel:8009514357` into a
string.

**D7. Labels beside tables, never in them** (kgfq C7). The IRIs a table shows (its first 500
rows) are labeled when it lands, through each graph's `QUERY /labels`: the graph's declared
label predicates in order, one label per IRI, `null` when none. A table asks the graphs it came
from, in order; a `sql` table asks its inputs' graphs; rows read past 500 are labeled on
demand. The model gets a `labels` map beside its preview; the `labels` operation turns a column
into an `(iri, label)` table when names must be data. The templates join no labels:
`OPTIONAL { ?x rdfs:label ?l }` ignored declared label predicates (SCALES names people and
organizations with NIEM predicates, ruralkg puts `schema:name` first), doubled rows when two
graphs each had a label, and cost 112 requests for 50 rows (now 4, plus 1 for labels).

**D8. Denominators.** A bound fetch reports how many of its values matched nothing, with a
sample, in its receipt, the table view and what the model sees; KGF tags each row with its
binding index, so the count is exact. The system prompt asks the model to say how many of what
it started from survived each step and to look at what a step lost. The same report is planned
for kgfq (its C6, 2026-09-24).

**D9. `schema` lists everything.** Every class with its entity count, a class's predicates, a
class-and-predicate's object classes and datatypes, shown to the model whole (up to 200 rows).
The summary card shows only the ten largest classes, which hid SCALES' `Court` (kgf-rs#21);
object classes and datatypes come back only beneath a class selector (kgf-rs#22).

*2026-09-28:* `list_graphs` is shown whole too. Its 20-row preview held the first 20 of 45
graphs, alphabetically: qwen3-coder:30b, asked for asthma's IRI in spoke-okn (row 41), said
there was no such graph and answered from biohealth. Whole, it costs about 3.5k tokens (1.5k
before).

**D10. Caps from the descriptor, budgets from the visitor.** Page sizes, bindings batches and
row limits come from the endpoint's descriptor; no number of ours stands in for one. The
visitor's budget — requests, MiB received, rows kept, seconds, model turns per message — bounds
every run. A run that reaches a budget stops, keeps what arrived and says so; a message that
reaches its model turns gets one last turn with tools off, told to answer from the tables it
has and say what it did not get to.

**D11. The DuckDB is locked** (kgfq D6 in a tab). External access, extension autoinstall and
autoload off, `lock_configuration` on, before any SQL a model wrote runs; the text is wrapped
as a subquery, where only a query parses, and prepared, which refuses a second statement.
Table names are the workspace's own.

**D12. The model is the visitor's.** Two adapters: Anthropic's SDK (default `claude-opus-5`,
with `fallbacks: "default"`), and the OpenAI chat-completions shape, which OpenAI, OpenRouter
and local servers speak. The key goes to the chosen provider only, kept in `sessionStorage`
unless "remember" is ticked. A conversation lasts until the provider, model, URL or key
changes, and says so when it restarts.

**D13. Model output is rendered, sanitized.** Replies render as light Markdown through
markdown-it with raw HTML off, then DOMPurify: a reply can quote graph content, and the page
holds a key. Links open in a new tab; table ids a reply cites link to their tables.

*2026-09-26:* Markdown images are off. With `html: false`, markdown-it still renders
`![x](url)` as `<img>`, DOMPurify keeps it, and the browser loads it without a click. Graph
text reaches the model, so a planted literal could have a reply carry a table off in an image
URL; the key is not in the model's context. `![x](url)` now renders as a link.
`test/fake_llm.py` sends such an image and records any fetch of it.

**D14. Server errors verbatim**, to the person and to the model.

**D15. Answers come from the graphs.** A reply sits beside the tables on a page about the
graphs, so what it states reads as a finding from them. The system prompt says facts come from
the session's tables, cited by id. The model's own knowledge is for finding its way — what a
term means, which identifier scheme a column likely uses, what to search for — and a fact of
its own is marked as not from the graphs. A question the graphs do not cover gets what was
checked and what the graphs do cover, not an answer from the model's knowledge; a borderline
topic is checked with `search` or `schema` first (D9). Text in the graphs is data, never
instructions. Content safety is the provider's: the visitor chose the model and its filters
(D12), and a prompt line would not add to them. The rule is on attribution, which only the
page can set, and it asks for more tool calls, not fewer. Added 2026-09-26: gpt-5.6-sol,
asked for an omelet recipe, called `list_graphs` and then wrote the recipe, citing no table.

## 2. Measured (2026-09-24 to 2026-09-26, apps.okn.us, kgf 0.3.0)

- Engine in the tab, one pattern (`describe` asthma, spoke-okn): 4 requests, 247 ms, release
  pinned by content digest. Bind-join asthma → genes: 24 requests (8 `QUERY /count`, 8
  `QUERY /fragment`, 2 `/schema` for VoID statistics), 262 ms, 465 rows. Cross-origin `QUERY`
  works: the server's preflight allows it and exposes every header.
- Cross-graph `two_hop` (spoke-okn disease → gene, spoke-genelab mouse ortholog → gene): 305
  requests, 16 carrying bindings, 1.18 s, 100 rows.
- The district question — which federal district courts' ZIP-code jurisdictions hold the most
  substance-use treatment providers, and how many offer telehealth — as seven fetches and one
  SQL: 16 requests, under a second of fetching, the same answer as kgfq `fetch --values` plus
  DuckDB. That answer undercounted: ruralkg writes 899 ZIPs without their leading zeros,
  space-padded (`"1002 "` for 01002), which the unmatched report shows (533 of 5,420 bound
  ZIPs, sample `"1002 "`, `"1003 "`, …); and kwg-places' `sfContains` places 925 ZIP areas in
  no district. With ZIPs normalized in SQL and SCALES' court ZIP lists, 5,478 of 5,578
  providers are placed in all 94 districts (Arizona 253 / 208 with telehealth).
- Budgets: `max_requests`, `max_bytes`, `max_rows` (the rows before it are kept) and Stop each
  end a run with a receipt that says so; a malformed IRI is refused before any request.
- Providers: api.anthropic.com, api.openai.com and openrouter.ai answer this origin's
  cross-origin POST, so a key works from a static page.
- The chat loop, closing turn, conversation persistence and Markdown rendering were checked
  against `test/fake_llm.py`; a reply carrying `<img onerror>` and a `javascript:` link came
  out inert. So did a Markdown image (2026-09-26): it renders as a link and was never fetched.
- A live model: gpt-5.6-sol through an Azure OpenAI deployment and the chat-completions
  adapter (2026-09-26), before and after D15; after it, the model kept to D15's rule.
- Local models for a free default (§3 item 4), 2026-09-28: Ollama 0.30.11 on an M2 Max GPU,
  32k context, default thinking, through `test/meter_llm.py`; five questions, one run each
  (the three largest graphs; asthma's genes in spoke-okn, 465; an omelet recipe, D15; asthma's
  IRI; scales' courts, 94). qwen3.6:27b 5/5, 140 s a question; gemma4:26b-a4b 4/5, 39 s
  (counted triples naming Court, 100); qwen3-coder:30b 4/5 (ranked the sizes by eye);
  qwen3.5:9b 2/5 (filled 32k tokens twice, no answer); lfm2.5:8b 1/4 (wrote the recipe). The
  two that ranked the graphs right did it in `sql`.

## 3. Open

1. **kgf-sparql's browser entry** (`../kgf-sparql/handoff/browser-exports.md`). The build
   imports three compiled files from kgf-sparql's `lib/` by path, resolves their dependencies
   from its `node_modules`, and needs it built. `../frink-query-ui` (Vite) needs the same.
2. **Automated tests.** Every check so far was by hand in a browser. A harness that drives the
   page against the live endpoint, or kgfq's fixture servers (`kgf build` + `kgf serve`), with
   `test/fake_llm.py` for the model, would guard the loop, the budgets and the sanitizer.
3. **Receipts and log in kgfq's schemas** (`../kgfq/docs/receipt.schema.json`,
   `log-record.schema.json`), so kgfq can import or replay a session.
4. **A free default model** (the discussion of 2026-09-25). In order: a model in the tab
   (Chrome's Prompt API, stable for pages since Chrome 148; WebLLM elsewhere) with a smaller
   tool set; a one-click OpenRouter sign-in for its free models (50 requests a day, about one
   question); a key for real work. A Cloudflare Workers AI free allocation (10,000 neurons a
   day, shared by all visitors) only if an event needs a hosted default. The more the page
   decides in code, the smaller the model can be.

   *2026-09-28:* A hosted default is wanted after all: a free tier at our expense. That
   would change §0's "is not hosted", so it is proposed here, not decided. Candidates from §2's
   trial: gemma4:26b-a4b (MoE, 3.8B active, 16 GB, 4/5) and qwen3.6:27b (dense, 5/5, a GPU's
   worth of work). Unchecked: timings on the serving hardware, repeat runs, harder questions,
   thinking off (both turn it off cleanly with `reasoning_effort: "none"`), qwen3.8:27b (needs
   an Ollama newer than 0.30.11). Calls cannot be limited to this page, since anything it sends
   can be replayed. The gate is sketched as a proxy in front of the model server, which is never
   exposed. The proxy pins the page's system prompt and tools by hash and sets the model,
   `max_tokens` and turns. It gives each visitor a quota, on a token issued after a human
   check, and keeps a bounded queue on fixed hardware that answers "busy" when full. It accepts
   an answer only after a tool call: lfm2.5:8b wrote the omelet recipe D15 forbids.
5. **Claude and ChatGPT as hosts.** Published as a claude.ai artifact, the page could call
   Claude on the viewer's plan through the `sample` capability (unchecked: free plans, and
   whether the sandbox reaches the KGF endpoint). An MCP App would put the operations inside
   Claude or ChatGPT; ChatGPT needs a hosted MCP server.
6. **Server gaps, filed:** kgf-rs#21 (summary card hides small classes), #22 (`/schema`
   predicate drill empty without a class), #23 (`labels=true` on `/fragment`, `/describe`,
   `/sample`; `/labels` refuses `lang` and `label_source`).
7. **Page fixes from the local-model trial** (§2, 2026-09-28). The first landed (D9 note);
   the rest are open.
   - Done: `list_graphs` is shown whole.
   - A reply cut off at the context limit (`finish_reason: "length"`) shows nothing and no
     notice. qwen3.5:9b ended two questions that way. The OpenAI adapter should say so, as
     D10's budgets do.
   - `count` with only a class as object counts every triple naming it, not its members:
     gemma4 answered 100 courts for scales' 94. The description should send a member count to
     `schema`'s entities or to `count` with `rdf:type`.
   - Nothing bounds how much of the context tool results take. One `read_table` of 200
     `describe` rows added about 13k tokens; qwen3.5:9b filled 32k twice. A token budget beside
     D10's model turns, and a smaller `read_table` limit.
   - The `sql` description says to CAST for arithmetic. Two models cast triple counts to
     INTEGER, which overflows at 6 billion, before trying BIGINT. Name BIGINT.
   - Ranking by eye: qwen3-coder:30b and lfm2.5:8b misread the three largest graphs off the
     list; the two that answered right sorted in `sql`. A prompt line to rank and count in `sql`
     is the candidate fix; unchecked.
   - The trial ran by hand in a browser pane through `test/meter_llm.py`. Item 2's harness
     should rerun its questions, three times per model.
