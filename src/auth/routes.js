import { Hono } from "hono";
import { audit } from "../security.js";
import { sha256Hex } from "./encoding.js";
import { hashPassword, verifyPassword, needsRehash, PASSWORD_MAX } from "./password.js";
import { peek, bump, clear } from "./rate-limit.js";
import { replaceSession, destroySession, upgradeSession, requireAuth, ipHash } from "./sessions.js";
import {
  generateTotpSecret, matchTotp, otpauthUrl, qrSvg, encryptSecret, decryptSecret,
  generateBackupCodes, cleanBackupCode, hashBackupCode,
} from "./totp.js";

// ---------- Limits ----------
const WINDOW = 15 * 60;          // seconds
const IP_LIMIT = 30;             // login attempts per address per window
const EMAIL_LIMIT = 5;           // wrong passwords per email before a 15-minute lock
const TWO_STEP_LIMIT = 5;        // wrong codes per user before a 15-minute lock

const BAD_LOGIN = "Email or password is incorrect.";
const TOO_MANY = "Too many attempts. Please try again in 15 minutes.";

export function cleanEmail(value) {
  const email = String(value ?? "").trim().toLowerCase();
  return email.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email : null;
}

// Used when the email doesn't exist, so that request takes as long as a real one
// and response time can't reveal which emails have accounts.
let dummyHash;
const getDummyHash = () => (dummyHash ??= hashPassword("not-a-real-password"));

async function readJson(c) {
  const body = await c.req.json().catch(() => null);
  return body && typeof body === "object" ? body : {};
}

function confirmedTotp(db, userId) {
  return db
    .prepare("SELECT id, secret, last_used_step FROM two_step_methods WHERE user_id = ? AND type = 'totp' AND confirmed_at IS NOT NULL")
    .bind(userId)
    .first();
}

// Checks an authenticator code and marks its time step as used, so the same
// code can't be replayed. Returns true only if the code is right AND unused.
async function checkTotp(c, userId, method, code) {
  const secret = await decryptSecret(c.env, userId, method.secret);
  const step = await matchTotp(secret, code);
  if (step === null) return false;
  const result = await c.env.DB
    .prepare("UPDATE two_step_methods SET last_used_step = ?1 WHERE id = ?2 AND (last_used_step IS NULL OR last_used_step < ?1)")
    .bind(step, method.id)
    .run();
  return result.meta.changes === 1;
}

async function saveNewBackupCodes(db, userId) {
  const codes = generateBackupCodes();
  const statements = [db.prepare("DELETE FROM backup_codes WHERE user_id = ?").bind(userId)];
  for (const code of codes) {
    statements.push(
      db.prepare("INSERT INTO backup_codes (id, user_id, code_hash) VALUES (?, ?, ?)")
        .bind(crypto.randomUUID(), userId, await hashBackupCode(userId, cleanBackupCode(code)))
    );
  }
  await db.batch(statements); // all or nothing
  return codes;
}

const auth = new Hono();

// ---------- Who am I? Drives which screen the portal shows ----------
auth.get("/me", async (c) => {
  const session = c.get("session");
  const user = c.get("user");
  if (!session) return c.json({ state: "signed_out" });
  if (!session.twoStepPassed) {
    const method = await confirmedTotp(c.env.DB, user.id);
    return c.json({ state: method ? "needs_two_step" : "needs_setup" });
  }
  const { results } = await c.env.DB
    .prepare(
      `SELECT o.id, o.name, o.type, m.role FROM memberships m
         JOIN organisations o ON o.id = m.organisation_id WHERE m.user_id = ? ORDER BY o.name`
    )
    .bind(user.id)
    .all();
  const left = await c.env.DB
    .prepare("SELECT count(*) AS n FROM backup_codes WHERE user_id = ? AND used_at IS NULL")
    .bind(user.id)
    .first();
  return c.json({
    state: "signed_in",
    user: { email: user.email, name: user.name },
    organisations: results,
    backupCodesLeft: left.n,
  });
});

// ---------- Step 1: email + password ----------
auth.post("/auth/login", async (c) => {
  const db = c.env.DB;
  const body = await readJson(c);
  const email = cleanEmail(body.email);
  const password = typeof body.password === "string" ? body.password : "";

  if ((await bump(db, `login:ip:${await ipHash(c)}`, WINDOW)) > IP_LIMIT) {
    return c.json({ error: TOO_MANY }, 429);
  }
  if (!email || !password || password.length > PASSWORD_MAX) return c.json({ error: BAD_LOGIN }, 401);

  // The lock is keyed on the email, whether or not an account exists,
  // so the lock itself doesn't reveal which emails are registered.
  const emailKey = `login:email:${await sha256Hex(email)}`;
  if ((await peek(db, emailKey, WINDOW)) >= EMAIL_LIMIT) {
    await audit(c, "login.blocked", { email });
    return c.json({ error: TOO_MANY }, 429);
  }

  const user = await db.prepare("SELECT id, email, name, password_hash, status FROM users WHERE email = ?").bind(email).first();
  const passwordOk = await verifyPassword(password, user ? user.password_hash : await getDummyHash());

  if (!user || !passwordOk || user.status !== "active") {
    const failures = await bump(db, emailKey, WINDOW, EMAIL_LIMIT);
    const locked = failures >= EMAIL_LIMIT;
    if (user) {
      await db
        .prepare(`UPDATE users SET failed_logins = failed_logins + 1,
                    locked_until = CASE WHEN ?2 THEN datetime('now', '+${WINDOW} seconds') ELSE locked_until END
                  WHERE id = ?1`)
        .bind(user.id, locked ? 1 : 0)
        .run();
    }
    await audit(c, locked ? "login.locked" : "login.failed", { email, userId: user?.id });
    return c.json({ error: BAD_LOGIN }, 401);
  }

  await clear(db, emailKey);
  const statements = [
    db.prepare("UPDATE users SET failed_logins = 0, locked_until = NULL WHERE id = ?").bind(user.id),
    db.prepare("DELETE FROM sessions WHERE user_id = ? AND expires_at <= datetime('now')").bind(user.id),
  ];
  if (needsRehash(user.password_hash)) {
    statements.push(
      db.prepare("UPDATE users SET password_hash = ?, updated_at = datetime('now') WHERE id = ?")
        .bind(await hashPassword(password), user.id)
    );
  }
  await db.batch(statements);

  // Half signed in: this session can only finish two-step, nothing else.
  await replaceSession(c, user, { twoStepPassed: false });
  await audit(c, "login.password_ok");

  const method = await confirmedTotp(db, user.id);
  return c.json({ state: method ? "needs_two_step" : "needs_setup" });
});

// ---------- Step 2 (first time): set up the authenticator app ----------
auth.post("/auth/two-step/setup/start", async (c) => {
  const user = c.get("user");
  if (!user) return c.json({ error: "Please sign in" }, 401);
  if (await confirmedTotp(c.env.DB, user.id)) return c.json({ error: "Two-step login is already set up." }, 409);

  const secret = generateTotpSecret();
  await c.env.DB
    .prepare(
      `INSERT INTO two_step_methods (id, user_id, type, secret) VALUES (?, ?, 'totp', ?)
       ON CONFLICT(user_id, type) DO UPDATE SET secret = excluded.secret, last_used_step = NULL
       WHERE confirmed_at IS NULL`
    )
    .bind(crypto.randomUUID(), user.id, await encryptSecret(c.env, user.id, secret))
    .run();

  const url = otpauthUrl(secret, user.email);
  return c.json({ secret, qr: qrSvg(url) });
});

auth.post("/auth/two-step/setup/confirm", async (c) => {
  const db = c.env.DB;
  const user = c.get("user");
  if (!user) return c.json({ error: "Please sign in" }, 401);

  const key = `2step:${user.id}`;
  if ((await peek(db, key, WINDOW)) >= TWO_STEP_LIMIT) return c.json({ error: TOO_MANY }, 429);

  const method = await db
    .prepare("SELECT id, secret, last_used_step FROM two_step_methods WHERE user_id = ? AND type = 'totp' AND confirmed_at IS NULL")
    .bind(user.id)
    .first();
  if (!method) return c.json({ error: "Start two-step setup again." }, 409);

  const body = await readJson(c);
  if (!(await checkTotp(c, user.id, method, body.code))) {
    await bump(db, key, WINDOW, TWO_STEP_LIMIT);
    await audit(c, "two_step.setup_failed");
    return c.json({ error: "That code is not correct. Check your app and try again." }, 401);
  }

  await clear(db, key);
  await db.prepare("UPDATE two_step_methods SET confirmed_at = datetime('now') WHERE id = ?").bind(method.id).run();
  const backupCodes = await saveNewBackupCodes(db, user.id);
  await upgradeSession(c);
  await audit(c, "two_step.enabled", { target: "totp" });
  await audit(c, "login.success", { target: "totp" });
  return c.json({ state: "signed_in", backupCodes });
});

// ---------- Step 2 (every login): authenticator code or a backup code ----------
auth.post("/auth/two-step/verify", async (c) => {
  const db = c.env.DB;
  const user = c.get("user");
  const session = c.get("session");
  if (!user) return c.json({ error: "Please sign in" }, 401);
  if (session.twoStepPassed) return c.json({ state: "signed_in" });

  const key = `2step:${user.id}`;
  if ((await peek(db, key, WINDOW)) >= TWO_STEP_LIMIT) {
    await audit(c, "two_step.blocked");
    await destroySession(c);
    return c.json({ error: TOO_MANY }, 429);
  }

  const method = await confirmedTotp(db, user.id);
  if (!method) return c.json({ error: "Two-step login is not set up." }, 409);

  const body = await readJson(c);
  let used = null;
  if (body.backupCode !== undefined) {
    const code = cleanBackupCode(body.backupCode);
    if (code) {
      // One statement, so two requests can never both spend the same code.
      const result = await db
        .prepare("UPDATE backup_codes SET used_at = datetime('now') WHERE user_id = ? AND code_hash = ? AND used_at IS NULL")
        .bind(user.id, await hashBackupCode(user.id, code))
        .run();
      if (result.meta.changes === 1) used = "backup_code";
    }
  } else if (await checkTotp(c, user.id, method, body.code)) {
    used = "totp";
  }

  if (!used) {
    const failures = await bump(db, key, WINDOW, TWO_STEP_LIMIT);
    await audit(c, failures >= TWO_STEP_LIMIT ? "two_step.locked" : "two_step.failed");
    return c.json({ error: "That code is not correct." }, 401);
  }

  await clear(db, key);
  await upgradeSession(c);
  if (used === "backup_code") await audit(c, "two_step.backup_code_used");
  await audit(c, "login.success", { target: used });
  return c.json({ state: "signed_in" });
});

// ---------- New backup codes (signed in, and must prove the authenticator again) ----------
auth.post("/auth/backup-codes/regenerate", requireAuth, async (c) => {
  const db = c.env.DB;
  const user = c.get("user");
  const key = `2step:${user.id}`;
  if ((await peek(db, key, WINDOW)) >= TWO_STEP_LIMIT) return c.json({ error: TOO_MANY }, 429);

  const method = await confirmedTotp(db, user.id);
  const body = await readJson(c);
  if (!method || !(await checkTotp(c, user.id, method, body.code))) {
    await bump(db, key, WINDOW, TWO_STEP_LIMIT);
    await audit(c, "two_step.failed", { target: "backup_codes" });
    return c.json({ error: "That code is not correct." }, 401);
  }
  await clear(db, key);
  const backupCodes = await saveNewBackupCodes(db, user.id);
  await audit(c, "two_step.backup_codes_regenerated");
  return c.json({ backupCodes });
});

// ---------- Sign out ----------
auth.post("/auth/logout", async (c) => {
  if (c.get("user")) await audit(c, "logout");
  await destroySession(c);
  return c.json({ state: "signed_out" });
});

export default auth;
