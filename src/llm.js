// Bring-your-own-model chat. The key goes from this page straight to the provider named here
// and nowhere else; the page has no server. Two wire formats cover the field: Anthropic's
// Messages API through its SDK, and the OpenAI chat-completions shape, which OpenAI,
// OpenRouter and most local servers (Ollama, LM Studio) speak.

import Anthropic from '@anthropic-ai/sdk';
import OpenAI from 'openai';

export const PROVIDERS = {
  anthropic: { label: 'Anthropic — Claude API key', model: 'claude-opus-5', keyHint: 'sk-ant-…' },
  openai: { label: 'OpenAI — API key', base: 'https://api.openai.com/v1', model: '', keyHint: 'sk-…' },
  openrouter: { label: 'OpenRouter — one key, many models', base: 'https://openrouter.ai/api/v1', model: '', keyHint: 'sk-or-…' },
  custom: { label: 'OpenAI-compatible — custom URL', base: 'http://localhost:11434/v1', model: '', keyHint: 'often unused locally' },
};

// Model calls one message may make; the page's budget panel sets it per send.
export const DEFAULT_TURNS = 50;

/**
 * What the last allowed turn is told. It runs with tools switched off, so a message that
 * reaches the limit ends in an answer from what arrived — the same contract as the fetch
 * budgets: stop, keep what came, say why — rather than in an error.
 */
function lastTurnNote(turns) {
  return `This is the last of the ${turns} model turns this page allows for one message. ` +
    'Do not call any more tools. Answer now from the tables you have, say plainly what you did not get to, ' +
    'and name the tables your answer rests on.';
}

function closingNotice(turns) {
  return `Reached ${turns} model turns for this message: the model is answering from what it has, with no more tools. ` +
    'Raise "model turns" in the budget, or reply "continue".';
}
// Models that take Anthropic's server-side refusal fallback (`fallbacks: "default"`).
const FALLBACK_MODELS = new Set([ 'claude-opus-5', 'claude-fable-5-1' ]);

export function createChat({ provider, apiKey, model, baseURL }) {
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
 *   onNotice(text)           — something the person should see that is not the model's text
 *   maxTurns                 — model calls this message may make, the last with tools off
 *   signal                   — aborts the whole exchange
 */
class AnthropicChat {
  constructor({ apiKey, model }) {
    this.client = new Anthropic({ apiKey, dangerouslyAllowBrowser: true });
    this.model = model;
    this.messages = [];
  }

  async send(text, h) {
    this.messages.push({ role: 'user', content: text });
    const tools = h.tools.map(t => ({ name: t.name, description: t.description, input_schema: t.input_schema, eager_input_streaming: true }));
    const maxTurns = Math.max(1, h.maxTurns ?? DEFAULT_TURNS);
    let jsonRetries = 0;
    let closing = false;
    for (let turn = 0; ; turn++) {
      if (!closing && turn >= maxTurns - 1) {
        closing = true;
        this.appendNote(lastTurnNote(maxTurns));
        h.onNotice(closingNotice(maxTurns));
      }
      const params = { model: this.model, max_tokens: 64000, system: h.system, tools, messages: this.messages, ...(closing ? { tool_choice: { type: 'none' } } : {}) };
      const stream = FALLBACK_MODELS.has(this.model) ?
        this.client.beta.messages.stream({ ...params, betas: [ 'server-side-fallback-2026-07-01' ], fallbacks: 'default' }, { signal: h.signal }) :
        this.client.messages.stream(params, { signal: h.signal });
      h.onTurnStart();
      stream.on('text', delta => h.onText(delta));
      let message;
      try {
        message = await stream.finalMessage();
        jsonRetries = 0;
      } catch (error) {
        // Only a tool input the SDK could not parse is re-issued; everything else is thrown.
        const unparsed = !(error instanceof Anthropic.APIError) && /^Unable to parse tool parameter JSON/u.test(error?.message ?? '');
        if (!unparsed || h.signal?.aborted || jsonRetries++ >= 2) {
          throw error;
        }
        h.onNotice('A tool call arrived malformed; asking again.');
        continue;
      }
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
      if (uses.length === 0 || closing) {
        this.messages.push({ role: 'assistant', content: message.content });
        return;
      }
      if (message.stop_reason === 'max_tokens') {
        throw new Error('A tool call was cut off at max_tokens; nothing from that turn was run.');
      }
      this.messages.push({ role: 'assistant', content: message.content });
      // Every result of one turn goes back in a single user message.
      const results = await Promise.all(uses.map(async use => {
        const out = await runTool(h, use.name, use.input);
        return { type: 'tool_result', tool_use_id: use.id, content: JSON.stringify(out.value), is_error: out.error };
      }));
      this.messages.push({ role: 'user', content: results });
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
    for (let turn = 0; ; turn++) {
      const closing = turn >= maxTurns - 1;
      if (closing) {
        this.messages.push({ role: 'user', content: lastTurnNote(maxTurns) });
        h.onNotice(closingNotice(maxTurns));
      }
      h.onTurnStart();
      const response = await this.client.chat.completions.create(
        { model: this.model, messages: this.messages, tools, ...(closing ? { tool_choice: 'none' } : {}) },
        { signal: h.signal },
      );
      const message = response.choices[0].message;
      if (message.content) {
        h.onText(message.content);
      }
      if (closing) {
        // Some servers ignore tool_choice "none"; a tool call no one will answer must not stay in the history.
        this.messages.push({ role: 'assistant', content: message.content ?? '' });
        return;
      }
      this.messages.push(message);
      const calls = message.tool_calls ?? [];
      if (calls.length === 0) {
        return;
      }
      const results = await Promise.all(calls.map(async call => {
        let input;
        try {
          input = JSON.parse(call.function.arguments || '{}');
        } catch {
          return { role: 'tool', tool_call_id: call.id, content: JSON.stringify({ error: 'arguments were not valid JSON' }) };
        }
        const out = await runTool(h, call.function.name, input);
        return { role: 'tool', tool_call_id: call.id, content: JSON.stringify(out.value) };
      }));
      this.messages.push(...results);
    }
  }
}

async function runTool(h, name, input) {
  try {
    const value = await h.execute(name, input);
    return { value, error: value?.contract === 'error' || Boolean(value?.error && !value?.contract) };
  } catch (error) {
    return { value: { error: error instanceof Error ? error.message : String(error) }, error: true };
  }
}
