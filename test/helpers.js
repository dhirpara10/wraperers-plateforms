import { env } from "cloudflare:test";

const id = () => crypto.randomUUID();

export async function makeUser(email) {
  const userId = id();
  await env.DB.prepare("INSERT INTO users (id, email, password_hash) VALUES (?, ?, 'test')").bind(userId, email).run();
  return userId;
}

export async function makeOrg(type, name) {
  const orgId = id();
  await env.DB.prepare("INSERT INTO organisations (id, type, name) VALUES (?, ?, ?)").bind(orgId, type, name).run();
  return orgId;
}

export async function addMember(orgId, userId, role) {
  await env.DB
    .prepare("INSERT INTO memberships (id, organisation_id, user_id, role) VALUES (?, ?, ?, ?)")
    .bind(id(), orgId, userId, role)
    .run();
}

export async function makeStore(orgId, subdomain) {
  const storeId = id();
  await env.DB
    .prepare("INSERT INTO stores (id, organisation_id, subdomain, name) VALUES (?, ?, ?, ?)")
    .bind(storeId, orgId, subdomain, subdomain)
    .run();
  return storeId;
}
