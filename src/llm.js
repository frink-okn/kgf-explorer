// Bring-your-own-model chat. The key goes from this page straight to the provider named here
// and nowhere else; the page has no server. Two wire formats cover the field: Anthropic's
// Messages API through its SDK, and the OpenAI chat-completions shape, which OpenAI,
// OpenRouter and most local servers (Ollama, LM Studio) speak.

import Anthropic from '@anthropic-ai/sdk';
import OpenAI from 'openai';

import { lastTurnNote } from './prompt.js';

export const PROVIDERS = {
  // efforts: the levels `output_config.effort` takes; unset, each model uses its own default.
  anthropic: { label: 'Anthropic — Claude API key', model: 'claude-opus-5', keyHint: 'sk-ant-…', efforts: [ 'low', 'medium', 'high', 'xhigh', 'max' ] },
  openai: { label: 'OpenAI — API key', base: 'https://api.openai.com/v1', model: '', keyHint: 'sk-…' },
  openrouter: { label: 'OpenRouter — one key, many models', base: 'https://openrouter.ai/api/v1', model: '', keyHint: 'sk-or-…' },
  custom: { label: 'OpenAI-compatible — custom URL', base: 'http://localhost:11434/v1', model: '', keyHint: 'often unused locally' },
  // No key: the gate holds the model's, and the model is the one its signed manifest names.
  gate: { label: 'Free — RENCI\'s Qwen through the FRINK gate', base: KGF_GATE_URL || 'http://127.0.0.1:8787', model: '', keyless: true },
};

// Model calls one message may make; the page's budget panel sets it per send.
export const DEFAULT_TURNS = 50;

function closingNotice(turns) {
  return `Reached ${turns} model turns for this message: the model is answering from what it has, with no more tools. ` +
    'Raise "model turns" in the budget, or reply "continue".';
}

/**
 * Set on what `execute` returns when that call ends the message: no model turn follows it
 * (a map, D19). A symbol key, so it never reaches the model's JSON.
 */
export const ENDS = Symbol('ends the message');

/**
 * How a message's last allowed turn goes (D10): with tools off and the full-mode note, or as
 * `h.lastTurn` says — its note and notice, and `only`, the tools that still run. Those keep
 * every tool in the request (a different list would miss the cache) and run only `only`.
 */
function lastTurn(h, turns) {
  return {
    note: h.lastTurn?.note(turns) ?? lastTurnNote(turns),
    notice: h.lastTurn?.notice(turns) ?? closingNotice(turns),
    only: h.lastTurn?.only ?? null,
  };
}

/** A call the last turn does not run, answered so the history stays whole. */
const NOT_RUN = { error: 'Not run: this was the last turn, and only the tools it names run.' };
// Models that take Anthropic's server-side refusal fallback (`fallbacks: "default"`).
const FALLBACK_MODELS = new Set([ 'claude-opus-5', 'claude-fable-5-1' ]);

// Models whose thinking comes back as empty text unless asked for (`display` defaults to
// "omitted"). Summarized, it is billed the same, and a transcript can show why each call was
// made (D18). Not on a turn that forces a tool, which may not take thinking.
const SUMMARIZED_THINKING = new Set([ 'claude-opus-5-5', 'claude-opus-5', 'claude-sonnet-5-5', 'claude-haiku-5-5', 'claude-fable-5-1' ]);

/**
 * List prices in US dollars per million tokens, from Anthropic's pricing page on 2026-11-05:
 * base input, 5-minute cache write, cache read, output. Haiku 5.5 alone has a second list for a
 * request whose prompt (uncached input, cache writes and cache reads together) is over 100,000
 * tokens. A model not listed is metered in tokens only.
 */
export const PRICES = {
  'claude-haiku-5-5': { input: 0.10, write: 0.125, read: 0.01, output: 0.50, long: { over: 100_000, input: 0.50, write: 0.625, read: 0.05, output: 2.50 } },
  'claude-sonnet-5-5': { input: 2, write: 2.50, read: 0.10, output: 10 },
  'claude-opus-5-5': { input: 4, write: 5, read: 0.20, output: 20 },
  'claude-opus-5': { input: 5, write: 6.25, read: 0.50, output: 25 },
};

/** A call's cost at list price, or null for a model PRICES does not list. */
export function priceCall(call) {
  const list = PRICES[call.model];
  if (!list) {
    return { cost: null, long: false };
  }
  const long = Boolean(list.long) && call.input + call.cacheWrite + call.cacheRead > list.long.over;
  const r = long ? list.long : list;
  return { cost: (call.input * r.input + call.cacheWrite * r.write + call.cacheRead * r.read + call.output * r.output) / 1e6, long };
}

/** One model call's tokens as Anthropic reported them; `input` is the uncached part. */
function meterAnthropic(message) {
  const u = message.usage ?? {};
  const call = {
    model: message.model, input: u.input_tokens ?? 0, cacheWrite: u.cache_creation_input_tokens ?? 0,
    cacheRead: u.cache_read_input_tokens ?? 0, output: u.output_tokens ?? 0,
  };
  return { ...call, ...priceCall(call) };
}

/** The same record from a chat-completions response, where the server reports usage at all. */
function meterOpenAI(response, model) {
  const u = response.usage;
  if (!u) {
    return null;
  }
  const cached = u.prompt_tokens_details?.cached_tokens ?? 0;
  return {
    model: response.model || model, input: (u.prompt_tokens ?? 0) - cached, cacheWrite: 0,
    cacheRead: cached, output: u.completion_tokens ?? 0, cost: null, long: false,
  };
}

export function createChat({ provider, apiKey, model, baseURL, mode }) {
  if (provider === 'gate') {
    if (mode !== 'full') {
      throw new Error('The free model runs in full mode only: the gate takes only the prompt and operations this build signed, which are full mode\'s.');
    }
    return new GateChat({ base: baseURL || PROVIDERS.gate.base });
  }
  if (provider === 'anthropic') {
    if (!apiKey) {
      throw new Error('Enter an Anthropic API key under "Model" first. It is sent only to api.anthropic.com.');
    }
    return new AnthropicChat({ apiKey, model: model || PROVIDERS.anthropic.model });
  }
  if (!model) {
    throw new Error('Name a model for this provider (for OpenRouter, e.g. "anthropic/claude-opus-5" or an OpenAI model id).');
  }
  return new OpenAIChat({ apiKey: apiKey || 'unused', model, baseURL: baseURL || PROVIDERS[provider].base });
}

/**
 * The handler object each `send` takes:
 *   system, tools            — the prompt and the operations (name, description, input_schema)
 *   execute(name, input)     — runs one operation; resolves to what the model should see
 *   onText(delta)            — streamed assistant text
 *   onTurnStart()            — a new model turn began
 *   onStatus(label)          — what the wait is for, when the adapter knows more than that a
 *                              turn began (the gate's visitor token, the model thinking)
 *   onNotice(text)           — something the person should see that is not the model's text
 *   onUsage(call)            — one model call's tokens (model, input, cacheWrite, cacheRead,
 *                              output) and cost, null where no price is listed
 *   onCall(record)           — one model call for the transcript (D18): turn, ms, model, stop
 *                              reason, tool_choice, usage; what a refusal cut off; or the error
 *   maxTurns                — model calls this message may make, the last with tools off
 *   lastTurn                 — optional { note(turns), notice(turns), only }: the last turn
 *                              keeps its tools and runs only those named in `only` (D19)
 *   toolFirst                — the message's first turn must call a tool (guided mode, D16)
 * A result `execute` marks with ENDS ends the message once that turn's results are in.
 *   signal                   — aborts the whole exchange
 */
class AnthropicChat {
  constructor({ apiKey, model }) {
    this.client = new Anthropic({ apiKey, dangerouslyAllowBrowser: true });
    this.model = model;
    this.messages = [];
  }

  async send(text, h) {
    // A message that ended on a tool call (a map, D19) left the results as the last user turn;
    // the next message's text joins that turn, since turns must alternate.
    this.appendNote(text);
    const tools = h.tools.map(t => ({ name: t.name, description: t.description, input_schema: t.input_schema, eager_input_streaming: true }));
    const maxTurns = Math.max(1, h.maxTurns ?? DEFAULT_TURNS);
    const last = lastTurn(h, maxTurns);
    let jsonRetries = 0;
    let closing = false;
    for (let turn = 0; ; turn++) {
      if (!closing && turn >= maxTurns - 1) {
        closing = true;
        this.appendNote(last.note);
        h.onNotice(last.notice);
      }
      const choice = closing && !last.only ? { type: 'none' } : h.toolFirst && turn === 0 ? { type: 'any' } : null;
      // cache_control caches the conversation so far at each call, and the next call reads it
      // back: a full-mode question is 10–33 calls over one growing prefix (§3 item 4).
      const params = {
        model: this.model, max_tokens: 64000, system: h.system, tools, messages: this.messages,
        cache_control: { type: 'ephemeral' },
        ...(choice ? { tool_choice: choice } : {}),
        ...(h.effort ? { output_config: { effort: h.effort } } : {}),
        ...(SUMMARIZED_THINKING.has(this.model) && !h.toolFirst ? { thinking: { type: 'adaptive', display: 'summarized' } } : {}),
      };
      const stream = FALLBACK_MODELS.has(this.model) ?
        this.client.beta.messages.stream({ ...params, betas: [ 'server-side-fallback-2026-07-01' ], fallbacks: 'default' }, { signal: h.signal }) :
        this.client.messages.stream(params, { signal: h.signal });
      h.onTurnStart();
      stream.on('text', delta => h.onText(delta));
      const started = Date.now();
      const call = { turn, tool_choice: choice?.type ?? 'auto' };
      let message;
      try {
        message = await stream.finalMessage();
        jsonRetries = 0;
      } catch (error) {
        h.onCall?.({ ...call, ms: Date.now() - started, ...failure(error) });
        // Only a tool input the SDK could not parse is re-issued; everything else is thrown.
        const unparsed = !(error instanceof Anthropic.APIError) && /^Unable to parse tool parameter JSON/u.test(error?.message ?? '');
        if (!unparsed || h.signal?.aborted || jsonRetries++ >= 2) {
          throw error;
        }
        h.onNotice('A tool call arrived malformed; asking again.');
        continue;
      }
      const usage = meterAnthropic(message);
      h.onUsage?.(usage);
      h.onCall?.({
        ...call, ms: Date.now() - started, model: message.model, stop: message.stop_reason, usage,
        // A refusal's turn is kept out of the conversation; the transcript keeps what it said.
        ...(message.stop_reason === 'refusal' ? { stop_details: message.stop_details ?? null, dropped: message.content } : {}),
      });
      if (message.stop_reason === 'refusal') {
        // A refusal can cut a tool call off mid-input: run nothing from this turn, keep nothing of it.
        h.onNotice('The model declined this request.');
        return;
      }
      if (message.stop_reason === 'pause_turn') {
        this.messages.push({ role: 'assistant', content: message.content });
        continue;
      }
      const uses = message.content.filter(b => b.type === 'tool_use');
      if (uses.length === 0 || (closing && !last.only)) {
        this.messages.push({ role: 'assistant', content: message.content });
        return;
      }
      if (message.stop_reason === 'max_tokens') {
        throw new Error('A tool call was cut off at max_tokens; nothing from that turn was run.');
      }
      this.messages.push({ role: 'assistant', content: message.content });
      // Every result of one turn goes back in a single user message.
      const outs = await Promise.all(uses.map(async use => {
        const out = closing && !last.only.includes(use.name) ? { value: NOT_RUN, error: true } : await runTool(h, use.name, use.input);
        return { out, block: { type: 'tool_result', tool_use_id: use.id, content: JSON.stringify(out.value), is_error: out.error } };
      }));
      this.messages.push({ role: 'user', content: outs.map(o => o.block) });
      if (closing || outs.some(o => o.out.ends)) {
        return;
      }
    }
  }

  /** Adds a text block to the user turn the next call ends on, after any tool results. */
  appendNote(text) {
    const note = { type: 'text', text };
    const last = this.messages.at(-1);
    if (last?.role !== 'user') {
      this.messages.push({ role: 'user', content: [ note ] });
    } else if (typeof last.content === 'string') {
      last.content = [ { type: 'text', text: last.content }, note ];
    } else {
      last.content = [ ...last.content, note ];
    }
  }
}

class OpenAIChat {
  constructor({ apiKey, model, baseURL }) {
    this.client = new OpenAI({ apiKey, baseURL, dangerouslyAllowBrowser: true });
    this.model = model;
    this.messages = [];
  }

  async send(text, h) {
    if (this.messages.length === 0) {
      this.messages.push({ role: 'system', content: h.system });
    }
    this.messages.push({ role: 'user', content: text });
    const tools = h.tools.map(t => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.input_schema } }));
    const maxTurns = Math.max(1, h.maxTurns ?? DEFAULT_TURNS);
    const last = lastTurn(h, maxTurns);
    for (let turn = 0; ; turn++) {
      const closing = turn >= maxTurns - 1;
      if (closing) {
        this.messages.push({ role: 'user', content: last.note });
        h.onNotice(last.notice);
      }
      h.onTurnStart();
      const choice = closing && !last.only ? 'none' : h.toolFirst && turn === 0 ? 'required' : null;
      const started = Date.now();
      let response;
      try {
        response = await this.client.chat.completions.create(
          { model: this.model, messages: this.messages, tools, ...(choice ? { tool_choice: choice } : {}) },
          { signal: h.signal },
        );
      } catch (error) {
        h.onCall?.({ turn, tool_choice: choice ?? 'auto', ms: Date.now() - started, ...failure(error) });
        throw error;
      }
      const call = meterOpenAI(response, this.model);
      if (call) {
        h.onUsage?.(call);
      }
      h.onCall?.({
        turn, tool_choice: choice ?? 'auto', ms: Date.now() - started, model: response.model || this.model,
        stop: response.choices[0]?.finish_reason ?? null, usage: call,
      });
      const message = response.choices[0].message;
      if (message.content) {
        h.onText(message.content);
      }
      if (closing && !last.only) {
        // Some servers ignore tool_choice "none"; a tool call no one will answer must not stay in the history.
        this.messages.push({ role: 'assistant', content: message.content ?? '' });
        return;
      }
      this.messages.push(message);
      const calls = message.tool_calls ?? [];
      if (calls.length === 0) {
        return;
      }
      let ends = false;
      const results = await Promise.all(calls.map(async call => {
        let input;
        try {
          input = JSON.parse(call.function.arguments || '{}');
        } catch {
          return { role: 'tool', tool_call_id: call.id, content: JSON.stringify({ error: 'arguments were not valid JSON' }) };
        }
        const out = closing && !last.only.includes(call.function.name) ? { value: NOT_RUN } : await runTool(h, call.function.name, input);
        ends ||= out.ends;
        return { role: 'tool', tool_call_id: call.id, content: JSON.stringify(out.value) };
      }));
      this.messages.push(...results);
      if (closing || ends) {
        return;
      }
    }
  }
}

const PROBLEM = 'urn:frink-llm-gate:problem:';

/** An error from the gate, from its problem document (RFC 9457): its words, its status, its type. */
class GateError extends Error {
  constructor(problem, status) {
    super(`The gate: ${problem?.title ?? `HTTP ${status}`}${problem?.detail ? ` — ${problem.detail}` : ''}`);
    this.status = problem?.status ?? status;
    this.problem = typeof problem?.type === 'string' && problem.type.startsWith(PROBLEM) ? problem.type.slice(PROBLEM.length) : null;
  }
}

/** The events of a server-sent stream, as { event, data }, with data parsed as JSON. */
async function* events(body) {
  const reader = body.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) {
      return;
    }
    buffer += value.replaceAll('\r\n', '\n');
    for (let end = buffer.indexOf('\n\n'); end >= 0; end = buffer.indexOf('\n\n')) {
      const block = buffer.slice(0, end);
      buffer = buffer.slice(end + 2);
      let event = 'message';
      let data = '';
      for (const line of block.split('\n')) {
        if (line.startsWith('event:')) {
          event = line.slice(6).trim();
        } else if (line.startsWith('data:')) {
          data += line.slice(5).replace(/^ /u, '');
        }
      }
      if (data) {
        yield { event, data: JSON.parse(data) };
      }
    }
  }
}

/**
 * The free model, through the FRINK gate (frink-llm-gate): no key. The gate holds the model's
 * key, asks a proof of work for a visitor token (solved in a worker), and runs only the prompt
 * and operations this build signed into gate-manifest.txt, beside the page. It keeps no
 * conversation: each turn comes back with the conversation sealed, which goes back with the next
 * input. It sets the model, the reply cap and the turns a message may take, and on a message's
 * last turn sends the build's last-turn note itself, so `h.system`, `h.tools` and `h.maxTurns`
 * are not sent; `h.endpoint` is, as the prompt's one parameter.
 */
class GateChat {
  constructor({ base }) {
    this.base = base.replace(/\/+$/u, '');
    // The conversation as the gate holds it, sealed; and, for the transcript only (D18), as the
    // gate sends it to the model, in chat-completions messages, kept here since the page cannot
    // read the sealed one.
    this.conversation = null;
    this.messages = [];
    // The sealed conversation as it stood after the last answer, where every message starts.
    this.answered = null;
    this.token = null;
    this.tokenUntil = 0;
    this.signed = null;
  }

  /** The signed manifest beside the page, and the model it names. */
  async manifest() {
    if (!this.signed) {
      const response = await fetch('gate-manifest.txt', { cache: 'no-store' });
      if (!response.ok) {
        throw new Error('This build has no signed manifest for the gate (gate-manifest.txt), so the free model is off. Build with KGF_GATE_KEY set.');
      }
      const text = (await response.text()).trim();
      const body = JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(text.split('.')[3].replaceAll('-', '+').replaceAll('_', '/')), c => c.charCodeAt(0))));
      this.signed = { text, model: body.ask.model };
    }
    return this.signed;
  }

  async post(path, body, { token, signal } = {}) {
    const headers = { 'content-type': 'application/json' };
    if (token) {
      headers.authorization = `Bearer ${token}`;
    }
    const response = await fetch(`${this.base}${path}`, { method: 'POST', headers, body: JSON.stringify(body), signal });
    if (!response.ok) {
      const problem = await response.json().catch(() => null);
      throw new GateError(problem, response.status);
    }
    return response;
  }

  /** A visitor token: a challenge, solved in a worker, traded. Kept until shortly before it lapses. */
  async visitorToken(signal, onStatus) {
    if (this.token && Date.now() < this.tokenUntil) {
      return this.token;
    }
    onStatus?.('Getting a visitor token: a moment of work in this browser');
    const challenge = await (await this.post('/v1/challenge', { automation: navigator.webdriver === true }, { signal })).json();
    const worker = new Worker(`pow-worker.js?v=${KGF_EXPLORER_BUILD}`);
    const stop = () => worker.terminate();
    signal?.addEventListener('abort', stop, { once: true });
    let solved;
    try {
      solved = await new Promise((resolve, reject) => {
        worker.onmessage = ({ data }) => resolve(data);
        worker.onerror = event => reject(new Error(`The proof of work failed: ${event.message}`));
        signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
        worker.postMessage({ challenge: challenge.challenge, difficulty: challenge.difficulty });
      });
    } finally {
      stop();
      signal?.removeEventListener('abort', stop);
    }
    const issued = await (await this.post('/v1/token', { challenge: challenge.challenge, nonce: solved.nonce }, { signal })).json();
    this.token = issued.token;
    this.tokenUntil = Date.now() + Math.max(0, issued.expires_in - 60) * 1000;
    this.work = { bits: challenge.difficulty, tries: solved.tries, ms: solved.ms };
    return this.token;
  }

  async send(text, h) {
    const manifest = await this.manifest();
    // A message that failed or was stopped midway left the gate's conversation waiting for
    // results it will never get, and the gate would refuse text after it: start from the last
    // answer instead. The page's own copy keeps that message, so the transcript shows what ran,
    // and this message's first call says the model was not shown it.
    const resumed = this.conversation !== this.answered;
    this.conversation = this.answered;
    if (this.messages.length === 0) {
      this.messages.push({ role: 'system', content: h.system });
    }
    this.messages.push({ role: 'user', content: text });
    let input = { text };
    let retries = 0;
    for (let turn = 0; ; turn++) {
      const token = await this.visitorToken(h.signal, h.onStatus);
      h.onTurnStart();
      const started = Date.now();
      const record = {
        turn, model: manifest.model, ...(this.work ? { work: this.work } : {}),
        ...(resumed && turn === 0 ? { resumed_from_last_answer: true } : {}),
      };
      this.work = null;
      const calls = [];
      let done = null;
      let problem = null;
      let said = '';
      let reasoning = '';
      try {
        const response = await this.post('/v1/turn', {
          manifest: manifest.text, params: { endpoint: h.endpoint }, transcript: this.conversation, input,
        }, { token, signal: h.signal });
        for await (const { event, data } of events(response.body)) {
          if (event === 'text') {
            said += data.delta;
            h.onText(data.delta);
          } else if (event === 'reasoning') {
            if (!reasoning) {
              h.onStatus?.('The model is thinking');
            }
            reasoning += data.delta;
          } else if (event === 'tool_call') {
            calls.push(data);
          } else if (event === 'done') {
            done = data;
          } else if (event === 'problem') {
            problem = data;
          }
        }
        if (problem) {
          throw new GateError(problem, problem.status);
        }
        if (!done) {
          throw new Error('The gate\'s stream ended without the turn.');
        }
      } catch (error) {
        h.onCall?.({ ...record, ms: Date.now() - started, ...failure(error), ...(error.problem ? { problem: error.problem } : {}) });
        if (h.signal?.aborted || retries >= 2) {
          throw error;
        }
        if (error.problem === 'expired' || error.problem === 'not-the-gates') {
          // A token that lapsed, or one from before the gate's keys changed: get another.
          this.token = null;
        } else if (error.problem === 'turn-refused') {
          // The gate kept nothing of the turn: the same input goes again.
          h.onNotice('The gate refused the model\'s turn (a tool call it does not allow there); asking again.');
        } else {
          throw error;
        }
        retries++;
        turn--;
        continue;
      }
      retries = 0;
      const usage = done.usage ? {
        model: manifest.model, input: done.usage.prompt, cacheWrite: 0, cacheRead: 0, output: done.usage.completion, cost: null, long: false,
      } : null;
      if (usage) {
        h.onUsage?.(usage);
      }
      h.onCall?.({
        ...record, ms: Date.now() - started, stop: done.finish, usage, reasoning_chars: reasoning.length,
        ...(done.turns_left === undefined ? {} : { turns_left: done.turns_left }),
      });
      this.conversation = done.transcript;
      this.messages.push({
        role: 'assistant', content: said || null, ...(reasoning ? { reasoning } : {}),
        ...(calls.length ? { tool_calls: calls.map(call => ({ id: call.id, type: 'function', function: { name: call.name, arguments: call.arguments } })) } : {}),
      });
      if (calls.length === 0) {
        this.answered = this.conversation;
        return;
      }
      const results = await Promise.all(calls.map(async call => {
        let input;
        try {
          input = JSON.parse(call.arguments || '{}');
        } catch {
          return { id: call.id, content: JSON.stringify({ error: 'arguments were not valid JSON' }) };
        }
        const out = await runTool(h, call.name, input);
        return { id: call.id, content: JSON.stringify(out.value) };
      }));
      this.messages.push(...results.map(result => ({ role: 'tool', tool_call_id: result.id, content: result.content })));
      if (done.turns_left === 1) {
        // The gate adds the build's last-turn note to the next request, after these results.
        this.messages.push({ role: 'user', content: lastTurnNote() });
        h.onNotice('The next model turn is the last the gate allows for this message: the model answers from what it has, with no more tools. Reply "continue" to go on.');
      }
      input = { results };
    }
  }
}

/**
 * A failed call as the transcript keeps it (D14, D18): the message, the HTTP status, and the
 * headers that carry a reason or a wait. A gateway's 403 can have no body and say why only in
 * a header.
 */
export function failure(error) {
  const out = { error: error?.message ?? String(error) };
  if (typeof error?.status === 'number') {
    out.status = error.status;
  }
  const h = error?.headers;
  const headers = {};
  for (const name of [ 'www-authenticate', 'x-ext-auth-reason', 'retry-after', 'x-ratelimit-remaining', 'request-id', 'x-request-id' ]) {
    const value = typeof h?.get === 'function' ? h.get(name) : h?.[name];
    if (value) {
      headers[name] = value;
    }
  }
  if (Object.keys(headers).length) {
    out.headers = headers;
  }
  return out;
}

async function runTool(h, name, input) {
  try {
    const value = await h.execute(name, input);
    return { value, error: value?.contract === 'error' || Boolean(value?.error && !value?.contract), ends: Boolean(value?.[ENDS]) };
  } catch (error) {
    return { value: { error: error instanceof Error ? error.message : String(error) }, error: true };
  }
}
