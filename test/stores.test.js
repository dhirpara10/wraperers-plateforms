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
