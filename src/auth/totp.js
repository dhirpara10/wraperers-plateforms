import qrcode from "qrcode-generator";
import { randomBytes, toBase64, fromBase64, toBase32, fromBase32, sha256Hex, timingSafeEqual } from "./encoding.js";

// ---------- Authenticator app codes (TOTP, RFC 6238: SHA-1, 6 digits, 30 seconds) ----------
const STEP_SECONDS = 30;
const DIGITS = 6;

export function generateTotpSecret() {
  return toBase32(randomBytes(20));
}

export async function totpCode(secretBase32, step) {
  const key = await crypto.subtle.importKey("raw", fromBase32(secretBase32), { name: "HMAC", hash: "SHA-1" }, false, ["sign"]);
  const counter = new ArrayBuffer(8);
  new DataView(counter).setBigUint64(0, BigInt(step));
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, counter));
  const offset = mac[mac.length - 1] & 0x0f;
  const number =
    ((mac[offset] & 0x7f) << 24) | (mac[offset + 1] << 16) | (mac[offset + 2] << 8) | mac[offset + 3];
  return String(number % 10 ** DIGITS).padStart(DIGITS, "0");
}

export function currentStep(now = Date.now()) {
  return Math.floor(now / 1000 / STEP_SECONDS);
}

// Returns the matching time step, or null. Accepts the previous and next
// 30-second window too, to allow for phone clocks being slightly off.
export async function matchTotp(secretBase32, code, now = Date.now()) {
  const clean = String(code ?? "").replace(/\s/g, "");
  if (!/^\d{6}$/.test(clean)) return null;
  const step = currentStep(now);
  let match = null;
  for (const candidate of [step - 1, step, step + 1]) {
    if (timingSafeEqual(await totpCode(secretBase32, candidate), clean)) match = candidate;
  }
  return match;
}

export function otpauthUrl(secretBase32, email) {
  const label = encodeURIComponent(`Wraperers:${email}`);
  return `otpauth://totp/${label}?secret=${secretBase32}&issuer=Wraperers&algorithm=SHA1&digits=6&period=30`;
}

// QR code as an SVG string, made on the server so the secret never goes to a third party.
export function qrSvg(text) {
  const qr = qrcode(0, "M");
  qr.addData(text);
  qr.make();
  const size = qr.getModuleCount();
  const quiet = 4;
  let path = "";
  for (let row = 0; row < size; row++) {
    for (let col = 0; col < size; col++) {
      if (qr.isDark(row, col)) path += `M${col + quiet} ${row + quiet}h1v1h-1z`;
    }
  }
  const total = size + quiet * 2;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${total} ${total}" shape-rendering="crispEdges"><rect width="${total}" height="${total}" fill="#fff"/><path d="${path}" fill="#000"/></svg>`;
}

// ---------- Encrypting the secret at rest (AES-GCM with the TOTP_ENC_KEY secret) ----------
// Unlike a password, the server must be able to read this secret back to check codes,
// so it is encrypted rather than hashed. A stolen database alone is not enough to use it.
async function encKey(env) {
  let raw;
  try {
    raw = fromBase64(env.TOTP_ENC_KEY ?? "");
  } catch {
    raw = new Uint8Array();
  }
  if (raw.length !== 32) throw new Error("TOTP_ENC_KEY is missing or is not 32 bytes of base64");
  return crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt", "decrypt"]);
}

// userId is bound in, so an encrypted secret can't be moved to another user's row.
export async function encryptSecret(env, userId, secretBase32) {
  const iv = randomBytes(12);
  const data = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: new TextEncoder().encode(userId) },
    await encKey(env),
    new TextEncoder().encode(secretBase32)
  );
  return `v1.${toBase64(iv)}.${toBase64(data)}`;
}

export async function decryptSecret(env, userId, stored) {
  const [version, iv, data] = String(stored ?? "").split(".");
  if (version !== "v1" || !iv || !data) throw new Error("Bad stored secret");
  const plain = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: fromBase64(iv), additionalData: new TextEncoder().encode(userId) },
    await encKey(env),
    fromBase64(data)
  );
  return new TextDecoder().decode(plain);
}

// ---------- Backup codes ----------
// Ten one-time codes like "k7m2p-9xq4t". They are long random values, so a plain
// SHA-256 hash is enough (unlike passwords, they can't be guessed from a word list).
const CODE_ALPHABET = "abcdefghjkmnpqrstuvwxyz23456789"; // no 0/o, 1/l/i
export const BACKUP_CODE_COUNT = 10;

export function generateBackupCodes() {
  const codes = [];
  while (codes.length < BACKUP_CODE_COUNT) {
    let code = "";
    while (code.length < 10) {
      const byte = randomBytes(1)[0];
      if (byte < 248) code += CODE_ALPHABET[byte % CODE_ALPHABET.length]; // 248 = 31 * 8, avoids bias
    }
    codes.push(`${code.slice(0, 5)}-${code.slice(5)}`);
  }
  return codes;
}

export function cleanBackupCode(value) {
  const code = String(value ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");
  return code.length === 10 ? code : null;
}

export function hashBackupCode(userId, cleanCode) {
  return sha256Hex(`backup:${userId}:${cleanCode}`);
}
