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

**D16. Guided mode, for weaker models and first looks** (proposed and prototyped
2026-09-28). A second list of operations (`src/guided.js`) beside D1's, with the same two
surfaces: `graphs`, `find`, `classes`, `members`, `links`, `follow`, `common`. They take
handles the page issued — `e1` an entity, `s1` a set, `c1` a class — never an IRI, a pattern
or SQL, so a model cannot garble or invent one; a graph id is an enum. What the model sees is
small and worked out in code: graphs ranked by size; classes with member counts; an entity's
links as a numbered menu with exact counts and examples (the candidate predicates from
`/schema`'s `class-properties` and `class-relations`, one `/count` each); a set's exact size,
classes and first ten members, labeled. A set shows the one SPARQL query that asks for it,
written by the page (D2), which is the mode's introduction to querying. Every operation goes
through `Workspace.run` with a receipt, and is a button: a person can browse this way with no
model. A message's first turn must call a tool (`tool_choice` "required", or "any" for
Anthropic). It cannot join on values, repair them or do arithmetic; the district question
stays in the full mode, which is unchanged. The failures it answers are §2's: garbled and
invented IRIs, sizes ranked by eye, triples counted as members, contexts filled by
`read_table`.

*2026-09-28, later:* asked what cells are in the liver, gemma4 answered
from NCIT: `find` kept three hits a graph, ubergraph's were NCIT's, and UBERON's liver was
only met in biomarkerkg (2 links), with nothing saying it was in six more graphs. Now an
entity's handle is its IRI's, whatever graph found it, and `links` covers every graph that
holds it (up to four, most triples first; the rest named), each link with its graph: whether
a graph holds it is a `/terms` lookup, its triples there a `/describe?limit=1`. Links are
named by label ("part of", not `BFO_0000050`). `find` searches with `role=label` first
(ubergraph's "liver" put UBERON's liver 59th of 200 in full text, behind 151 axiom nodes, and
6th by label), drops skolemized blank nodes, and merges by IRI: label equal to the words
first, then the number of graphs holding it, then each graph's order, since scores are not
comparable across graphs (doc 03 §3.4.5). A set says where its members come from (`CL 17,
UBERON 74`): in an ontology graph every member is an `owl:Class`, and the source is what
tells cell types from anatomy. `narrow` keeps one source or class, with a `FILTER` in the
set's SPARQL. Eight operations.

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
- The same five in guided mode (D16), same setup, the same day: gemma4:26b-a4b 5/5 at 2.3
  model calls an answer; qwen3.5:9b 5/5; lfm2.5:8b 4/5, writing the omelet recipe even after
  searching for it. 66 model calls, none refused by a schema or an operation; the largest prompt
  9.8k tokens. The omelet was run again after the first-tool rule, and lfm2.5's genes and
  courts after two prompt lines (a graph id is not search text; a "which" question follows the
  link); the other answers came before those changes. By hand: `find` across all 45 graphs,
  54 requests in 2.4 s; asthma's links menu, 36 requests in 269 ms; following a link from a
  465-gene set, one bound batch, 111 ms.
- After the cross-graph change (D16 note): `find` "liver", 62 requests in 1.2 s, UBERON's liver
  first (in four graphs' label searches); its links across ubergraph, spoke-genelab,
  gene-expression-atlas-okn and biobricks-aopwiki, 148 requests in 1.25 s; `← part of` in
  ubergraph, 91 terms (UBERON 74, CL 17); `narrow` to CL, 17. gemma4, asked what cells are in
  the liver, took find → links → follow and named CL cell types (4 model calls); it did not
  narrow, so it gave no count.
- lfm2.5:24b (LFM2.5-24B-A2B, MoE, about 2B active), 2026-10-15, kgf 0.4.0 with 47 graphs:
  the five questions, worded and metered as on 2026-09-28, one run each on two runtimes.
  Ollama 0.40.4 serves Liquid's GGUF (Q4_K_M, 15 GB) on its llama.cpp runner; its MLX runner
  has no `lfm2moe`. mlx-lm 0.32.0 served LiquidAI/LFM2.5-24B-A2B-MLX-4bit (13 GB) with
  Ollama's sampling (temperature 0.1, top-k 50, repeat penalty 1.05) and `--max-tokens 32768`.
  The answers had not moved: 465 genes; 94 courts, the members of `jxdm#Court` (100 triples
  name it).
  - Full mode, GGUF 3/5 and MLX 3/5. Both ranked the graphs by eye: GGUF put kwg-hazards
    (1.278B) third, ahead of medical-device-kg (1.285B); MLX named spatialkg and fiokg. Both
    said asthma has no genes. GGUF took 33 model calls and its prompt reached 32.2k of 32k;
    MLX wrote asthma's IRI as `https://`, fetched one invented pattern 18 times and stopped at
    the 50-turn cap with a 47.8k-token prompt, since mlx-lm sets no context limit. GGUF read 94
    courts off `schema`'s entities but named `scales#Court`, which has none. Tool calls carrying
    an IRI no message held: GGUF 7, MLX 33.
  - Guided mode, GGUF 5/5 (15 model calls, 54 s of model time in all) and MLX 4/5: after 12
    operations it added a one-line omelet recipe, marked as not from the graphs, which D15
    still rules out. No invented IRIs.
  - Speed, one model loaded: 700 tokens at 114–115 tok/s on GGUF, 94–97 on MLX; a 7.9k-token
    prompt read at 1,575 tok/s and 1,288. On this M2 Max, MLX is the slower runtime for this
    model.
  - Both loaded at once held about 28 GB of weights, with 3.6 GB of disk free for swap; the
    Mac ran out of memory and needed a force quit. A trial loads one model at a time.

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

   *2026-10-15:* lfm2.5:24b (MoE, about 2B active, 15 GB) scored 5/5 guided and 3/5 full on
   GGUF (§2), at 114 tok/s on the M2 Max. With half gemma4's active parameters it is a
   candidate for guided mode; unchecked on the serving hardware and in repeat runs. Ollama is
   now 0.40.4, so qwen3.8:27b can be tried.

   *2026-11-02:* The default has to carry full mode; guided mode (D16) has not proved useful
   in use. A full-mode question is 10–33 model calls with prompts to 32k tokens (§2), and every
   call carries 11.3k characters of tool definitions and 2.8k of system prompt, about 3.5k
   tokens. Free tiers, read from each provider's pages that day, all need the visitor to sign
   in somewhere; the preflights were sent with the OpenAI SDK's headers:
   - OpenRouter `:free`: 50 requests a day per account, 20 a minute; 1,000 a day once $10 of
     credits have ever been bought. With tools and `tool_choice`: Nemotron 3 Ultra 550B-A55B
     (served by NVIDIA), Gemma 4 31B and Gemma 4 26B-A4B (served by Google AI Studio). One to
     five full-mode questions a day. The PKCE key exchange answers a cross-origin preflight, so
     a sign-in button needs no server.
   - Gemini key: 3.8 Flash, 3.6 Flash and 3.5 Flash-Lite free, no Pro model. Limits show only
     after sign-in; a third party gives 3.8 Flash 20 requests a day, one full-mode question.
     Free-tier prompts improve Google's products. The OpenAI-compatible endpoint's preflight
     allows `authorization, content-type` and answers 403 to the SDK's `x-stainless-*`.
   - Groq: gpt-oss-120b and Qwen 3.8 27B at 8K tokens a minute and 200K a day. A full-mode
     prompt passes 8K within a few calls.
   - Not a free path: Cerebras (a $5, 30-day trial after a card), NVIDIA's API catalog (no
     CORS headers), GitHub Models (retired 2026-07-30), Mistral (limits unpublished; its
     preflight also refuses `x-stainless-*`). Hugging Face, Pollinations and Puter bill the
     visitor; Hugging Face gives free accounts no credits.

   *2026-11-02, the gate:* the 2026-09-28 sketch, worked through. Only the model call moves:
   the proxy holds the conversation and relays the model's turns, and every tool call still
   runs in the tab through `Workspace.run`, so KGF requests, joins, tables, receipts and the
   log stay where D1, D4, D5 and D11 put them. §0 loses "is not hosted"; D12 gains a hosted
   default beside a key, with its own adapter. Calls still cannot be limited to this page. On
   our own GPU, misuse costs capacity, not money, so the gate aims at a fair share and staying
   up:
   - The proxy holds the conversation. The page sends the visitor's text, or results for the
     calls the model made last turn (ids must match, each under a size cap); the proxy adds the
     system prompt and tools and sets the model, temperature and `max_tokens` a turn. A client
     cannot write the model's turns, which checking the prompt by hash still allowed, and every
     request is this page partway through a question.
   - Per question: the first turn calls a tool (`tool_choice: "required"`), D10's turn cap, and
     a cap on context tokens, which is item 7's missing token budget.
   - Per person: a short-lived signed token after Cloudflare Turnstile (a small quota) or a
     sign-in through ORCID, GitHub or CILogon (a larger one). A quota on an account holds; one
     on an IP leaks.
   - Overall: one request in flight per person, a bounded queue, "busy" when full.
   - CORS pinned to the page's origin. It stops no script, but another site cannot put the model
     behind its visitors' browsers; it would have to call from its own servers, which a per-IP
     limit catches. Sign-in redirects are pinned to the origin too.

   What gets through: the visitor's text and tool results are free text, so someone speaking
   the protocol can fake results and ask for an essay. They get a 27B model for a few questions
   a day, under a prompt about graphs, with output capped each turn: less than OpenRouter's free
   Nemotron 3 Ultra. What is left is floods and scrapers, which the quotas answer. Verifying
   tool results would need kgf-rs to sign responses, and would not cover a `sql` table, which
   the tab computes.

   Sizing, unchecked on serving hardware: sent whole each turn, a full-mode question prefills on
   the order of 300k tokens; with vLLM's or SGLang's prefix caching, about its last prompt
   (~32k), since each turn adds only results. The proxy keeps a session on one server so the
   cache hits. Candidates from §2: qwen3.6:27b (5/5 full, 140 s a question on the M2 Max),
   gemma4:26b-a4b (4/5); qwen3.8:27b untried. A 27B dense model at 8 bits is about 27 GB of
   weights; how many 32k conversations the rest of an 80 GB GPU holds is to be measured.
5. **Claude and ChatGPT as hosts.** Published as a claude.ai artifact, the page could call
   Claude on the viewer's plan through the `sample` capability (unchecked: free plans, and
   whether the sandbox reaches the KGF endpoint). An MCP App would put the operations inside
   Claude or ChatGPT; ChatGPT needs a hosted MCP server.
6. **Server gaps, filed:** kgf-rs#21 (summary card hides small classes), #22 (`/schema`
   predicate drill empty without a class), #23 (`labels=true` on `/fragment`, `/describe`,
   `/sample`; `/labels` refuses `lang` and `label_source`).
7. **Page fixes from the local-model trials** (§2, 2026-09-28 and 2026-10-15). The first
   landed (D9 note); the rest are open.
   - Done: `list_graphs` is shown whole.
   - A reply cut off at the context limit (`finish_reason: "length"`) shows nothing and no
     notice. qwen3.5:9b ended two questions that way. The OpenAI adapter should say so, as
     D10's budgets do. mlx-lm's server stops a reply at 512 tokens unless started with
     `--max-tokens`, and the adapter sends no limit, so long replies from one end this way.
   - A bare URL with a Markdown escape links wrong (D13). lfm2.5:24b wrote
     `**http://purl.obolibrary.org/obo/DOID\_2841**`, valid CommonMark; markdown-it 15.0.2's
     linkify keeps the backslash, so the link goes to `…/DOID%5C_2841` and the text shows
     `DOID\_2841` (`src/markdown.js`, `linkify: true`). Escapes outside a URL, and IRIs in
     backticks or `<…>`, render right. Every OBO IRI a model escapes this way breaks.
   - `count` with only a class as object counts every triple naming it, not its members:
     gemma4 answered 100 courts for scales' 94. The description should send a member count to
     `schema`'s entities or to `count` with `rdf:type`.
   - Nothing bounds how much of the context tool results take. One `read_table` of 200
     `describe` rows added about 13k tokens; qwen3.5:9b filled 32k twice. A token budget beside
     D10's model turns, and a smaller `read_table` limit. lfm2.5:24b on mlx-lm, which sets no
     context limit, reached 47.8k tokens on the genes question.
   - The `sql` description says to CAST for arithmetic. Two models cast triple counts to
     INTEGER, which overflows at 6 billion, before trying BIGINT. Name BIGINT.
   - Ranking by eye: qwen3-coder:30b and lfm2.5:8b misread the three largest graphs off the
     list; the two that answered right sorted in `sql`. A prompt line to rank and count in `sql`
     is the candidate fix; unchecked. lfm2.5:24b ranked by eye on both runtimes (2026-10-15).
   - The trial ran by hand in a browser pane through `test/meter_llm.py`. Item 2's harness
     should rerun its questions, three times per model.
8. **Guided mode, prototyped** (D16). Open:
   - A run stopped by a budget keeps nothing: the operations run under `runDirect`, which
     returns no rows on an error. D10 says keep what arrived.
   - A set's or a class's links menu counts the whole class, not the set; only `follow` is
     exact for a set.
   - `tool_choice: "required"` is checked only against Ollama; a server that refuses it fails the
     message. mlx-lm 0.32.0 ignores the field, so the first-tool rule is not enforced there;
     lfm2.5:24b called a tool first anyway, 5 of 5 (2026-10-15).
   - Five questions, one run each. A larger set belongs in item 2's harness, three runs per
     model, with cross-graph questions (`links` with `graph`, then `common`), which were tried by
     hand only.
   - lfm2.5:8b is not a candidate: it answers from its own knowledge after looking (D15).
     lfm2.5:24b declined the recipe on GGUF in both modes; on MLX, in guided mode, it added one
     line of recipe after looking.
   - For item 4: guided mode makes a 6.6 GB model (qwen3.5:9b) a candidate for the free
     default, and gemma4:26b-a4b the stronger one. Unchecked on CPU.
   - A set's links cover its own graph only; an entity's cover every graph. A set's members'
     other graphs are not yet looked for.
   - "liver cell" finds no CL term: no graph labels hepatocyte so. Words that describe a thing
     rather than name it need the path (find the organ, follow part of, narrow).
   - For kgf-rs, not filed: doc 03 §3.4.5 gives `/search` `fields` and `types=true`; kgf 0.3.0
     takes `role`, `predicate` and `labels`, and refuses `fields`. Full-text ranking puts OWL
     axiom literals, served as skolem IRIs, above the labels of the classes they annotate.
