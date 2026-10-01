// Small encoding and comparison helpers shared by the login code.

export function randomBytes(length) {
  return crypto.getRandomValues(new Uint8Array(length));
}

export function toBase64(bytes) {
  return btoa(String.fromCharCode(...new Uint8Array(bytes)));
}

export function fromBase64(text) {
  return Uint8Array.from(atob(text), (ch) => ch.charCodeAt(0));
}

export function toBase64Url(bytes) {
  return toBase64(bytes).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export async function sha256Hex(text) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// Compares without stopping at the first difference, so timing reveals nothing.
export function timingSafeEqual(a, b) {
  const x = typeof a === "string" ? new TextEncoder().encode(a) : a;
  const y = typeof b === "string" ? new TextEncoder().encode(b) : b;
  let diff = x.length ^ y.length;
  for (let i = 0; i < x.length; i++) diff |= x[i] ^ (y[i % (y.length || 1)] ?? 0);
  return diff === 0;
}

// Base32 (RFC 4648), the format authenticator apps expect for secrets.
const B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

export function toBase32(bytes) {
  let bits = 0, value = 0, out = "";
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

export function fromBase32(text) {
  let bits = 0, value = 0;
  const out = [];
  for (const ch of text.replace(/=+$/, "").toUpperCase()) {
    const index = B32.indexOf(ch);
    if (index === -1) throw new Error("Bad base32");
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return new Uint8Array(out);
}
