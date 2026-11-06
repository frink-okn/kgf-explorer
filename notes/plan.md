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

*2026-11-03:* an effort setting, Anthropic only: `output_config.effort`, low to max, or unset
for the model's own default (medium on Opus 5.5 and Haiku 5.5, high on Opus 5 and Sonnet 5.5).
It is read at each message, like the model turns, so changing it keeps the conversation: the
model is the same and its history stays valid. Added to try Haiku 5.5 at high for §3 item 4;
Anthropic's notes put knowledge work and longer agent tasks there. A model without effort
(Haiku 4.5) answers 400, shown as D14 says. The OpenAI shape's `reasoning_effort` is not wired:
servers disagree on its values. Checked: the request bodies with fetch stubbed (set, unset, and
the fallback path for `claude-opus-5`), and the field in a browser, hidden for the other
providers and remembered per provider. Not checked against the API.

*2026-11-05:* a meter, and prompt caching on the Anthropic adapter. Each model call reports its
usage (uncached input, cache writes, cache reads, output); under each message the chat shows the
calls' totals, a per-call table, and the cost at list price for the four Anthropic models in
`PRICES` (`src/llm.js`, from the pricing page that day, Haiku 5.5's 100k-token second list
included), with the conversation's total. Other models are metered in tokens only, where the
server reports usage. Requests now carry a top-level `cache_control`, so each call reads the
previous one's prefix from the cache (§3 item 4 assumed this; the page did not do it). Checked:
`priceCall` against seven hand-worked cases, and the meter in a browser against
`test/fake_llm.py`, which now reports made-up usage (3 calls, 8,200 prompt tokens, sums
right). Not checked against the API: whether cache reads appear, and a real question's cost.
*Later that day:* checked against the API with `claude-haiku-5-5` (§3 item 4). Every call
after the first read the previous call's prompt from the cache, less 2 to 4 tokens; the first
call's 7,123 tokens match `count_tokens`; the meter's $0.014 matches the four counts at list
price by hand.

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

**D17. Where graphs meet** (2026-11-05). Graphs that hold the same IRIs join directly (D3,
the templates' `graphs`), and nothing told the model which do: Opus 5.5 here said
climatemodelskg and securechainkg share no identifiers, and securechainkg describes three of
climatemodelskg's Sources by their own IRIs (§2, the climate-model question). Four changes:
- `terms` (doc 03 §3.4.8, as kgf-navigator's vocabulary page uses it): one to eight prefixes,
  every graph by default, the exact number of distinct IRIs under each by position, from two
  binary searches over each graph's dictionary. With `list`, the terms themselves, from each
  graph that uses the prefix. `https://climatepub4kg.github.io/` over 47 graphs: 47 requests,
  13.5 KiB, 339 ms, in climatemodelskg and securechainkg (3 subjects, 1 predicate, 1 object);
  listed, the 3 are CESM2, GFDL-CM4 and GFDL-ESM4. It also picks graphs by identifier scheme:
  MONDO IRIs are in 12 graphs, identifiers.org CAS IRIs in 4 (babel and three biobricks
  graphs), not in SAWGraph, which stores CAS numbers as literals.
- `count` asks every graph by default, keeping only graphs with matches (one graph asked keeps
  its row at zero), and takes `bind` as `fetch` does: one count per bound value per graph, by
  `QUERY /count` bindings (kgf-navigator N5; kgfq R6's `sharedKeys` by its bindings path).
  climatemodelskg's 394 Sources as subject over 47 graphs: 47 requests, 1.8 MiB, 550 ms; all
  394 matched, 3 of them in securechainkg (CESM2 20 triples, GFDL-ESM4 5, GFDL-CM4 4). Every
  graph answers for every value, zeros included, about 100 bytes each, so 10,000 values over 47
  graphs would be about 47 MB a position; the description sends a large column to `terms`
  first. The result says how many values matched in no graph (D8).
- `graph_summary` appends the namespace inventory from the summary's JSON form, which the
  Markdown card leaves out, with the IRIs under no declared prefix. The inventory follows the
  graph's own prefix table: securechainkg declares climatepub4kg's ontology namespace (its
  `name` predicate and `Source` class) but not `…/id/`, so the 3 Sources are among its 363,672
  subject IRIs under no prefix. A graph using another's IRIs is the case its own prefixes miss;
  `terms` with a site-wide prefix finds them.
- A prompt line: only the data says which graphs share IRIs, so before saying two do not
  connect, count one's namespaces in the other with `terms`, or bind a column with `count`.

Operations that ask many graphs send eight requests at a time and go on past a graph that
fails. `runDirect` keeps what arrived: a call returns its rows with an error, the contract is
`aborted` at the budget or `error`, the failures are verbatim by graph (D14), and the notes
count only graphs that answered. An optional `graphs` list starts empty in the form, so a click
gets the default. Not done: an operation from a graph to the graphs that use its namespaces. It
is `graph_summary` then `terms`, and waits for a model that misses with both in hand. Server
gaps, unfiled: namespaces in the Markdown card; IRIs under no prefix grouped, by host say;
bound counts without zeros; an overlap matrix beside the catalogue (kgf doc 18, kgf-navigator
§3 item 2).

Checked in a browser against the live endpoint: `terms` from the form and from code, counts
and lists, `role` subject; `count` over every graph (`sc:dependsOn`: securechainkg only,
29,787,749), one graph at zero, bound to 394 IRIs and to 15 literals (none matched, all
reported); `fetch` bound to listed terms (23 rows; the class and predicate unmatched); `sql`
over a bound count; `graph_summary` for securechainkg; a run stopped at 10 requests (aborted,
4 graphs answered, the rest named); an unknown graph and a bad prefix refused. Not checked with
a model: the climate question is to be asked again.

*2026-11-05, later:* asked again, Opus 5.5 found the link first time and Haiku 5.5 did not
(§2). Haiku counted securechainkg's namespaces in climatemodelskg and stopped; the link runs
the other way, and the prompt line said only "one's namespaces in the other". So the operation
held back above is built. `overlap`, for two to four graphs, counts each graph's own
namespaces (those its summary lists with subjects) in each of the others, both ways, with one
example IRI for each namespace held as subjects or objects. Shared vocabularies are skipped by
namespace (W3C, Dublin Core, FOAF, VANN, schema.org): climatemodelskg against every graph, both
ways, gave 72 rows (445 requests, 7.2 s), 70 of them those vocabularies. A namespace held only
as predicates goes in the note. The prompt line now says to call it before joining two graphs
by name or saying they do not connect.
- climatemodelskg and securechainkg: 13 requests, 222 ms, 2 rows, the first with CESM2 as its
  example.
- sawgraph and biobricks-toxcast: 24 requests, 1 row (3 OBO classes as objects) and no CAS
  link, which is by value.
- spoke-okn, spoke-genelab and ubergraph: 84 requests, 625 ms, 15 rows, NCBI Gene and OBO each
  way.

Every graph against every other would be 16,330 requests; that map is the server's (kgf doc
18). The summary's namespace section no longer says it comes from the JSON form, which the
model does not need. Checked in a browser against the live endpoint; not with a model.

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
- One full-mode question in three setups, 2026-11-03, one run each: "Which clinical biomarker
  genes change when human cells fly in space?" (biomarkerkg, spoke-genelab). Opus 5.5 through
  OKN-MCP: 118 of ~200 genes across 8 NASA studies, VCAM1 and CCL2 down most often. Haiku 5.5
  here: 218 of 229 at adjusted p < 0.05 and |log2FC| ≥ 1, read over every comparison in the
  human studies; it saw that up and down counts matched and gave no directions, without finding
  why. Opus 5.5 here: 439 of 466 at adjusted p < 0.05, from 4 comparisons it judged clean; 47
  moved the same way in two or more. Checked the same day through OKN-MCP's SPARQL:
  - Human studies hold 1,942 transcription comparisons. 116 are Space Flight against Ground
    Control, 116 the same pairs reversed, and 1,510 carry no flight or ground label. log2fc is
    group 1 against group 2 (`factor_space_1`, `factors_1`). Arms that match once the condition
    is stripped leave 28 comparisons in 10 studies; 14 in 6 when a material id is required, as
    OKN-MCP's `get_valid_contrasts` requires.
  - Opus here used OSD-188 twice (µg in flight against a cell-culture control and against a 1G
    hardware ground control; the graph labels no OSD-188 comparison flight or ground), OSD-635
    once, and one of OSD-937's four. It dropped OSD-516 for differing sex or medium, true of 30
    of its 36 and not of 6. It reached comparisons through the 332 that measure TP53, and said
    some could be missing.
  - Adjusted p < 0.05 passes 78–94% of the genes in each of six comparisons checked (OSD-188's
    three µg ones, OSD-635, two of OSD-937's). With |log2FC| ≥ 1 it is 0 of 15,509 (OSD-188, µg
    against the in-flight 1G centrifuge) to 5,930 of 11,242 (OSD-635). Opus counted on p alone
    and said nothing of 1,012 of its 1,112 results passing.
  - On the 14 strict comparisons, CCL2 is down in all 5 that measure it and VCAM1 down in 3 of
    5, as the OKN-MCP answer said. Haiku's top two: GDF15 changes in 3 of 4, 2 up and 1 down;
    ANXA3 up in 2 of 2. Haiku's table gave GDF15 "218 of 382" beside a share of 0.80; 218/382
    is 0.57.
  - None is a reference answer, which needs one definition of a clinical biomarker gene, the
    clean comparisons and a fold-change cutoff. What separated the answers was knowledge of the
    graph more than the model: OKN-MCP gives spoke-genelab's rules as a tool and in its schema
    notes, and this page has nothing on them (item 7).
- A second question, the same day: "Which PFAS found in water have EPA toxicity screening
  data?" (sawgraph, biobricks-toxcast). Opus 5.5 through OKN-MCP: 34; PFOS 31,957 observations
  and 1,510 ToxCast assay endpoints. Haiku 5.5 here: "six", with seven in its table, found by
  name searches ("perfluoro" and eight names) and joined on DSSTox ids built from ToxCast's; it
  said the list might be incomplete. Checked through OKN-MCP's SPARQL:
  - 34 SAWGraph contaminants have ToxCast data by CAS, over every sample medium; it is the
    verified count in OKN-MCP's join table. SAWGraph stores most CAS numbers without dashes,
    which the join rebuilds. Two are fluorinated insecticides (flubendiamide, hexaflumuron; PFAS
    only by OECD's broad definition), and perfluoro-4-isopropoxybutanoic acid is in 10 animal
    blood samples and no water. 31 PFAS measured in water have ToxCast data, 33 with the
    insecticides. Measured, not detected: non-detects were not separated.
  - PFOS: 31,957 observations on its two substance records (EGAD 28,264, Water Quality Portal
    3,693), 26,687 of them on water samples; the Portal's others are tissue (1,959), air (155)
    and sediment (66). 1,510 ToxCast endpoints (`RO_0000056`), as the slide said.
  - Haiku's seven are all among the 33. Its counts are triples, as it said: 1,515 ToxCast
    triples for PFOS's 1,510 endpoints, 35,520 SAWGraph triples for its 31,957 observations.
- A third, the same day: "Which climate models depend on software with known
  vulnerabilities?" (climatemodelskg, securechainkg). Opus 5.5 through OKN-MCP: CESM2 uses
  numpy (8 CVEs), torch (6) and lxml (6), among others. Haiku 5.5 here: the graphs do not
  connect. It read climatemodelskg's 42 regional models, listed their `DRIVEN_BY_SOURCE`
  without following it, and searched securechainkg for "RegCM", "COSMO", "WRF" and "REMO". It
  took no name match as evidence, and said it had checked a handful. Checked through OKN-MCP's
  SPARQL:
  - securechainkg uses climatemodelskg's own Source IRIs as subjects of `sc:dependsOn`, for 3
    of its 394 Sources: CESM2 (18 PyPI packages, 12 with a vulnerability), GFDL-ESM4 (numpy,
    scipy, setuptools) and GFDL-CM4 (numpy, setuptools). CESM2's numpy 8, torch 6 and lxml 6
    are exact; the slide names one model of three.
  - `dependsOn` names a package; `vulnerableTo` hangs on its versions (numpy's 8 on 114 of 153).
    The graph says a model uses a package some of whose versions were vulnerable, not that the
    version it uses is. Where the edges come from was not looked up; torch, dash and PyPDF2
    are odd for CESM2 itself.
  - In securechainkg, CESM2 is named by climatemodelskg's own `name`, not `schema:name`.
    Whether `search` reads it is unchecked. Full mode can make the join: a template over both
    graphs matches the shared IRI (`GRAPHS` in `src/tools.js`). The miss is the model's.
  - *2026-11-05:* Opus 5.5 here missed it too. It searched securechainkg for "climate model",
    "E3SM", "climate", "CESM" and "WRF", matched climatemodelskg's 394 Source names against
    securechainkg's software names (merra and modis came back), and said the two graphs share
    no identifiers. `search` does read the name: "CESM2" finds the Source, with no label, since
    the predicate is not one of securechainkg's label predicates; "CESM" does not, as `search`
    matches whole words. A match on securechainkg's `schema:name` misses it for the same
    reason. Nothing pointed the model at shared IRIs; D17 does.
  - *2026-11-05, with D17's `terms` and `count`:* Opus 5.5 here answered right first time.
    Haiku 5.5 did not. It matched 567 climate components to SecureChain package names (one hit
    with a CVE, the crate `bam`, which it declined to trust) and said the graphs share no IRIs,
    having counted only securechainkg's namespaces in climatemodelskg. Asked why, it counted
    the other way, found the 3 Sources and answered from `dependsOn`: CESM2 18 of 18 packages
    with a vulnerable version, GFDL-CM4 2 of 2, GFDL-ESM4 3 of 3, all checked. Six of CESM2's
    18 (GitPython, Jinja2, Pillow, PyPDF2, PyYAML, Requests) are capitalised IRIs with no
    triples; their lowercase IRIs have versions, every one with vulnerabilities. Haiku joined
    them by name and said so (D15). By securechainkg's own IRIs it is 12 of 18.
  - *2026-11-05, with D17's `overlap`:* Haiku 5.5 at its default effort answered right first
    time, and named all three models where the slide named one. CESM2's 12 packages with
    version data, each checked: numpy 8 CVEs on 114 of 153 versions, lxml 6 on 593 of 609,
    torch 6 on 39 of 40, scipy, setuptools and ujson 3, tqdm 2, dash, dask, distributed,
    docutils and pandas 1. GFDL-CM4 (numpy, setuptools) and GFDL-ESM4 (numpy, scipy,
    setuptools) match too. It left the six capitalised IRIs out as unchecked, rather than
    joining them by name, and said that `dependsOn` names a package while CVEs are on versions.
    One run; item 2's harness should repeat it. At about 1/35 of Opus 5.5's cost (§3 item 4),
    this is the case for Haiku 5.5 on cross-graph questions when the page does the check in
    code.

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

   *2026-11-03, Claude's API instead of our GPU:* the same gate, with our Anthropic key in the
   proxy. Misuse then costs money, not capacity, so the quotas set the bill's ceiling: a cap of
   100 Opus 5.5 questions a day holds it near $1,000 a month. Estimated, not metered on Claude.
   The token profile is §2's local trials: light, 4 calls with context to 12k tokens; typical,
   10 to 25k; heavy, 25 to 50k; mixed 30/50/20. Each call carries about 4.5k tokens of tools and
   system prompt and returns 650 (about 500 of them thinking); the answer is 800. Caching is
   5-minute. Claude's tokenizer was not run on the page's prompt, so the figures could be off by
   about 2×. Prices from Anthropic's pricing page that day, $/MTok in, out and cache read:
   Opus 5.5 4, 20, 0.20; Opus 5 5, 25, 0.50; Sonnet 5.5 2, 10, 0.10; Haiku 5.5 0.10, 0.50,
   0.01, five times that above a 100k-token prompt.
   - A question, cached, light / typical / heavy, then the mix and the mix uncached: Opus 5.5
     $0.13 / $0.30 / $0.72, $0.33, $1.04; Opus 5 mix $0.46, $1.30; Sonnet 5.5 $0.07 / $0.15 /
     $0.36, $0.17, $0.52; Haiku 5.5 $0.003 / $0.008 / $0.021, $0.009, $0.026, before its
     tokenizer's ~30% more tokens.
   - A month at the mix, 10 / 100 / 1,000 questions a day: Opus 5.5 $99 / $993 / $9,926;
     Sonnet 5.5 $50 / $496 / $4,963; Haiku 5.5 $3 / $28 / $277. Against a GPU server assumed at
     $1,500 a month, Opus 5.5 is cheaper below about 150 questions a day, Sonnet 5.5 below 300,
     Haiku 5.5 below 5,000.
   - Opus 5.5's cost is about half output, 39% cache writes and 12% cache reads. Thinking is
     output and cannot be turned off on Opus 5.5; effort is the control (D12, 2026-11-03). Every
     tool-result token is written to the cache once at 1.25× input, so item 7's smaller
     `read_table` cuts the writes.
   - The page sends no `cache_control`, so a key costs about 3× the cached figure on Opus 5.5
     today. The Anthropic default, `claude-opus-5`, costs more than Opus 5.5.
   - Opus 5.5, Sonnet 5.5 and Fable 5.1 answer a forced `tool_choice` (`any`, `tool`) with 400.
     The gate's first-tool rule becomes a prompt line and a proxy check that asks again, and
     guided mode's `toolFirst` fails on them. Haiku 5.5 accepts it but skips thinking that turn.
   - Haiku 5.5 costs about 1/35 of Opus 5.5. On §2's GeneLab question it counted every
     comparison, not only flight against ground; Opus 5.5 on the same page filtered them but
     found 4 of 28. A tier to try: Haiku 5.5 for anonymous visitors, Opus 5.5 after sign-in, and
     a button that moves a conversation up, since Opus 5.5 reads Haiku 5.5's thinking blocks.

   *2026-11-05, the fixed part counted:* `count_tokens` on full mode's system prompt and 16
   tools, for `claude-haiku-5-5` and `claude-opus-5-5`: 7,096 tokens on every call (system
   prompt 992; tools 6,104, which includes the API's own tool-use instructions), against the
   4.5k assumed above. The two models count it the same. Prose runs 3.19 characters a token,
   the tools' JSON 2.50; four a token undercounts both. Cached, the 7.1k costs Haiku 5.5 about
   $0.0015 on a 10-call question, against $0.0010 at 4.5k. Tool results, thinking and answers
   are the rest of a question and are not counted yet; the D12 meter is for that. Haiku 5.5
   is the target for the hosted default.

   *2026-11-05, one question metered* (D12's meter; Haiku 5.5, full mode, default effort): §2's
   climate-model question, answered right, in 15 calls. The prompt grew from 7,123 tokens to
   51,256, about 3,150 a call; 495,748 prompt tokens in all, 444,462 cache reads, 51,254 cache
   writes, 32 uncached. Output 6,447, 430 a call against the 650 assumed above, 1,473 on the
   last. $0.0141 at list price: cache writes 46%, reads 32%, output 23%. That sits between the
   typical estimate ($0.008, 10 calls to 25k) and the heavy one ($0.021, 25 calls to 50k). At
   this cost: $42 a month at 100 a day, $422 at 1,000, and Start's $500 cap holds about 1,200
   a day. The same tokens at list price: Sonnet 5.5 $0.24, Opus 5.5 $0.47 (34×). One
   question, one run.

   *The same question on Opus 5.5,* also right: 13 calls, the prompt to 34,415 tokens; 311,876 prompt
   tokens (277,435 cache reads, 34,413 writes, 28 uncached) and 3,263 output: 37% fewer prompt
   tokens than Haiku 5.5 and half its output. $0.293: writes 59%, reads 19%, output 22%. So
   21× Haiku 5.5 on the same question, not the 34× of the prices alone. At this cost, $879 a
   month at 100 a day; Build's $1,000 cap holds about 110 a day.

   *A larger question on Haiku 5.5:* "Which North Carolina manufacturers are also
   FDA-registered device makers?" (sudokn, the Medical Device KG). 20 calls; the prompt to
   80,293 tokens, 21k of it from one tool result (call 5); 1,087,405 prompt tokens (1,007,072
   cache reads, 80,291 writes, 42 uncached) and 8,185 output. $0.0242: writes 41%, reads 42%,
   output 17%. Every call rereads the prompt, so reads overtake writes as a question runs
   long. The last prompt is 80% of Haiku's 100k price step, past which each call bills at five
   times, cache reads included: the gate's context cap and a cap on one tool result's size
   both matter. The answer: 14 manufacturers, joined on name and ZIP after `overlap` found no
   shared IRIs, 4 exact matches and 10 prefix matches it called judgment calls. Read as good;
   not checked against the graphs.

   *Checked the same day through OKN-MCP's SPARQL:*
   - medical-device-kg holds 313 NC registration records (`md:RegistrationListingRecord` with
     `md:state` "NC"), 278 of them geocoded (`md:Facility`); Haiku read only the 278. SUDOKN
     holds 1,305 NC manufacturers at 1,640 locations. Same-ZIP pairs: 1,939, in 131 ZIPs.
   - Over those pairs, names normalized for case, punctuation and legal suffixes: 10 equal, 5
     where one is a prefix of the other, 2 that share only a first word. All 14 of Haiku's are
     among them; six of its prefix matches are equal once "LLC" and the like are dropped.
   - Missed: Beocare (28638) and Thunderbird Molding (27407), prefix matches whose
     registrations have no geocode; and Hanes Companies against Hanes Industries (28613), first
     word only. So 16 clear matches, 17 with Hanes.
   - All 17 registrations carry status 1 and expiry year 2026. Equal names at another NC ZIP
     are only second sites of two firms already matched (Elastic Therapy, Precision Fabrics).
   - OKN-MCP's join table holds this pair as a name join confirmed by ZIP (I3); the page has
     no join table, and Haiku reached the same method on its own.
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

   *2026-11-03,* from §2's GeneLab question:
   - Rules a graph's data needs are nowhere the model can read them. spoke-genelab's two
     (Space Flight against Ground Control, in that order; arms that match but for the
     condition) live in OKN-MCP's `get_valid_contrasts` and schema notes, not in KGF's
     descriptor, so each model here finds them or not. A kgf-rs issue, unfiled: usage notes per
     graph in the service descriptor, which `schema` could show.
   - A cutoff that most rows pass reads as a finding. A prompt line to say what share a filter
     keeps is the candidate; unchecked.
   - The join a pair of graphs needs is not something the page knows. OKN-MCP keeps verified
     recipes with their rewrites (SAWGraph's undashed CAS to `identifiers.org/cas/…`) and
     counts; here a model finds a key or does not, and Haiku listed PFAS by name, not from
     SAWGraph's substances (§2, the PFAS question). Whether the operations can do the CAS join
     (list the CAS values, rebuild dashes in `sql`, look the IRIs up in biobricks-toxcast) is
     unchecked. Where graphs share IRIs the operations can join them, but nothing tells the
     model which do: Haiku looked for climate models in securechainkg by name, and the link is
     climatemodelskg's own IRIs (§2, the climate-model question). *2026-11-05:* `terms` and
     bound `count` find shared IRIs, and the prompt says to look (D17).
8. **Guided mode, prototyped** (D16). Open:
   - A run stopped by a budget keeps nothing: the operations run under `runDirect`, which
     returns no rows on an error. D10 says keep what arrived. *2026-11-05:* `runDirect` takes a
     partial result now (D17); guided mode's operations do not return one yet.
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
