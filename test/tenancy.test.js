import { env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { getStoreAccess, requireStoreAccess, listStoresForUser, storeScope, AccessDenied } from "../src/tenancy.js";
import { makeUser, makeOrg, addMember, makeStore } from "./helpers.js";

// Two brands, one agency, the platform, and a user who belongs to nothing.
let asha, bela, agent, staff, stranger;
let storeA, storeB, storeAgency;

beforeAll(async () => {
  const run = crypto.randomUUID().slice(0, 8); // keeps emails/subdomains unique per run
  asha = await makeUser(`asha-${run}@a.test`);
  bela = await makeUser(`bela-${run}@b.test`);
  agent = await makeUser(`agent-${run}@agency.test`);
  staff = await makeUser(`staff-${run}@wraperers.test`);
  stranger = await makeUser(`stranger-${run}@x.test`);

  const brandA = await makeOrg("brand", "Brand A");
  const brandB = await makeOrg("brand", "Brand B");
  const agency = await makeOrg("agency", "Agency");
  const existing = await env.DB.prepare("SELECT id FROM organisations WHERE type = 'platform'").first();
  const platform = existing?.id ?? (await makeOrg("platform", "Wraperers"));

  await addMember(brandA, asha, "owner");
  await addMember(brandB, bela, "viewer");
  await addMember(agency, agent, "admin");
  await addMember(platform, staff, "staff");

  storeA = await makeStore(brandA, `brand-a-${run}`);
  storeB = await makeStore(brandB, `brand-b-${run}`);
  storeAgency = await makeStore(agency, `agency-${run}`);

  // A store-owned table, standing in for the real ones that arrive in milestone 2.
  await env.DB.exec(
    "CREATE TABLE IF NOT EXISTS test_items (id TEXT PRIMARY KEY, store_id TEXT NOT NULL REFERENCES stores(id), title TEXT)"
  );
});

describe("store access", () => {
  it("lets a member reach their own store", async () => {
    const access = await getStoreAccess(env.DB, asha, storeA);
    expect(access.store.id).toBe(storeA);
    expect(access.role).toBe("owner");
    expect(access.platformAccess).toBe(false);
  });

  it("blocks a member of one brand from another brand's store", async () => {
    expect(await getStoreAccess(env.DB, asha, storeB)).toBeNull();
    expect(await getStoreAccess(env.DB, bela, storeA)).toBeNull();
    await expect(requireStoreAccess(env.DB, asha, storeB)).rejects.toBeInstanceOf(AccessDenied);
  });

  it("blocks an agency from stores it does not own, and brands from agency stores", async () => {
    expect(await getStoreAccess(env.DB, agent, storeA)).toBeNull();
    expect(await getStoreAccess(env.DB, asha, storeAgency)).toBeNull();
    expect((await getStoreAccess(env.DB, agent, storeAgency)).role).toBe("admin");
  });

  it("blocks users with no membership, and missing ids", async () => {
    expect(await getStoreAccess(env.DB, stranger, storeA)).toBeNull();
    expect(await getStoreAccess(env.DB, null, storeA)).toBeNull();
    expect(await getStoreAccess(env.DB, asha, null)).toBeNull();
    expect(await getStoreAccess(env.DB, asha, "no-such-store")).toBeNull();
  });

  it("lets platform staff in, flagged for the audit log", async () => {
    const access = await getStoreAccess(env.DB, staff, storeB);
    expect(access.store.id).toBe(storeB);
    expect(access.platformAccess).toBe(true);
  });

  it("enforces required roles", async () => {
    await expect(requireStoreAccess(env.DB, bela, storeB, ["owner", "editor"])).rejects.toBeInstanceOf(AccessDenied);
    await expect(requireStoreAccess(env.DB, bela, storeB, ["viewer"])).resolves.toBeTruthy();
  });

  it("lists only the user's own stores", async () => {
    expect((await listStoresForUser(env.DB, asha)).map((s) => s.id)).toEqual([storeA]);
    expect(await listStoresForUser(env.DB, stranger)).toEqual([]);
    const all = (await listStoresForUser(env.DB, staff)).map((s) => s.id);
    expect(all).toEqual(expect.arrayContaining([storeA, storeB, storeAgency]));
  });
});

describe("store-scoped data", () => {
  it("never reads, writes or deletes another store's rows", async () => {
    const a = storeScope(env.DB, await requireStoreAccess(env.DB, asha, storeA));
    const b = storeScope(env.DB, await requireStoreAccess(env.DB, bela, storeB));

    await a.insert("test_items", { id: "item-a", title: "A's item" });
    // Trying to smuggle in another store's id is overridden.
    await b.insert("test_items", { id: "item-b", title: "B's item", store_id: storeA });

    expect((await a.all("test_items")).results.map((r) => r.id)).toEqual(["item-a"]);
    expect((await b.all("test_items")).results.map((r) => r.id)).toEqual(["item-b"]);

    // B asks for A's row by id: nothing comes back, nothing is deleted.
    expect(await b.first("test_items", "id = ?2", "item-a")).toBeNull();
    await b.delete("test_items", "id = ?2", "item-a");
    expect(await a.first("test_items", "id = ?2", "item-a")).not.toBeNull();
  });

  it("refuses to scope without access, or onto global tables", async () => {
    expect(() => storeScope(env.DB, null)).toThrow(AccessDenied);
    const a = storeScope(env.DB, await requireStoreAccess(env.DB, asha, storeA));
    expect(() => a.all("users")).toThrow();
    expect(() => a.all("stores; DROP TABLE stores")).toThrow();
  });
});
