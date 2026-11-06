// A conversation kept as evidence (D18): what the model was given, what it said and thought,
// what each tool call returned to it, and the receipts behind those results. It is for reading
// runs afterwards — which operations a model reached for, where it lost the way across graphs,
// whether D15 held — so that changes to the prompt, the tools or the server rest on runs rather
// than impressions. The key is never in it.
//
// `history` is the adapter's own message list, the exact conversation the model was sent (its
// wire format: Anthropic content blocks with thinking, or chat-completions messages). `log` is
// the workspace's log with receipts, clicks included. When the page is served by serve.py, each
// transcript is written to runs/ as it grows; anywhere else it can be downloaded.

export const TRANSCRIPT_SCHEMA = 'kgf-explorer.transcript/0';

const BUILD = typeof KGF_EXPLORER_BUILD === 'string' ? KGF_EXPLORER_BUILD : 'unbuilt';

export class Transcript {
  constructor({ endpoint, settings, mode }) {
    const started = new Date().toISOString();
    const who = (settings.model || settings.provider).replace(/[^A-Za-z0-9.-]+/gu, '-').slice(0, 60);
    this.chat = null;
    this.workspace = null;
    this.record = {
      schema: TRANSCRIPT_SCHEMA,
      id: `${started.slice(0, 19).replace(/:/gu, '-')}-${who}-${Math.random().toString(16).slice(2, 8)}`,
      build: BUILD,
      started,
      updated: started,
      endpoint: {
        origin: endpoint.origin,
        implementation: endpoint.descriptor?.implementation ?? null,
        releases: Object.fromEntries([ ...endpoint.graphs.values() ].map(g => [ g.id, g.current ])),
      },
      model: {
        provider: settings.provider,
        model: settings.model || null,
        ...(settings.provider === 'anthropic' ? {} : { base_url: settings.baseURL || null }),
      },
      mode,
      // What the run was for, when it came from serve.py's queue: { id, run }.
      case: null,
      // The system prompts and tool lists messages were sent with, by digest: one per conversation
      // unless the page changed under it.
      prompts: {},
      messages: [],
      history: null,
      log: null,
    };
  }

  /** Starts one message: the person's text and the settings it ran under. */
  begin(text, { system, tools, effort, maxTurns, budget }) {
    const prompt = digest(JSON.stringify({ system, tools }));
    this.record.prompts[prompt] ??= { system, tools };
    const message = {
      n: this.record.messages.length + 1, text, started: new Date().toISOString(), finished: null,
      prompt, effort: effort ?? null, max_turns: maxTurns, budget,
      outcome: 'running', error: null, notices: [], calls: [], tools: [],
    };
    this.record.messages.push(message);
    return message;
  }

  /** The current state, ready to write: history and log are read at this moment. */
  json() {
    this.record.updated = new Date().toISOString();
    this.record.history = this.chat?.messages ?? [];
    this.record.log = this.workspace?.log ?? [];
    return JSON.stringify(this.record);
  }
}

/** FNV-1a, 64 bits: enough to tell prompts apart, and synchronous in any context. */
function digest(text) {
  let h = 0xcbf29ce484222325n;
  for (const byte of new TextEncoder().encode(text)) {
    h = BigInt.asUintN(64, (h ^ BigInt(byte)) * 0x100000001b3n);
  }
  return h.toString(16).padStart(16, '0');
}

/**
 * serve.py's recorder, if this page is served by it: `GET runs/` answers with what it is.
 * Any other server answers 404 or a page, and transcripts stay in the tab.
 */
export async function findRecorder() {
  try {
    const response = await fetch('runs/', { headers: { accept: 'application/json' }, cache: 'no-store' });
    const body = response.ok ? await response.json() : null;
    return body?.recorder === 'kgf-explorer' ? body : null;
  } catch {
    return null;
  }
}

/**
 * Writes transcripts to the recorder, one file per conversation, rewritten as it grows. Writes
 * are queued, so an older state never lands after a newer one, and coalesced: a write asked for
 * while one is in flight sends the state at the time it goes.
 */
export class Recorder {
  constructor(onError) {
    this.onError = onError;
    this.queue = Promise.resolve();
    this.pending = new Set();
  }

  save(transcript) {
    if (this.pending.has(transcript)) {
      return this.queue;
    }
    this.pending.add(transcript);
    this.queue = this.queue.then(async() => {
      this.pending.delete(transcript);
      try {
        const response = await fetch(`runs/${transcript.record.id}.json`, {
          method: 'PUT', headers: { 'content-type': 'application/json' }, body: transcript.json(),
        });
        if (!response.ok) {
          throw new Error(`${response.status} ${await response.text()}`);
        }
      } catch (error) {
        this.onError(error);
      }
    });
    return this.queue;
  }
}
