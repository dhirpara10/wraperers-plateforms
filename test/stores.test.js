import { env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { makeLoginUser, makeOrg, addMember, makeStore, makeClient, signInFully } from "./helpers.js";

const PASSWORD = "correct horse battery staple";
const run = crypto.randomUUID().slice(0, 8);

let brandA, brandB, storeA, storeB;

beforeAll(async () => {
  brandA = await makeOrg("brand", "Sites Brand A");
  brandB = await makeOrg("brand", "Sites Brand B");
  storeA = await makeStore(brandA, `sites-a-${run}`);
  storeB = await makeStore(brandB, `sites-b-${run}`);
});

describe("your sites", () => {
  it("lists only the sites of your own organisations", async () => {
    const email = `sites-${run}@a.test`;
    await addMember(brandA, await makeLoginUser(email, PASSWORD), "viewer");
    const { client } = await signInFully(email, PASSWORD);
    const res = await client.get("/api/stores");
    expect(res.status).toBe(200);
    expect(res.body.stores.map((s) => s.id)).toEqual([storeA]);
    expect(res.body.stores[0]).toMatchObject({ subdomain: `sites-a-${run}`, status: "draft", organisationId: brandA });
    expect(res.body.stores.map((s) => s.id)).not.toContain(storeB);
  });

  it("is empty for someone in no organisation, and closed when signed out", async () => {
    const email = `nosites-${run}@x.test`;
    await makeLoginUser(email, PASSWORD);
    const { client } = await signInFully(email, PASSWORD);
    expect((await client.get("/api/stores")).body).toEqual({ stores: [] });
    expect((await makeClient().get("/api/stores")).status).toBe(401);
  });
});

describe("creating sites", () => {
  const sub = (name) => `${name}-${run}`;
  let platform, agency, brand, otherBrand;
  let brandOwner, brandEditor, agencyAdmin, agencyMember, staff;

  async function client(name, orgId, role) {
    const email = `${name}-${run}@create.test`;
    const userId = await makeLoginUser(email, PASSWORD);
    await addMember(orgId, userId, role);
    return { userId, client: (await signInFully(email, PASSWORD)).client };
  }

  beforeAll(async () => {
    const existing = await env.DB.prepare("SELECT id FROM organisations WHERE type = 'platform'").first();
    platform = existing?.id ?? (await makeOrg("platform", "Wraperers"));
    agency = await makeOrg("agency", "Create Agency");
    brand = await makeOrg("brand", "Create Brand");
    otherBrand = await makeOrg("brand", "Other Brand");
    brandOwner = await client("bowner", brand, "owner");
    brandEditor = await client("beditor", brand, "editor");
    agencyAdmin = await client("aadmin", agency, "admin");
    agencyMember = await client("amember", agency, "member");
    staff = await client("pstaff", platform, "staff");
  });

  it("lets a brand owner create their one site", async () => {
    const made = await brandOwner.client.post("/api/stores", { organisationId: brand, name: " My Shop ", subdomain: sub("MyShop") });
    expect(made.status).toBe(201);
    expect(made.body.store).toMatchObject({ name: "My Shop", subdomain: sub("myshop"), status: "draft" });

    const second = await brandOwner.client.post("/api/stores", { organisationId: brand, name: "Two", subdomain: sub("two") });
    expect(second.status).toBe(409);

    const one = await brandEditor.client.get(`/api/stores/${made.body.store.id}`);
    expect(one.status).toBe(200);
    expect(one.body.organisation.name).toBe("Create Brand");
    expect(one.body.yourRole).toBe("editor");

    const log = await env.DB.prepare("SELECT action FROM audit_log WHERE store_id = ?").bind(made.body.store.id).first();
    expect(log.action).toBe("store.created");
  });

  it("checks roles, organisations, and addresses", async () => {
    // Not allowed to create
    expect((await brandEditor.client.post("/api/stores", { organisationId: brand, name: "X", subdomain: sub("ed") })).status).toBe(403);
    expect((await agencyMember.client.post("/api/stores", { organisationId: agency, name: "X", subdomain: sub("mem") })).status).toBe(403);
    // Someone else's organisation: looks like it doesn't exist
    expect((await brandOwner.client.post("/api/stores", { organisationId: otherBrand, name: "X", subdomain: sub("oth") })).status).toBe(404);
    expect((await agencyAdmin.client.post("/api/stores", { organisationId: brand, name: "X", subdomain: sub("ag") })).status).toBe(404);
    expect((await agencyAdmin.client.post("/api/stores", { organisationId: { id: agency }, name: "X", subdomain: sub("obj") })).status).toBe(404);
    // Addresses
    for (const bad of ["admin", "app", "www", "ab", "-bad-", "a--b", "has space", "dots.too", "xn--fake"]) {
      const res = await agencyAdmin.client.post("/api/stores", { organisationId: agency, name: "X", subdomain: bad });
      expect(res.status, bad).toBe(400);
    }
    expect((await agencyAdmin.client.post("/api/stores", { organisationId: agency, name: "", subdomain: sub("noname") })).status).toBe(400);

    const ok = await agencyAdmin.client.post("/api/stores", { organisationId: agency, name: "Client One", subdomain: sub("client") });
    expect(ok.status).toBe(201);
    const dup = await agencyAdmin.client.post("/api/stores", { organisationId: agency, name: "Copy", subdomain: sub("client") });
    expect(dup.status).toBe(409);
    expect((await agencyAdmin.client.post("/api/stores", { organisationId: agency, name: "Client Two", subdomain: sub("client2") })).status).toBe(201);
  });

  it("never shows one organisation's site to another", async () => {
    const made = await agencyAdmin.client.post("/api/stores", { organisationId: agency, name: "Private", subdomain: sub("private") });
    expect((await brandOwner.client.get(`/api/stores/${made.body.store.id}`)).status).toBe(404);
    expect((await brandOwner.client.get("/api/stores")).body.stores.map((s) => s.id)).not.toContain(made.body.store.id);
    expect((await agencyMember.client.get(`/api/stores/${made.body.store.id}`)).status).toBe(200);
  });

  it("lets Wraperers staff build for a client, flagged in the audit log", async () => {
    const made = await staff.client.post("/api/stores", { organisationId: otherBrand, name: "Built by us", subdomain: sub("built") });
    expect(made.status).toBe(201);
    const view = await staff.client.get(`/api/stores/${made.body.store.id}`);
    expect(view.body.platformAccess).toBe(true);
    const { results } = await env.DB
      .prepare("SELECT action, platform_access FROM audit_log WHERE store_id = ? ORDER BY created_at")
      .bind(made.body.store.id)
      .all();
    expect(results.map((r) => r.action)).toEqual(expect.arrayContaining(["store.created", "store.viewed"]));
    for (const row of results) expect(row.platform_access).toBe(1);
  });

  it("tells you whether an address is free", async () => {
    const check = (name) => agencyAdmin.client.get(`/api/subdomains/check?name=${encodeURIComponent(name)}`).then((r) => r.body);
    expect(await check(sub("free"))).toEqual({ ok: true });
    expect((await check("admin")).reason).toMatch(/reserved/);
    expect((await check("ab")).ok).toBe(false);
    expect((await check(sub("client"))).reason).toMatch(/taken/);
    expect((await makeClient().get("/api/subdomains/check?name=abc")).status).toBe(401);
  });

  it("lists which organisations you can create sites in", async () => {
    const mine = (await agencyMember.client.get("/api/orgs")).body.organisations;
    expect(mine.find((o) => o.id === agency).canCreateSite).toBe(false);
    const admin = (await agencyAdmin.client.get("/api/orgs")).body.organisations;
    expect(admin.find((o) => o.id === agency).canCreateSite).toBe(true);
    const all = (await staff.client.get("/api/orgs")).body.organisations;
    expect(all.find((o) => o.id === brand).canCreateSite).toBe(true);
  });
});
