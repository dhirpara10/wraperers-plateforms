import { Hono } from "hono";
import { requireAuth } from "./auth/sessions.js";
import { listStoresForUser } from "./tenancy.js";

// Sites (stores). For now only the list for the portal home; creating sites is milestone 2.
const stores = new Hono();

stores.get("/stores", requireAuth, async (c) => {
  const list = await listStoresForUser(c.env.DB, c.get("user").id);
  return c.json({
    stores: list.map((s) => ({ id: s.id, name: s.name, subdomain: s.subdomain, status: s.status, organisationId: s.organisation_id })),
  });
});

export default stores;
