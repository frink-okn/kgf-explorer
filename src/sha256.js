// SHA-256 for the FRINK gate's proof of work (frink-llm-gate plan D8): a nonce such that
// SHA-256(challenge "." nonce) starts with `difficulty` zero bits. Written out rather than taken
// from SubtleCrypto, whose one promise per digest makes the few hundred thousand tries a
// challenge takes cost seconds more; the challenge's whole 64-byte blocks are hashed once, and
// each try hashes only the rest. test/pow_check.mjs checks it against Node's crypto and against
// the gate's own vector.

const IV = Int32Array.of(
  0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
);

const K = Int32Array.of(
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
);

/** Hashes `count` 64-byte blocks of `bytes`, from `offset`, into the state `h`; `w` is scratch. */
function compress(h, w, bytes, offset, count) {
  for (let block = 0; block < count; block++) {
    const o = offset + block * 64;
    for (let i = 0; i < 16; i++) {
      const j = o + i * 4;
      w[i] = bytes[j] << 24 | bytes[j + 1] << 16 | bytes[j + 2] << 8 | bytes[j + 3];
    }
    for (let i = 16; i < 64; i++) {
      const x = w[i - 15];
      const y = w[i - 2];
      const s0 = (x >>> 7 | x << 25) ^ (x >>> 18 | x << 14) ^ x >>> 3;
      const s1 = (y >>> 17 | y << 15) ^ (y >>> 19 | y << 13) ^ y >>> 10;
      w[i] = w[i - 16] + s0 + w[i - 7] + s1 | 0;
    }
    let a = h[0];
    let b = h[1];
    let c = h[2];
    let d = h[3];
    let e = h[4];
    let f = h[5];
    let g = h[6];
    let k = h[7];
    for (let i = 0; i < 64; i++) {
      const s1 = (e >>> 6 | e << 26) ^ (e >>> 11 | e << 21) ^ (e >>> 25 | e << 7);
      const t1 = k + s1 + (e & f ^ ~e & g) + K[i] + w[i] | 0;
      const s0 = (a >>> 2 | a << 30) ^ (a >>> 13 | a << 19) ^ (a >>> 22 | a << 10);
      const t2 = s0 + (a & b ^ a & c ^ b & c) | 0;
      k = g;
      g = f;
      f = e;
      e = d + t1 | 0;
      d = c;
      c = b;
      b = a;
      a = t1 + t2 | 0;
    }
    h[0] = h[0] + a | 0;
    h[1] = h[1] + b | 0;
    h[2] = h[2] + c | 0;
    h[3] = h[3] + d | 0;
    h[4] = h[4] + e | 0;
    h[5] = h[5] + f | 0;
    h[6] = h[6] + g | 0;
    h[7] = h[7] + k | 0;
  }
}

/**
 * Pads the `used` bytes at the start of `buf` (whose first bytes continue a message of `total`
 * bytes in all) to whole blocks, and returns how many blocks that is.
 */
function pad(buf, used, total) {
  buf[used] = 0x80;
  const count = used + 1 + 8 <= 64 ? 1 : 2;
  const end = count * 64;
  buf.fill(0, used + 1, end - 8);
  const bits = total * 8;
  const high = Math.floor(bits / 2 ** 32);
  const low = bits >>> 0;
  buf[end - 8] = high >>> 24;
  buf[end - 7] = high >>> 16 & 0xff;
  buf[end - 6] = high >>> 8 & 0xff;
  buf[end - 5] = high & 0xff;
  buf[end - 4] = low >>> 24;
  buf[end - 3] = low >>> 16 & 0xff;
  buf[end - 2] = low >>> 8 & 0xff;
  buf[end - 1] = low & 0xff;
  return count;
}

/** The SHA-256 of `bytes`, for the check against other implementations. */
export function digest(bytes) {
  const h = Int32Array.from(IV);
  const w = new Int32Array(64);
  const whole = Math.floor(bytes.length / 64);
  compress(h, w, bytes, 0, whole);
  const buf = new Uint8Array(128);
  const rest = bytes.subarray(whole * 64);
  buf.set(rest);
  compress(h, w, buf, 0, pad(buf, rest.length, bytes.length));
  const out = new Uint8Array(32);
  const view = new DataView(out.buffer);
  for (let i = 0; i < 8; i++) {
    view.setInt32(i * 4, h[i]);
  }
  return out;
}

/**
 * The first nonce, counting up from 0 in base 36 as the gate's development client does, whose
 * digest with `challenge` starts with `difficulty` zero bits (0 to 32), and how many tries it
 * took. The gate takes 1 to 32 base64url characters; a base-36 count stays far within that.
 */
export function solve(challenge, difficulty) {
  const prefix = new TextEncoder().encode(`${challenge}.`);
  const whole = Math.floor(prefix.length / 64);
  const mid = Int32Array.from(IV);
  const w = new Int32Array(64);
  compress(mid, w, prefix, 0, whole);
  const rest = prefix.subarray(whole * 64);
  const buf = new Uint8Array(128);
  buf.set(rest);
  const h = new Int32Array(8);
  for (let n = 0; ; n++) {
    const nonce = n.toString(36);
    let used = rest.length;
    for (let i = 0; i < nonce.length; i++) {
      buf[used++] = nonce.charCodeAt(i);
    }
    const count = pad(buf, used, prefix.length + nonce.length);
    h.set(mid);
    compress(h, w, buf, 0, count);
    if (Math.clz32(h[0]) >= difficulty) {
      return { nonce, tries: n + 1 };
    }
  }
}
