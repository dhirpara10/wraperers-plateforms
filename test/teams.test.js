import { env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { assignableRoles } from "../src/roles.js";
import { makeLoginUser, makeOrg, addMember, makeClient, signInFully } from "./helpers.js";

const PASSWORD = "correct horse battery staple";
const run = crypto.randomUUID().slice(0, 8);
const email = (name) => `${name}-${run}@teams.test`;

// Signs in a new user who belongs to orgId with the given role.
async function memberClient(name, orgId, role) {
  const userId = await makeLoginUser(email(name), PASSWORD);
  if (orgId) await addMember(orgId, userId, role);
  const { client } = await signInFully(email(name), PASSWORD);
  return { client, userId };
}

const tokenOf = (link) => link.split("#invite=")[1];

let platform, brandA, brandB, agency;
let owner, platformStaff, ashaOwner, belaOwner, agencyAdmin, agencyMember;

beforeAll(async () => {
  const existing = await env.DB.prepare("SELECT id FROM organisations WHERE type = 'platform'").first();
  platform = existing?.id ?? (await makeOrg("platform", "Wraperers"));
  brandA = await makeOrg("brand", "Brand A");
  brandB = await makeOrg("brand", "Brand B");
  agency = await makeOrg("agency", "Agency");

  owner = await memberClient("owner", platform, "owner");
  platformStaff = await memberClient("staff", platform, "staff");
  ashaOwner = await memberClient("asha", brandA, "owner");
  belaOwner = await memberClient("bela", brandB, "owner");
  agencyAdmin = await memberClient("admin", agency, "admin");
  agencyMember = await memberClient("member", agency, "member");
});

describe("who can hand out which roles", () => {
  const org = (type) => ({ id: "x", type, name: "x" });
  it("follows the role table", () => {
    expect(assignableRoles({ org: org("brand"), role: "owner", platformAccess: false })).toEqual(["owner", "editor", "viewer"]);
    expect(assignableRoles({ org: org("brand"), role: "editor", platformAccess: false })).toEqual([]);
    expect(assignableRoles({ org: org("agency"), role: "admin", platformAccess: false })).toEqual(["admin", "member"]);
    expect(assignableRoles({ org: org("agency"), role: "member", platformAccess: false })).toEqual([]);
    expect(assignableRoles({ org: org("brand"), role: "owner", platformAccess: true })).toEqual(["owner", "editor", "viewer"]);
    expect(assignableRoles({ org: org("brand"), role: "staff", platformAccess: true })).toEqual([]);
    expect(assignableRoles(null)).toEqual([]);
  });
});

describe("team isolation", () => {
  it("never shows or changes another organisation's team", async () => {
    const asha = ashaOwner.client;
    expect((await asha.get(`/api/orgs/${brandB}/team`)).status).toBe(404);
    expect((await asha.post(`/api/orgs/${brandB}/invites`, { email: email("sneaky"), role: "owner" })).status).toBe(404);
    expect((await asha.patch(`/api/orgs/${brandB}/members/${belaOwner.userId}`, { role: "viewer" })).status).toBe(404);
    expect((await asha.delete(`/api/orgs/${brandB}/members/${belaOwner.userId}`)).status).toBe(404);
    expect((await agencyAdmin.client.get(`/api/orgs/${brandA}/team`)).status).toBe(404);

    // A member of brand A can't reach brand B's member through brand A's address either.
    expect((await asha.delete(`/api/orgs/${brandA}/members/${belaOwner.userId}`)).status).toBe(404);
    const stillThere = await env.DB.prepare("SELECT role FROM memberships WHERE organisation_id = ? AND user_id = ?").bind(brandB, belaOwner.userId).first();
    expect(stillThere.role).toBe("owner");

    const list = (await asha.get("/api/orgs")).body;
    expect(list.organisations.map((o) => o.id)).toEqual([brandA]);
    expect(list.canCreate).toBe(false);
  });

  it("needs a fully signed-in user", async () => {
    expect((await makeClient().get(`/api/orgs/${brandA}/team`)).status).toBe(401);
    expect((await makeClient().get("/api/orgs")).status).toBe(401);
  });

  it("lets Wraperers see every team, and logs it", async () => {
    const team = await platformStaff.client.get(`/api/orgs/${brandA}/team`);
    expect(team.status).toBe(200);
    expect(team.body.platformAccess).toBe(true);
    expect(team.body.assignableRoles).toEqual([]);
    // Staff can look, but not change anything.
    expect((await platformStaff.client.post(`/api/orgs/${brandA}/invites`, { email: email("x"), role: "viewer" })).status).toBe(403);

    const log = await env.DB
      .prepare("SELECT platform_access FROM audit_log WHERE user_id = ? AND action = 'team.viewed' AND organisation_id = ?")
      .bind(platformStaff.userId, brandA)
      .first();
    expect(log.platform_access).toBe(1);

    const all = (await platformStaff.client.get("/api/orgs")).body.organisations.map((o) => o.id);
    expect(all).toEqual(expect.arrayContaining([platform, brandA, brandB, agency]));
  });
});

describe("creating organisations", () => {
  it("is for the Wraperers owner only", async () => {
    expect((await ashaOwner.client.post("/api/orgs", { type: "brand", name: "Mine" })).status).toBe(403);
    expect((await platformStaff.client.post("/api/orgs", { type: "brand", name: "Mine" })).status).toBe(403);
    expect((await owner.client.post("/api/orgs", { type: "platform", name: "Second" })).status).toBe(400);
    expect((await owner.client.post("/api/orgs", { type: "brand", name: "   " })).status).toBe(400);

    const made = await owner.client.post("/api/orgs", { type: "brand", name: "  New Brand  " });
    expect(made.status).toBe(201);
    expect(made.body.organisation.name).toBe("New Brand");
    expect((await owner.client.get("/api/orgs")).body.canCreate).toBe(true);
  });
});

describe("invites", () => {
  it("brings a new person in through a one-time link", async () => {
    const invited = email("newcomer");
    const made = await ashaOwner.client.post(`/api/orgs/${brandA}/invites`, { email: invited.toUpperCase(), role: "editor" });
    expect(made.status).toBe(201);
    expect(made.body.link).toMatch(/^https:\/\/app\.wraperers\.com\/#invite=[A-Za-z0-9_-]{43}$/);
    const token = tokenOf(made.body.link);

    // Only a hash of the link is stored.
    const row = await env.DB.prepare("SELECT token_hash, email FROM invites WHERE id = ?").bind(made.body.invite.id).first();
    expect(row.token_hash).not.toBe(token);
    expect(row.email).toBe(invited);

    const guest = makeClient();
    const info = await guest.post("/api/invites/lookup", { token });
    expect(info.body).toMatchObject({ organisation: { name: "Brand A", type: "brand" }, role: "editor", email: invited, hasAccount: false });

    expect((await guest.post("/api/invites/accept", { token, name: "New", password: "short" })).status).toBe(400);
    const accepted = await guest.post("/api/invites/accept", { token, name: "New Person", password: PASSWORD });
    expect(accepted.body.state).toBe("needs_setup");
    // Half signed in only: two-step setup comes next, like every other login.
    expect((await guest.get(`/api/orgs/${brandA}/team`)).status).toBe(401);

    const member = await env.DB
      .prepare("SELECT m.role FROM memberships m JOIN users u ON u.id = m.user_id WHERE u.email = ? AND m.organisation_id = ?")
      .bind(invited, brandA)
      .first();
    expect(member.role).toBe("editor");

    // The link works once.
    expect((await makeClient().post("/api/invites/accept", { token, name: "Again", password: PASSWORD })).status).toBe(404);
    expect((await makeClient().post("/api/invites/lookup", { token })).status).toBe(404);

    // The new person can sign in with their password, finish two-step, and see only their team.
    const { client } = await signInFully(invited, PASSWORD);
    expect((await client.get("/api/orgs")).body.organisations.map((o) => o.id)).toEqual([brandA]);
    // Editors can't invite.
    expect((await client.post(`/api/orgs/${brandA}/invites`, { email: email("y"), role: "viewer" })).status).toBe(403);
  });

  it("asks existing accounts to sign in first, as the invited email", async () => {
    const made = await belaOwner.client.post(`/api/orgs/${brandB}/invites`, { email: email("asha"), role: "viewer" });
    const token = tokenOf(made.body.link);

    expect((await makeClient().post("/api/invites/lookup", { token })).body.hasAccount).toBe(true);
    // Not signed in, or signed in as someone else: refused, and nobody can set a password on Asha's account.
    const anon = await makeClient().post("/api/invites/accept", { token, name: "Hijack", password: PASSWORD + "!" });
    expect(anon.status).toBe(401);
    expect((await agencyAdmin.client.post("/api/invites/accept", { token })).status).toBe(401);

    const ok = await ashaOwner.client.post("/api/invites/accept", { token });
    expect(ok.body.state).toBe("signed_in");
    const ids = (await ashaOwner.client.get("/api/orgs")).body.organisations.map((o) => o.id);
    expect(ids).toEqual(expect.arrayContaining([brandA, brandB]));
    expect((await ashaOwner.client.post("/api/invites/accept", { token })).status).toBe(404);
  });

  it("refuses expired links, roles that don't fit, and roles above your own", async () => {
    const made = await ashaOwner.client.post(`/api/orgs/${brandA}/invites`, { email: email("late"), role: "viewer" });
    await env.DB.prepare("UPDATE invites SET expires_at = datetime('now', '-1 minute') WHERE id = ?").bind(made.body.invite.id).run();
    expect((await makeClient().post("/api/invites/accept", { token: tokenOf(made.body.link), name: "Late", password: PASSWORD })).status).toBe(404);

    expect((await ashaOwner.client.post(`/api/orgs/${brandA}/invites`, { email: email("z"), role: "admin" })).status).toBe(400);
    expect((await ashaOwner.client.post(`/api/orgs/${brandA}/invites`, { email: "not-an-email", role: "viewer" })).status).toBe(400);
    expect((await agencyAdmin.client.post(`/api/orgs/${agency}/invites`, { email: email("boss"), role: "owner" })).status).toBe(400);
    expect((await agencyAdmin.client.post(`/api/orgs/${agency}/invites`, { email: email("helper"), role: "member" })).status).toBe(201);
    expect((await agencyMember.client.post(`/api/orgs/${agency}/invites`, { email: email("helper2"), role: "member" })).status).toBe(403);
  });

  it("can be cancelled, and a new invite replaces the old link", async () => {
    const first = await ashaOwner.client.post(`/api/orgs/${brandA}/invites`, { email: email("twice"), role: "viewer" });
    const second = await ashaOwner.client.post(`/api/orgs/${brandA}/invites`, { email: email("twice"), role: "viewer" });
    expect((await makeClient().post("/api/invites/lookup", { token: tokenOf(first.body.link) })).status).toBe(404);

    expect((await belaOwner.client.delete(`/api/orgs/${brandB}/invites/${second.body.invite.id}`)).status).toBe(404);
    expect((await ashaOwner.client.delete(`/api/orgs/${brandA}/invites/${second.body.invite.id}`)).status).toBe(200);
    expect((await makeClient().post("/api/invites/lookup", { token: tokenOf(second.body.link) })).status).toBe(404);
  });

  it("rejects made-up links", async () => {
    expect((await makeClient().post("/api/invites/lookup", { token: "x".repeat(43) })).status).toBe(404);
    expect((await makeClient().post("/api/invites/lookup", {})).status).toBe(404);
  });
});

describe("changing roles and removing people", () => {
  it("always keeps at least one owner", async () => {
    const org = await makeOrg("brand", "Solo Brand");
    const solo = await memberClient("solo", org, "owner");
    expect((await solo.client.patch(`/api/orgs/${org}/members/${solo.userId}`, { role: "viewer" })).status).toBe(409);
    expect((await solo.client.delete(`/api/orgs/${org}/members/${solo.userId}`)).status).toBe(409);

    const second = await memberClient("second", org, "editor");
    expect((await solo.client.patch(`/api/orgs/${org}/members/${second.userId}`, { role: "owner" })).status).toBe(200);
    // Now there are two owners, so the first may step down.
    expect((await solo.client.patch(`/api/orgs/${org}/members/${solo.userId}`, { role: "viewer" })).status).toBe(200);
    expect((await second.client.delete(`/api/orgs/${org}/members/${second.userId}`)).status).toBe(409);

    const { results } = await env.DB.prepare("SELECT action FROM audit_log WHERE organisation_id = ?").bind(org).all();
    expect(results.map((r) => r.action)).toContain("member.role_changed");
  });

  it("stops agency admins from touching owners, and members from managing", async () => {
    const boss = await memberClient("boss", agency, "owner");
    expect((await agencyAdmin.client.patch(`/api/orgs/${agency}/members/${boss.userId}`, { role: "member" })).status).toBe(403);
    expect((await agencyAdmin.client.delete(`/api/orgs/${agency}/members/${boss.userId}`)).status).toBe(403);
    expect((await agencyAdmin.client.patch(`/api/orgs/${agency}/members/${agencyMember.userId}`, { role: "owner" })).status).toBe(403);
    expect((await agencyMember.client.delete(`/api/orgs/${agency}/members/${agencyAdmin.userId}`)).status).toBe(403);
    expect((await agencyAdmin.client.patch(`/api/orgs/${agency}/members/${agencyMember.userId}`, { role: "admin" })).status).toBe(200);
    expect((await agencyAdmin.client.patch(`/api/orgs/${agency}/members/${agencyMember.userId}`, { role: "member" })).status).toBe(200);
  });

  it("lets anyone leave a team (except the last owner)", async () => {
    const org = await makeOrg("brand", "Leave Brand");
    await memberClient("leaveowner", org, "owner");
    const viewer = await memberClient("leaver", org, "viewer");
    expect((await viewer.client.delete(`/api/orgs/${org}/members/${viewer.userId}`)).status).toBe(200);
    expect((await viewer.client.get(`/api/orgs/${org}/team`)).status).toBe(404);
  });

  it("lets the Wraperers owner fix any team, flagged in the audit log", async () => {
    const org = await makeOrg("brand", "Support Brand");
    const stuck = await memberClient("stuck", org, "viewer");
    expect((await owner.client.patch(`/api/orgs/${org}/members/${stuck.userId}`, { role: "owner" })).status).toBe(200);
    const log = await env.DB
      .prepare("SELECT platform_access FROM audit_log WHERE organisation_id = ? AND action = 'member.role_changed'")
      .bind(org)
      .first();
    expect(log.platform_access).toBe(1);
  });
});
