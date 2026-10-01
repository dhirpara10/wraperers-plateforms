import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { hashPassword, verifyPassword, needsRehash, passwordProblem } from "../src/auth/password.js";
import {
  totpCode, matchTotp, currentStep, encryptSecret, decryptSecret, generateBackupCodes, qrSvg,
} from "../src/auth/totp.js";
import { toBase32, fromBase32 } from "../src/auth/encoding.js";
import { makeLoginUser, makeClient } from "./helpers.js";

const PASSWORD = "correct horse battery staple";
const unique = (name) => `${name}-${crypto.randomUUID().slice(0, 8)}@login.test`;

// Finishes a whole first login: password, authenticator setup, backup codes.
async function signUpFully(email) {
  const client = makeClient();
  await client.post("/api/auth/login", { email, password: PASSWORD });
  const start = await client.post("/api/auth/two-step/setup/start");
  const secret = start.body.secret;
  const confirm = await client.post("/api/auth/two-step/setup/confirm", { code: await totpCode(secret, currentStep()) });
  return { client, secret, backupCodes: confirm.body.backupCodes };
}

describe("password hashing", () => {
  it("verifies the right password and rejects wrong ones", async () => {
    const hash = await hashPassword(PASSWORD);
    expect(hash).toMatch(/^pbkdf2-sha512\$100000\$/);
    expect(hash).not.toContain(PASSWORD);
    expect(await verifyPassword(PASSWORD, hash)).toBe(true);
    expect(await verifyPassword(PASSWORD + "x", hash)).toBe(false);
    expect(await verifyPassword("", hash)).toBe(false);
    expect(await verifyPassword(PASSWORD, "garbage")).toBe(false);
    expect(await verifyPassword(PASSWORD, null)).toBe(false);
  });

  it("uses a new salt every time", async () => {
    expect(await hashPassword(PASSWORD)).not.toBe(await hashPassword(PASSWORD));
  });

  it("flags weaker old hashes for upgrade, and enforces the password rules", async () => {
    expect(needsRehash(await hashPassword(PASSWORD))).toBe(false);
    expect(needsRehash("pbkdf2-sha512$1000$abc$def")).toBe(true);
    expect(passwordProblem("short")).toBeTruthy();
    expect(passwordProblem("x".repeat(129))).toBeTruthy();
    expect(passwordProblem("someone@brand.test", "Someone@brand.test")).toBeTruthy();
    expect(passwordProblem(PASSWORD)).toBeNull();
  });
});

describe("authenticator codes", () => {
  // Official test value from RFC 6238: secret "12345678901234567890" at time 59s.
  const RFC_SECRET = toBase32(new TextEncoder().encode("12345678901234567890"));

  it("matches the RFC 6238 test value", async () => {
    expect(await totpCode(RFC_SECRET, 1)).toBe("287082");
    expect(new TextDecoder().decode(fromBase32(RFC_SECRET))).toBe("12345678901234567890");
  });

  it("accepts the neighbouring 30-second windows only", async () => {
    const now = 1_700_000_000_000;
    const step = currentStep(now);
    expect(await matchTotp(RFC_SECRET, await totpCode(RFC_SECRET, step), now)).toBe(step);
    expect(await matchTotp(RFC_SECRET, await totpCode(RFC_SECRET, step - 1), now)).toBe(step - 1);
    expect(await matchTotp(RFC_SECRET, await totpCode(RFC_SECRET, step + 5), now)).toBeNull();
    expect(await matchTotp(RFC_SECRET, "abcdef", now)).toBeNull();
    expect(await matchTotp(RFC_SECRET, "", now)).toBeNull();
  });

  it("encrypts secrets, tied to one user", async () => {
    const stored = await encryptSecret(env, "user-1", RFC_SECRET);
    expect(stored).not.toContain(RFC_SECRET);
    expect(await decryptSecret(env, "user-1", stored)).toBe(RFC_SECRET);
    await expect(decryptSecret(env, "user-2", stored)).rejects.toThrow();
    await expect(encryptSecret({ TOTP_ENC_KEY: "" }, "user-1", RFC_SECRET)).rejects.toThrow();
  });

  it("makes 10 distinct backup codes and a QR image with no script", () => {
    const codes = generateBackupCodes();
    expect(new Set(codes).size).toBe(10);
    for (const code of codes) expect(code).toMatch(/^[a-z2-9]{5}-[a-z2-9]{5}$/);
    const svg = qrSvg("otpauth://totp/x?secret=ABC");
    expect(svg.startsWith("<svg")).toBe(true);
    expect(svg).not.toMatch(/script|onload|href/i);
  });
});

describe("login flow", () => {
  it("gives the same answer for a wrong password and an unknown email", async () => {
    const email = unique("known");
    await makeLoginUser(email, PASSWORD);
    const wrong = await makeClient().post("/api/auth/login", { email, password: "wrong password here" });
    const unknown = await makeClient().post("/api/auth/login", { email: unique("nobody"), password: PASSWORD });
    expect(wrong.status).toBe(401);
    expect(unknown.status).toBe(401);
    expect(wrong.body).toEqual(unknown.body);
  });

  it("walks through password, authenticator setup, backup codes and sign-out", async () => {
    const email = unique("owner");
    const userId = await makeLoginUser(email, PASSWORD);
    const client = makeClient();

    expect((await client.get("/api/me")).body).toEqual({ state: "signed_out" });

    // Password accepted: only half signed in.
    const login = await client.post("/api/auth/login", { email: email.toUpperCase(), password: PASSWORD });
    expect(login.body).toEqual({ state: "needs_setup" });
    const pendingCookie = client.cookie;

    // The cookie has every protection, and no Domain.
    const flags = client.lastSetCookie;
    expect(flags).toMatch(/^__Host-session=/);
    expect(flags).toMatch(/; Secure/i);
    expect(flags).toMatch(/; HttpOnly/i);
    expect(flags).toMatch(/; SameSite=Strict/i);
    expect(flags).toMatch(/; Path=\//i);
    expect(flags).not.toMatch(/Domain=/i);

    // Half signed in can't use signed-in routes.
    expect((await client.get("/api/me")).body).toEqual({ state: "needs_setup" });
    expect((await client.post("/api/auth/backup-codes/regenerate", { code: "123456" })).status).toBe(401);
    expect((await client.post("/api/auth/two-step/verify", { code: "123456" })).status).toBe(409);

    // Set up the authenticator.
    const start = await client.post("/api/auth/two-step/setup/start");
    const secret = start.body.secret;
    expect(secret).toMatch(/^[A-Z2-7]{32}$/);
    expect(start.body.qr.startsWith("<svg")).toBe(true);
    expect((await client.post("/api/auth/two-step/setup/confirm", { code: "000000" })).status).toBe(401);

    const step = currentStep();
    const confirm = await client.post("/api/auth/two-step/setup/confirm", { code: await totpCode(secret, step) });
    expect(confirm.body.state).toBe("signed_in");
    expect(confirm.body.backupCodes).toHaveLength(10);

    // New cookie after two-step; the half-signed-in one is dead.
    expect(client.cookie).not.toBe(pendingCookie);
    const old = makeClient();
    old.cookie = pendingCookie;
    expect((await old.get("/api/me")).body).toEqual({ state: "signed_out" });

    const me = await client.get("/api/me");
    expect(me.body.state).toBe("signed_in");
    expect(me.body.user.email).toBe(email);
    expect(me.body.backupCodesLeft).toBe(10);

    // Setup can't be run again to swap in a different authenticator.
    expect((await client.post("/api/auth/two-step/setup/start")).status).toBe(409);

    // Nothing secret is stored in readable form.
    const token = client.cookie.split("=")[1];
    const session = await env.DB.prepare("SELECT token_hash FROM sessions WHERE user_id = ?").bind(userId).first();
    expect(session.token_hash).not.toBe(token);
    const method = await env.DB.prepare("SELECT secret FROM two_step_methods WHERE user_id = ?").bind(userId).first();
    expect(method.secret).not.toContain(secret);
    const { results: stored } = await env.DB.prepare("SELECT code_hash FROM backup_codes WHERE user_id = ?").bind(userId).all();
    expect(stored).toHaveLength(10);
    for (const row of stored) expect(confirm.body.backupCodes).not.toContain(row.code_hash);

    // Sign out kills the session on the server, not just the cookie.
    const signedInCookie = client.cookie;
    expect((await client.post("/api/auth/logout")).body).toEqual({ state: "signed_out" });
    const replay = makeClient();
    replay.cookie = signedInCookie;
    expect((await replay.get("/api/me")).body).toEqual({ state: "signed_out" });

    // Second login asks for a code. The code used during setup can't be reused.
    const again = makeClient();
    expect((await again.post("/api/auth/login", { email, password: PASSWORD })).body).toEqual({ state: "needs_two_step" });
    expect((await again.post("/api/auth/two-step/verify", { code: await totpCode(secret, step) })).status).toBe(401);
    expect((await again.post("/api/auth/two-step/verify", { code: await totpCode(secret, step + 1) })).body).toEqual({ state: "signed_in" });

    // The audit log has the story, and never the password.
    const { results: log } = await env.DB.prepare("SELECT action, user_email, target, ip_hash FROM audit_log WHERE user_id = ?").bind(userId).all();
    const actions = log.map((row) => row.action);
    for (const action of ["login.password_ok", "two_step.setup_failed", "two_step.enabled", "login.success", "logout", "two_step.failed"]) {
      expect(actions).toContain(action);
    }
    expect(JSON.stringify(log)).not.toContain(PASSWORD);
    for (const row of log) expect(row.ip_hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("accepts each backup code once only", async () => {
    const email = unique("backup");
    await makeLoginUser(email, PASSWORD);
    const { backupCodes } = await signUpFully(email);

    const first = makeClient();
    await first.post("/api/auth/login", { email, password: PASSWORD });
    const messy = ` ${backupCodes[0].toUpperCase().replace("-", " ")} `; // typed loosely
    expect((await first.post("/api/auth/two-step/verify", { backupCode: messy })).body).toEqual({ state: "signed_in" });
    expect((await first.get("/api/me")).body.backupCodesLeft).toBe(9);

    const second = makeClient();
    await second.post("/api/auth/login", { email, password: PASSWORD });
    expect((await second.post("/api/auth/two-step/verify", { backupCode: backupCodes[0] })).status).toBe(401);
    expect((await second.post("/api/auth/two-step/verify", { backupCode: backupCodes[1] })).body).toEqual({ state: "signed_in" });
  });

  it("makes new backup codes only with a fresh authenticator code", async () => {
    const email = unique("regen");
    await makeLoginUser(email, PASSWORD);
    const { client, secret, backupCodes } = await signUpFully(email);

    expect((await client.post("/api/auth/backup-codes/regenerate", { code: "000000" })).status).toBe(401);
    const regen = await client.post("/api/auth/backup-codes/regenerate", { code: await totpCode(secret, currentStep() + 1) });
    expect(regen.body.backupCodes).toHaveLength(10);

    // Old codes stop working.
    const next = makeClient();
    await next.post("/api/auth/login", { email, password: PASSWORD });
    expect((await next.post("/api/auth/two-step/verify", { backupCode: backupCodes[0] })).status).toBe(401);
  });
});

describe("lockout and limits", () => {
  it("locks an email after 5 wrong passwords, even for the right password", async () => {
    const email = unique("locked");
    const userId = await makeLoginUser(email, PASSWORD);
    for (let i = 0; i < 5; i++) {
      // A new address each time: the lock follows the email, not the attacker's IP.
      expect((await makeClient().post("/api/auth/login", { email, password: "wrong password here" })).status).toBe(401);
    }
    const blocked = await makeClient().post("/api/auth/login", { email, password: PASSWORD });
    expect(blocked.status).toBe(429);

    const user = await env.DB.prepare("SELECT failed_logins, locked_until FROM users WHERE id = ?").bind(userId).first();
    expect(user.failed_logins).toBe(5);
    expect(user.locked_until).toBeTruthy();
    const { results } = await env.DB.prepare("SELECT action FROM audit_log WHERE user_email = ?").bind(email).all();
    expect(results.map((row) => row.action)).toEqual(expect.arrayContaining(["login.failed", "login.locked", "login.blocked"]));

    // Once the window has passed, the right password works again.
    await env.DB.prepare("UPDATE rate_limits SET window_start = datetime('now', '-16 minutes') WHERE key LIKE 'login:email:%'").run();
    expect((await makeClient().post("/api/auth/login", { email, password: PASSWORD })).status).toBe(200);
  });

  it("locks unknown emails the same way, so the lock reveals nothing", async () => {
    const email = unique("ghost");
    for (let i = 0; i < 5; i++) {
      expect((await makeClient().post("/api/auth/login", { email, password: "wrong password here" })).status).toBe(401);
    }
    expect((await makeClient().post("/api/auth/login", { email, password: "wrong password here" })).status).toBe(429);
  });

  it("limits attempts per address", async () => {
    const client = makeClient();
    let status;
    for (let i = 0; i < 31; i++) status = (await client.post("/api/auth/login", {})).status;
    expect(status).toBe(429);
  });

  it("locks two-step after 5 wrong codes and ends the half-signed-in session", async () => {
    const email = unique("codes");
    await makeLoginUser(email, PASSWORD);
    const { secret } = await signUpFully(email);

    const client = makeClient();
    await client.post("/api/auth/login", { email, password: PASSWORD });
    for (let i = 0; i < 5; i++) {
      expect((await client.post("/api/auth/two-step/verify", { code: "000000" })).status).toBe(401);
    }
    const good = await totpCode(secret, currentStep() + 1);
    expect((await client.post("/api/auth/two-step/verify", { code: good })).status).toBe(429);
    expect((await client.get("/api/me")).body).toEqual({ state: "signed_out" });

    // Even a fresh password login can't get past the lock.
    const retry = makeClient();
    await retry.post("/api/auth/login", { email, password: PASSWORD });
    expect((await retry.post("/api/auth/two-step/verify", { code: good })).status).toBe(429);
  });
});

describe("sessions", () => {
  it("end at their expiry time and after 24 idle hours", async () => {
    const email = unique("expiry");
    const userId = await makeLoginUser(email, PASSWORD);
    const { client } = await signUpFully(email);
    expect((await client.get("/api/me")).body.state).toBe("signed_in");

    await env.DB.prepare("UPDATE sessions SET last_seen_at = datetime('now', '-25 hours') WHERE user_id = ?").bind(userId).run();
    expect((await client.get("/api/me")).body).toEqual({ state: "signed_out" });

    await env.DB.prepare("UPDATE sessions SET last_seen_at = datetime('now'), expires_at = datetime('now', '-1 minute') WHERE user_id = ?").bind(userId).run();
    expect((await client.get("/api/me")).body).toEqual({ state: "signed_out" });
  });

  it("stop working when the account is disabled", async () => {
    const email = unique("disabled");
    const userId = await makeLoginUser(email, PASSWORD);
    const { client } = await signUpFully(email);
    await env.DB.prepare("UPDATE users SET status = 'disabled' WHERE id = ?").bind(userId).run();
    expect((await client.get("/api/me")).body).toEqual({ state: "signed_out" });
    expect((await makeClient().post("/api/auth/login", { email, password: PASSWORD })).status).toBe(401);
  });

  it("ignore made-up cookies", async () => {
    const client = makeClient();
    client.cookie = "__Host-session=made-up-value";
    expect((await client.get("/api/me")).body).toEqual({ state: "signed_out" });
  });
});
