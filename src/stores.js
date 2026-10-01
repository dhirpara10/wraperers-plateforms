import { Hono } from "hono";
import { audit } from "./security.js";
import { requireAuth } from "./auth/sessions.js";
import { listStoresForUser, requireOrgAccess, requireStoreAccess } from "./tenancy.js";
import { canCreateStore, MAX_STORES } from "./roles.js";
import { cleanSubdomain, subdomainProblem } from "./subdomains.js";
import { readJson, cleanName } from "./util.js";

// Sites (stores): the list on the portal home, creating a site, and one site's details.
// Every lookup of a single store goes through requireStoreAccess (src/tenancy.js).

const stores = new Hono();

const storeJson = (s) => ({
  id: s.id, name: s.name, subdomain: s.subdomain, status: s.status, organisationId: s.organisation_id,
});

stores.get("/stores", requireAuth, async (c) => {
  const list = await listStoresForUser(c.env.DB, c.get("user").id);
  return c.json({ stores: list.map(storeJson) });
});

// Is this address free? Used for live feedback while typing. The final check is in POST /stores.
stores.get("/subdomains/check", requireAuth, async (c) => {
  const name = String(c.req.query("name") ?? "").trim().toLowerCase();
  const problem = subdomainProblem(name);
  if (problem) return c.json({ ok: false, reason: problem });
  const taken = await c.env.DB.prepare("SELECT 1 FROM stores WHERE subdomain = ?").bind(name).first();
  return c.json(taken ? { ok: false, reason: "That address is already taken." } : { ok: true });
});

stores.post("/stores", requireAuth, async (c) => {
  const db = c.env.DB;
  const body = await readJson(c);
  const orgId = typeof body.organisationId === "string" ? body.organisationId : null;
  const access = await requireOrgAccess(db, c.get("user").id, orgId);
  if (!canCreateStore(access)) return c.json({ error: "You can't create sites for this team." }, 403);

  const name = cleanName(body.name);
  if (!name) return c.json({ error: "Site name must be 1 to 80 characters." }, 400);
  const problem = subdomainProblem(body.subdomain);
  const subdomain = cleanSubdomain(body.subdomain);
  if (problem || !subdomain) return c.json({ error: problem ?? "That address isn't allowed." }, 400);

  const id = crypto.randomUUID();
  const limit = MAX_STORES[access.org.type] ?? 0;
  let result;
  try {
    // The limit is checked inside the INSERT, so two quick clicks can't both get past it.
    result = await db
      .prepare(
        `INSERT INTO stores (id, organisation_id, subdomain, name)
         SELECT ?1, ?2, ?3, ?4
          WHERE (SELECT count(*) FROM stores WHERE organisation_id = ?2) < ?5`
      )
      .bind(id, access.org.id, subdomain, name, limit)
      .run();
  } catch (err) {
    if (String(err.message).includes("UNIQUE")) return c.json({ error: "That address is already taken." }, 409);
    throw err;
  }
  if (result.meta.changes !== 1) {
    const message = access.org.type === "brand" ? "A brand can have one site." : `This team already has ${limit} sites.`;
    return c.json({ error: message }, 409);
  }

  await audit(c, "store.created", {
    organisationId: access.org.id, storeId: id, platformAccess: access.platformAccess, target: `${subdomain}: ${name}`,
  });
  return c.json({ store: { id, name, subdomain, status: "draft", organisationId: access.org.id } }, 201);
});

stores.get("/stores/:storeId", requireAuth, async (c) => {
  const db = c.env.DB;
  const access = await requireStoreAccess(db, c.get("user").id, c.req.param("storeId"));
  const org = await db.prepare("SELECT id, name, type FROM organisations WHERE id = ?").bind(access.store.organisation_id).first();
  if (access.platformAccess) {
    await audit(c, "store.viewed", { storeId: access.store.id, organisationId: org.id, platformAccess: true });
  }
  return c.json({
    store: storeJson(access.store),
    organisation: org,
    yourRole: access.platformAccess ? null : access.role,
    platformAccess: access.platformAccess,
  });
});

export default stores;
