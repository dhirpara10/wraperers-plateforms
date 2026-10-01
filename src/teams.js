import { Hono } from "hono";
import { audit } from "./security.js";
import { requireOrgAccess } from "./tenancy.js";
import { ORG_ROLES, assignableRoles, canCreateStore, CREATABLE_ORG_TYPES } from "./roles.js";
import { readJson, cleanName } from "./util.js";
import { cleanEmail } from "./auth/routes.js";
import { randomBytes, toBase64Url, sha256Hex } from "./auth/encoding.js";
import { hashPassword, passwordProblem } from "./auth/password.js";
import { replaceSession, requireAuth, ipHash } from "./auth/sessions.js";
import { bump } from "./auth/rate-limit.js";

// Organisations, team members, and invites.
//
// No email yet, so an invite is a one-time link that the inviter sends themselves
// (WhatsApp, Instagram...). Only a hash of the link's secret is stored. The secret
// sits after "#" in the link, so browsers never send it to any server in a request
// or Referer header; the portal reads it and posts it to /api/invites/*.

const INVITE_DAYS = 7;
const MAX_PENDING_INVITES = 50;  // per organisation
const INVITE_IP_LIMIT = 30;      // invite lookups/accepts per address per 15 minutes
const WINDOW = 15 * 60;

const NOT_ALLOWED = "You can't manage this team.";
const BAD_INVITE = "This invite link is not valid, was already used, or has expired.";

// Audit details for an action on a team, flagged when Wraperers staff act on someone else's team.
const orgAudit = (access, target) => ({
  organisationId: access.org.id,
  platformAccess: access.platformAccess,
  target,
});

const teams = new Hono();

// ======================= Signed-in routes =======================

// Organisations the user can open. Wraperers members see every organisation (for support).
teams.get("/orgs", requireAuth, async (c) => {
  const user = c.get("user");
  const db = c.env.DB;
  const platform = await db
    .prepare(
      `SELECT m.role FROM memberships m JOIN organisations o ON o.id = m.organisation_id
        WHERE m.user_id = ? AND o.type = 'platform'`
    )
    .bind(user.id)
    .first();

  const { results } = await db
    .prepare(
      `SELECT o.id, o.name, o.type, m.role
         FROM organisations o
         LEFT JOIN memberships m ON m.organisation_id = o.id AND m.user_id = ?1
        WHERE m.user_id IS NOT NULL OR ?2
        ORDER BY (o.type = 'platform') DESC, (m.role IS NULL), o.name
        LIMIT 500`
    )
    .bind(user.id, platform ? 1 : 0)
    .all();

  const organisations = results.map((org) => {
    // No role here means the user sees this organisation through Wraperers (platform) membership.
    const access = { org, role: org.role ?? platform?.role, platformAccess: !org.role };
    return { ...org, canCreateSite: canCreateStore(access) };
  });
  return c.json({ organisations, canCreate: platform?.role === "owner" });
});

// Create an agency or brand organisation (Wraperers platform owner only, for now).
teams.post("/orgs", requireAuth, async (c) => {
  const user = c.get("user");
  const db = c.env.DB;
  const owner = await db
    .prepare(
      `SELECT 1 FROM memberships m JOIN organisations o ON o.id = m.organisation_id
        WHERE m.user_id = ? AND o.type = 'platform' AND m.role = 'owner'`
    )
    .bind(user.id)
    .first();
  if (!owner) return c.json({ error: "Only the Wraperers owner can create organisations." }, 403);

  const body = await readJson(c);
  const name = cleanName(body.name);
  if (!CREATABLE_ORG_TYPES.includes(body.type)) return c.json({ error: "Choose agency or brand." }, 400);
  if (!name) return c.json({ error: "Name must be 1 to 80 characters." }, 400);

  const id = crypto.randomUUID();
  await db.prepare("INSERT INTO organisations (id, type, name) VALUES (?, ?, ?)").bind(id, body.type, name).run();
  await audit(c, "org.created", { organisationId: id, target: `${body.type}:${name}` });
  return c.json({ organisation: { id, name, type: body.type } }, 201);
});

// One team: its members and pending invites.
teams.get("/orgs/:orgId/team", requireAuth, async (c) => {
  const user = c.get("user");
  const db = c.env.DB;
  const access = await requireOrgAccess(db, user.id, c.req.param("orgId"));
  const orgId = access.org.id;

  const { results: members } = await db
    .prepare(
      `SELECT u.id AS userId, u.name, u.email, m.role
         FROM memberships m JOIN users u ON u.id = m.user_id
        WHERE m.organisation_id = ?
        ORDER BY (m.role = 'owner') DESC, u.name, u.email`
    )
    .bind(orgId)
    .all();

  const roles = assignableRoles(access);
  let invites = [];
  if (roles.length) {
    ({ results: invites } = await db
      .prepare(
        `SELECT id, email, role, expires_at AS expiresAt FROM invites
          WHERE organisation_id = ? AND accepted_at IS NULL AND expires_at > datetime('now')
          ORDER BY created_at DESC`
      )
      .bind(orgId)
      .all());
  }

  if (access.platformAccess) await audit(c, "team.viewed", orgAudit(access));

  return c.json({
    organisation: access.org,
    yourRole: access.platformAccess ? null : access.role,
    platformAccess: access.platformAccess,
    assignableRoles: roles,
    members: members.map((m) => ({ ...m, isYou: m.userId === user.id })),
    invites,
  });
});

// Make a one-time invite link.
teams.post("/orgs/:orgId/invites", requireAuth, async (c) => {
  const user = c.get("user");
  const db = c.env.DB;
  const access = await requireOrgAccess(db, user.id, c.req.param("orgId"));
  const roles = assignableRoles(access);
  if (!roles.length) return c.json({ error: NOT_ALLOWED }, 403);

  const body = await readJson(c);
  const email = cleanEmail(body.email);
  if (!email) return c.json({ error: "Enter a valid email address." }, 400);
  if (!roles.includes(body.role)) return c.json({ error: "You can't invite someone with that role." }, 400);

  const already = await db
    .prepare(
      `SELECT 1 FROM memberships m JOIN users u ON u.id = m.user_id
        WHERE m.organisation_id = ? AND u.email = ?`
    )
    .bind(access.org.id, email)
    .first();
  if (already) return c.json({ error: "That person is already in this team." }, 409);

  const pending = await db
    .prepare("SELECT count(*) AS n FROM invites WHERE organisation_id = ? AND accepted_at IS NULL AND expires_at > datetime('now')")
    .bind(access.org.id)
    .first();
  if (pending.n >= MAX_PENDING_INVITES) return c.json({ error: "Too many open invites. Cancel some first." }, 429);

  const token = toBase64Url(randomBytes(32));
  const id = crypto.randomUUID();
  await db.batch([
    // A new invite replaces any older unused one for the same email, so only one link works.
    db.prepare("DELETE FROM invites WHERE organisation_id = ? AND email = ? AND accepted_at IS NULL").bind(access.org.id, email),
    db.prepare(
      `INSERT INTO invites (id, organisation_id, email, role, token_hash, invited_by, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, datetime('now', '+${INVITE_DAYS} days'))`
    ).bind(id, access.org.id, email, body.role, await sha256Hex(token), user.id),
  ]);
  await audit(c, "invite.created", orgAudit(access, `${email} as ${body.role}`));

  return c.json({ invite: { id, email, role: body.role }, link: `${c.env.APP_ORIGIN}/#invite=${token}`, days: INVITE_DAYS }, 201);
});

// Cancel an invite that hasn't been used yet.
teams.delete("/orgs/:orgId/invites/:inviteId", requireAuth, async (c) => {
  const user = c.get("user");
  const db = c.env.DB;
  const access = await requireOrgAccess(db, user.id, c.req.param("orgId"));
  const roles = assignableRoles(access);
  if (!roles.length) return c.json({ error: NOT_ALLOWED }, 403);

  const invite = await db
    .prepare("SELECT id, email, role FROM invites WHERE id = ? AND organisation_id = ? AND accepted_at IS NULL")
    .bind(c.req.param("inviteId"), access.org.id)
    .first();
  if (!invite) return c.json({ error: "Not found" }, 404);
  if (!roles.includes(invite.role)) return c.json({ error: NOT_ALLOWED }, 403);

  await db.prepare("DELETE FROM invites WHERE id = ?").bind(invite.id).run();
  await audit(c, "invite.cancelled", orgAudit(access, `${invite.email} as ${invite.role}`));
  return c.json({ ok: true });
});

// Change a member's role.
teams.patch("/orgs/:orgId/members/:userId", requireAuth, async (c) => {
  const user = c.get("user");
  const db = c.env.DB;
  const access = await requireOrgAccess(db, user.id, c.req.param("orgId"));
  const roles = assignableRoles(access);
  if (!roles.length) return c.json({ error: NOT_ALLOWED }, 403);

  const member = await db
    .prepare(
      `SELECT m.id, m.role, u.email FROM memberships m JOIN users u ON u.id = m.user_id
        WHERE m.organisation_id = ? AND m.user_id = ?`
    )
    .bind(access.org.id, c.req.param("userId"))
    .first();
  if (!member) return c.json({ error: "Not found" }, 404);

  const body = await readJson(c);
  // You must be allowed to hand out both the old role and the new one,
  // so an agency admin can't demote an owner or promote anyone to owner.
  if (!roles.includes(member.role) || !roles.includes(body.role)) return c.json({ error: NOT_ALLOWED }, 403);
  if (member.role === body.role) return c.json({ ok: true });

  // Every team keeps at least one owner. The check is inside the UPDATE,
  // so two owners demoting each other at the same moment can't both succeed.
  const result = await db
    .prepare(
      `UPDATE memberships SET role = ?1
        WHERE id = ?2
          AND (role != 'owner' OR (SELECT count(*) FROM memberships WHERE organisation_id = ?3 AND role = 'owner') > 1)`
    )
    .bind(body.role, member.id, access.org.id)
    .run();
  if (result.meta.changes !== 1) return c.json({ error: "A team needs at least one owner." }, 409);

  await audit(c, "member.role_changed", orgAudit(access, `${member.email}: ${member.role} -> ${body.role}`));
  return c.json({ ok: true });
});

// Remove a member, or leave the team yourself.
teams.delete("/orgs/:orgId/members/:userId", requireAuth, async (c) => {
  const user = c.get("user");
  const db = c.env.DB;
  const access = await requireOrgAccess(db, user.id, c.req.param("orgId"));
  const targetId = c.req.param("userId");

  const member = await db
    .prepare(
      `SELECT m.id, m.role, u.email FROM memberships m JOIN users u ON u.id = m.user_id
        WHERE m.organisation_id = ? AND m.user_id = ?`
    )
    .bind(access.org.id, targetId)
    .first();
  if (!member) return c.json({ error: "Not found" }, 404);

  const leaving = targetId === user.id && !access.platformAccess;
  if (!leaving && !assignableRoles(access).includes(member.role)) return c.json({ error: NOT_ALLOWED }, 403);

  const result = await db
    .prepare(
      `DELETE FROM memberships
        WHERE id = ?1
          AND (role != 'owner' OR (SELECT count(*) FROM memberships WHERE organisation_id = ?2 AND role = 'owner') > 1)`
    )
    .bind(member.id, access.org.id)
    .run();
  if (result.meta.changes !== 1) return c.json({ error: "A team needs at least one owner. Make someone else owner first." }, 409);

  await audit(c, leaving ? "member.left" : "member.removed", orgAudit(access, `${member.email} (${member.role})`));
  return c.json({ ok: true });
});

// ======================= Invite links (may be signed out) =======================

async function findInvite(c, token) {
  if (typeof token !== "string" || token.length < 20 || token.length > 100) return null;
  return c.env.DB
    .prepare(
      `SELECT i.id, i.email, i.role, i.organisation_id, o.name AS org_name, o.type AS org_type
         FROM invites i JOIN organisations o ON o.id = i.organisation_id
        WHERE i.token_hash = ? AND i.accepted_at IS NULL AND i.expires_at > datetime('now')`
    )
    .bind(await sha256Hex(token))
    .first();
}

// Guessing links is hopeless (32 random bytes), but limit tries anyway.
async function tooManyInviteTries(c) {
  return (await bump(c.env.DB, `invite:ip:${await ipHash(c)}`, WINDOW)) > INVITE_IP_LIMIT;
}

// What does this link invite me to? Drives the portal's invite screen.
teams.post("/invites/lookup", async (c) => {
  if (await tooManyInviteTries(c)) return c.json({ error: "Too many attempts. Please try again in 15 minutes." }, 429);
  const body = await readJson(c);
  const invite = await findInvite(c, body.token);
  if (!invite) return c.json({ error: BAD_INVITE }, 404);

  const account = await c.env.DB.prepare("SELECT 1 FROM users WHERE email = ?").bind(invite.email).first();
  const session = c.get("session");
  const signedInEmail = session?.twoStepPassed ? c.get("user").email : null;
  return c.json({
    organisation: { name: invite.org_name, type: invite.org_type },
    role: invite.role,
    email: invite.email,
    hasAccount: Boolean(account),
    signedInAs: signedInEmail,
  });
});

// Accept: joins the team. New people choose a name and password here,
// then set up two-step login like everyone else.
teams.post("/invites/accept", async (c) => {
  const db = c.env.DB;
  if (await tooManyInviteTries(c)) return c.json({ error: "Too many attempts. Please try again in 15 minutes." }, 429);
  const body = await readJson(c);
  const invite = await findInvite(c, body.token);
  if (!invite) return c.json({ error: BAD_INVITE }, 404);
  if (!ORG_ROLES[invite.org_type]?.includes(invite.role)) return c.json({ error: BAD_INVITE }, 404);

  const session = c.get("session");
  const signedIn = c.get("user");
  const existing = await db.prepare("SELECT id, email, name FROM users WHERE email = ?").bind(invite.email).first();

  // These run as one transaction. Each step only happens while the invite is still unused,
  // so the same link can never be used twice, even by two requests at once.
  const stillValid = "EXISTS (SELECT 1 FROM invites WHERE id = ?5 AND accepted_at IS NULL AND expires_at > datetime('now'))";
  const claim = db
    .prepare("UPDATE invites SET accepted_at = datetime('now') WHERE id = ? AND accepted_at IS NULL AND expires_at > datetime('now')")
    .bind(invite.id);

  if (existing) {
    // Someone with an account must be fully signed in as that account to accept.
    if (!session?.twoStepPassed || signedIn.id !== existing.id) {
      return c.json({ error: `Sign in as ${invite.email} to accept this invite.`, state: "sign_in_required" }, 401);
    }
    const results = await db.batch([
      db.prepare(
        `INSERT INTO memberships (id, organisation_id, user_id, role)
         SELECT ?1, ?2, ?3, ?4 WHERE ${stillValid}
         ON CONFLICT(organisation_id, user_id) DO NOTHING`
      ).bind(crypto.randomUUID(), invite.organisation_id, existing.id, invite.role, invite.id),
      claim,
    ]);
    if (results[1].meta.changes !== 1) return c.json({ error: BAD_INVITE }, 404);
    if (results[0].meta.changes !== 1) return c.json({ error: "You are already in this team." }, 409);
    await audit(c, "invite.accepted", { organisationId: invite.organisation_id, target: `${invite.email} as ${invite.role}` });
    return c.json({ state: "signed_in", organisationId: invite.organisation_id });
  }

  // New account. Don't silently swap out whoever is signed in on this browser.
  if (signedIn) return c.json({ error: `You are signed in as ${signedIn.email}. Sign out first, then open the link again.` }, 409);

  const name = cleanName(body.name);
  if (!name) return c.json({ error: "Enter your name (1 to 80 characters)." }, 400);
  const problem = passwordProblem(body.password, invite.email);
  if (problem) return c.json({ error: problem }, 400);

  const userId = crypto.randomUUID();
  const hash = await hashPassword(body.password);
  // email_verified_at stays empty: the link proves someone has it, not that they own the email.
  const results = await db.batch([
    db.prepare(
      `INSERT INTO users (id, email, name, password_hash)
       SELECT ?1, ?2, ?3, ?4 WHERE ${stillValid}`
    ).bind(userId, invite.email, name, hash, invite.id),
    db.prepare(
      `INSERT INTO memberships (id, organisation_id, user_id, role)
       SELECT ?1, ?2, ?3, ?4 WHERE ${stillValid}`
    ).bind(crypto.randomUUID(), invite.organisation_id, userId, invite.role, invite.id),
    claim,
  ]);
  if (results[2].meta.changes !== 1) return c.json({ error: BAD_INVITE }, 404);

  const user = { id: userId, email: invite.email, name };
  await replaceSession(c, user, { twoStepPassed: false });
  await audit(c, "user.created", { target: "invite" });
  await audit(c, "invite.accepted", { organisationId: invite.organisation_id, target: `${invite.email} as ${invite.role}` });
  return c.json({ state: "needs_setup", organisationId: invite.organisation_id });
});

export default teams;
