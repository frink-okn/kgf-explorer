// Checks src/sha256.js, the gate's proof of work, against Node's crypto and against the gate's
// own vector (frink-llm-gate, gate-core's token tests: a challenge Python's hmac wrote, which
// Node solved with "rg" at 12 bits in 989 tries). Prints its speed.
//
//   node --no-warnings test/pow_check.mjs

import { createHash, randomBytes } from 'node:crypto';

import { digest, solve } from '../src/sha256.js';

const sha = bytes => createHash('sha256').update(bytes).digest();
const zeroBits = d => {
  let bits = 0;
  for (const byte of d) {
    if (byte !== 0) {
      return bits + Math.clz32(byte) - 24;
    }
    bits += 8;
  }
  return bits;
};

// Every length across the block boundaries, with random bytes.
for (let length = 0; length <= 300; length++) {
  const bytes = randomBytes(length);
  const ours = Buffer.from(digest(new Uint8Array(bytes)));
  if (!ours.equals(sha(bytes))) {
    throw new Error(`digest differs at length ${length}`);
  }
}
console.log('digest: equal to Node crypto for every length 0..300');

const GATE_CHALLENGE = 'v1.challenge.k1.eyJyYW5kb20iOiJBQUVDQXdRRkJnY0lDUW9MREEwT0R3IiwiaXNzdWVkIjoxNzk0MTY2MzAzLCJkaWZmaWN1bHR5IjoxMn0.WmUyCP-3OnBXKOA1dvusBtrPU0njcZc6HU0DAV6EefE';
const pinned = solve(GATE_CHALLENGE, 12);
if (pinned.nonce !== 'rg' || pinned.tries !== 989) {
  throw new Error(`the gate's vector gave ${JSON.stringify(pinned)}, not rg in 989 tries`);
}
console.log('the gate\'s vector: rg in 989 tries, as Node solved it and the gate accepts');

// Challenges of every length the prefix can leave in its last block: the first solution, and
// no earlier nonce, by Node's crypto.
for (let length = 100; length < 230; length += 7) {
  const challenge = randomBytes(length).toString('base64url').slice(0, length);
  const difficulty = 6 + length % 5;
  const { nonce, tries } = solve(challenge, difficulty);
  if (zeroBits(sha(`${challenge}.${nonce}`)) < difficulty) {
    throw new Error(`a nonce that does not solve a ${length}-character challenge`);
  }
  for (let n = 0; n < tries - 1; n++) {
    if (zeroBits(sha(`${challenge}.${n.toString(36)}`)) >= difficulty) {
      throw new Error(`an earlier solution was missed at ${length} characters`);
    }
  }
}
console.log('solutions: each the first, checked by Node crypto, for challenges of 100 to 225 characters');

const challenge = `v1.challenge.g1.${randomBytes(80).toString('base64url')}.${randomBytes(32).toString('base64url')}`;
const started = performance.now();
const { tries } = solve(challenge, 20);
const seconds = (performance.now() - started) / 1000;
console.log(`speed: ${tries} tries at 20 bits in ${seconds.toFixed(2)} s, ${Math.round(tries / seconds / 1000)} thousand a second`);
