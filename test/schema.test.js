import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { GLOBAL_TABLES } from "../src/tenancy.js";

describe("schema", () => {
  // Guard for the future: a new table must either be declared global on purpose,
  // or carry a store_id so it can be isolated per store.
  it("every table is global on purpose or has store_id", async () => {
    const { results: tables } = await env.DB
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' AND name NOT LIKE 'd1_%'")
      .all();
    expect(tables.length).toBeGreaterThan(0);

    for (const { name } of tables) {
      if (GLOBAL_TABLES.has(name)) continue;
      const { results: cols } = await env.DB.prepare(`PRAGMA table_info("${name}")`).all();
      const storeId = cols.find((col) => col.name === "store_id");
      expect(storeId, `table "${name}" needs store_id or a GLOBAL_TABLES entry`).toBeTruthy();
      expect(storeId.notnull, `"${name}".store_id must be NOT NULL`).toBe(1);
    }
  });

  it("allows only one platform organisation", async () => {
    const existing = await env.DB.prepare("SELECT id FROM organisations WHERE type = 'platform'").first();
    if (!existing) {
      await env.DB.prepare("INSERT INTO organisations (id, type, name) VALUES ('p1', 'platform', 'Wraperers')").run();
    }
    await expect(
      env.DB.prepare("INSERT INTO organisations (id, type, name) VALUES ('p2', 'platform', 'Fake')").run()
    ).rejects.toThrow();
  });

  it("rejects duplicate subdomains and unknown roles", async () => {
    await env.DB.prepare("INSERT INTO organisations (id, type, name) VALUES ('o-dup', 'brand', 'Dup')").run();
    await env.DB.prepare("INSERT INTO stores (id, organisation_id, subdomain, name) VALUES ('s-dup1', 'o-dup', 'dup-name', 'x')").run();
    await expect(
      env.DB.prepare("INSERT INTO stores (id, organisation_id, subdomain, name) VALUES ('s-dup2', 'o-dup', 'dup-name', 'y')").run()
    ).rejects.toThrow();

    await env.DB.prepare("INSERT INTO users (id, email, password_hash) VALUES ('u-role', 'role@x.test', 'test')").run();
    await expect(
      env.DB.prepare("INSERT INTO memberships (id, organisation_id, user_id, role) VALUES ('m-bad', 'o-dup', 'u-role', 'superuser')").run()
    ).rejects.toThrow();
  });
});
