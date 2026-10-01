import { randomBytes, toBase64, fromBase64, timingSafeEqual } from "./encoding.js";

// Passwords are never stored. We store "pbkdf2-sha512$<iterations>$<salt>$<hash>".
// 100,000 is the most iterations the Workers runtime allows for PBKDF2.
// The settings are saved inside each hash, so they can be raised later and
// old hashes are upgraded the next time that user logs in (needsRehash).
const ALGO = "pbkdf2-sha512";
const ITERATIONS = 100_000;
const SALT_BYTES = 16;
const HASH_BITS = 256;

export const PASSWORD_MIN = 12;
export const PASSWORD_MAX = 128; // cap, so nobody can make the server hash megabytes

// Returns an error message, or null if the password is acceptable.
export function passwordProblem(password, email = "") {
  if (typeof password !== "string" || password.length < PASSWORD_MIN) {
    return `Password must be at least ${PASSWORD_MIN} characters.`;
  }
  if (password.length > PASSWORD_MAX) return `Password must be at most ${PASSWORD_MAX} characters.`;
  if (email && password.toLowerCase() === email.toLowerCase()) return "Password can't be your email address.";
  return null;
}

async function derive(password, salt, iterations) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-512", salt, iterations }, key, HASH_BITS);
  return new Uint8Array(bits);
}

export async function hashPassword(password) {
  const salt = randomBytes(SALT_BYTES);
  const hash = await derive(password, salt, ITERATIONS);
  return `${ALGO}$${ITERATIONS}$${toBase64(salt)}$${toBase64(hash)}`;
}

export async function verifyPassword(password, stored) {
  const [algo, iterations, salt, hash] = String(stored ?? "").split("$");
  if (algo !== ALGO || !salt || !hash) return false;
  const count = Number(iterations);
  if (!Number.isInteger(count) || count < 1 || count > ITERATIONS) return false;
  if (typeof password !== "string" || password.length > PASSWORD_MAX) return false;
  const actual = await derive(password, fromBase64(salt), count);
  return timingSafeEqual(actual, fromBase64(hash));
}

export function needsRehash(stored) {
  const [algo, iterations] = String(stored ?? "").split("$");
  return algo !== ALGO || Number(iterations) < ITERATIONS;
}
