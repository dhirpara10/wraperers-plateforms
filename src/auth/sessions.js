import { getCookie, setCookie, deleteCookie } from "hono/cookie";
import { randomBytes, toBase64Url, sha256Hex } from "./encoding.js";

// "__Host-" means: this exact host only, HTTPS only, whole site. Store subdomains
// (which can run custom code) can neither read nor overwrite this cookie.
export const SESSION_COOKIE = "__Host-session";

const PENDING_SECONDS = 10 * 60;        // password accepted, two-step not done yet
const FULL_SECONDS = 7 * 24 * 60 * 60;  // signed in: at most 7 days...
const IDLE = "-24 hours";               // ...and signed out after 24 hours without use

const COOKIE_OPTIONS = { path: "/", secure: true, httpOnly: true, sameSite: "Strict" };

// Hashed IP: lets us group attempts by address without ever storing the address itself.
export async function ipHash(c) {
  if (!c.env.IP_SALT) throw new Error("IP_SALT is not set");
  const ip = c.req.header("CF-Connecting-IP") ?? "unknown";
  return sha256Hex(`${c.env.IP_SALT}:${ip}`);
}

// Creates a session and sets the cookie. Only a hash of the cookie value is stored,
// so a leaked database can't be used to sign in as anyone.
async function createSession(c, userId, { twoStepPassed }) {
  const token = toBase64Url(randomBytes(32));
  const seconds = twoStepPassed ? FULL_SECONDS : PENDING_SECONDS;
  await c.env.DB
    .prepare(
      `INSERT INTO sessions (id, user_id, token_hash, two_step_passed, ip_hash, user_agent, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, datetime('now', ?))`
    )
    .bind(
      crypto.randomUUID(),
      userId,
      await sha256Hex(token),
      twoStepPassed ? 1 : 0,
      await ipHash(c),
      (c.req.header("User-Agent") ?? "").slice(0, 200),
      `+${seconds} seconds`
    )
    .run();
  setCookie(c, SESSION_COOKIE, token, { ...COOKIE_OPTIONS, maxAge: seconds });
}

// Removes the current session on the server (the cookie value becomes useless).
async function dropSession(c) {
  const session = c.get("session");
  if (session) await c.env.DB.prepare("DELETE FROM sessions WHERE id = ?").bind(session.id).run();
  c.set("session", null);
  c.set("user", null);
}

export async function destroySession(c) {
  await dropSession(c);
  deleteCookie(c, SESSION_COOKIE, COOKIE_OPTIONS);
}

// Replaces whatever session the browser had with a new one for this user.
export async function replaceSession(c, user, { twoStepPassed }) {
  await dropSession(c);
  await createSession(c, user.id, { twoStepPassed });
  c.set("user", { id: user.id, email: user.email, name: user.name });
}

// Swaps the half-signed-in session for a new, fully signed-in one.
// A fresh token means a value seen before two-step is useless afterwards.
export function upgradeSession(c) {
  return replaceSession(c, c.get("user"), { twoStepPassed: true });
}

// Runs on every request: reads the cookie and, if valid, sets "session" and "user".
export const loadSession = async (c, next) => {
  c.set("session", null);
  c.set("user", null);
  const token = getCookie(c, SESSION_COOKIE);
  if (token) {
    const row = await c.env.DB
      .prepare(
        `SELECT s.id, s.user_id, s.two_step_passed,
                (s.last_seen_at < datetime('now', '-5 minutes')) AS stale,
                u.email, u.name
           FROM sessions s JOIN users u ON u.id = s.user_id
          WHERE s.token_hash = ?1
            AND s.expires_at > datetime('now')
            AND s.last_seen_at > datetime('now', ?2)
            AND u.status = 'active'`
      )
      .bind(await sha256Hex(token), IDLE)
      .first();
    if (row) {
      c.set("session", { id: row.id, twoStepPassed: row.two_step_passed === 1 });
      c.set("user", { id: row.user_id, email: row.email, name: row.name });
      if (row.stale) {
        await c.env.DB.prepare("UPDATE sessions SET last_seen_at = datetime('now') WHERE id = ?").bind(row.id).run();
      }
    }
  }
  await next();
};

// For every route that needs a fully signed-in user (password AND two-step).
export const requireAuth = async (c, next) => {
  if (!c.get("session")?.twoStepPassed) return c.json({ error: "Please sign in" }, 401);
  await next();
};
