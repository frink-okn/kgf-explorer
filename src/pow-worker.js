// The FRINK gate's proof of work, off the page's main thread (frink-llm-gate plan D8). It takes
// { challenge, difficulty } and answers { nonce, tries, ms }.

import { solve } from './sha256.js';

self.onmessage = ({ data: { challenge, difficulty } }) => {
  const started = performance.now();
  const { nonce, tries } = solve(challenge, difficulty);
  self.postMessage({ nonce, tries, ms: Math.round(performance.now() - started) });
};
