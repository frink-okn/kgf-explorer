// Writes and signs the manifest the FRINK gate checks (frink-llm-gate, plan D5): the full-mode
// prompt with the endpoint as its one parameter, the last-turn note, the operations, and what
// the page asks of the model. build.sh bundles it with esbuild as it bundles the page, so the
// manifest is made from the source the page runs, and runs it with Node:
//
//   KGF_GATE_KEY=<file holding the build's Ed25519 seed, base64url>  [KGF_GATE_KEY_ID=build1]
//
// It writes the signed text the page sends with each turn, and prints the public key the
// gate's configuration names. The key file is never in this repository or in dist/.

import { createHash, createPrivateKey, createPublicKey, sign } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';

import { SYSTEM, lastTurnNote } from './src/prompt.js';
import { FULL_TOOLS } from './src/tools.js';

/**
 * What the page asks of the model; the gate grants up to its own limits. The first turn is not
 * forced to call a tool: on MaaS a forced call, streamed with these 16 tools, ran on to 1,871
 * and 8,192 output tokens after the call, where an unforced one took 45, and unforced Qwen
 * called a tool first in 15 of 15 of this page's runs (frink-llm-gate plan D7, 2026-11-09).
 */
const ASK = { model: 'qwen38-27b', max_tokens: 8192, first_turn: 'any' };

/** Stands in for the endpoint while the prompt is cut into segments; it holds no text of its own. */
const MARK = '\u0000endpoint\u0000';

const PKCS8_ED25519 = Buffer.from('302e020100300506032b657004220420', 'hex');
const b64u = bytes => Buffer.from(bytes).toString('base64url');

/** The prompt as the gate's segments: text, the endpoint parameter where it goes, text. */
function segments(text) {
  const parts = text.split(MARK);
  const out = [];
  parts.forEach((part, i) => {
    if (i > 0) {
      out.push({ param: 'endpoint' });
    }
    if (part) {
      out.push({ text: part });
    }
  });
  return out;
}

function main(outPath) {
  const keyPath = process.env.KGF_GATE_KEY;
  const keyId = process.env.KGF_GATE_KEY_ID || 'build1';
  if (!keyPath || !outPath) {
    throw new Error('usage: KGF_GATE_KEY=<seed file> node gate-manifest.cjs <out file>');
  }
  if (!/^[a-z0-9-]{1,16}$/u.test(keyId)) {
    throw new Error(`KGF_GATE_KEY_ID ${JSON.stringify(keyId)} is not 1 to 16 of a-z, 0-9 and -`);
  }
  const system = SYSTEM(MARK);
  if (system.split(MARK).length !== 2) {
    throw new Error('the prompt does not hold the endpoint exactly once');
  }
  const manifest = {
    format: 'frink-llm-gate.manifest/1',
    system: segments(system),
    closing: [ { text: lastTurnNote() } ],
    params: [ { name: 'endpoint', kind: 'https_url' } ],
    tools: FULL_TOOLS.map(({ name, description, input_schema }) => ({ name, description, input_schema })),
    ask: ASK,
  };
  const body = JSON.stringify(manifest);
  const seed = Buffer.from(readFileSync(keyPath, 'utf8').trim(), 'base64url');
  if (seed.length !== 32) {
    throw new Error(`${keyPath} does not hold a 32-byte seed in base64url`);
  }
  const key = createPrivateKey({ key: Buffer.concat([ PKCS8_ED25519, seed ]), format: 'der', type: 'pkcs8' });
  const signed = `v1.manifest.${keyId}.${b64u(body)}`;
  const text = `${signed}.${b64u(sign(null, Buffer.from(signed), key))}`;
  writeFileSync(outPath, text);
  const publicKey = createPublicKey(key).export({ format: 'jwk' }).x;
  const hash = createHash('sha256').update(body).digest('hex');
  console.log(`gate manifest: ${text.length} bytes, ${manifest.tools.length} tools, key ${keyId} (public ${publicKey}), hash ${hash.slice(0, 16)}`);
}

main(process.argv[2]);
