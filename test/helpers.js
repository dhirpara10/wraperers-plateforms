import { env, SELF } from "cloudflare:test";
import { hashPassword } from "../src/auth/password.js";

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

// ---------- Login test helpers ----------

export const APP = "https://app.wraperers.com";

export async function makeLoginUser(email, password) {
  const userId = id();
  await env.DB
    .prepare("INSERT INTO users (id, email, name, password_hash, email_verified_at) VALUES (?, ?, 'Test User', ?, datetime('now'))")
    .bind(userId, email, await hashPassword(password))
    .run();
  return userId;
}

// A tiny browser stand-in: remembers the session cookie between requests
// and sends its own IP, so tests don't share a rate limit.
export function makeClient() {
  let cookie = "";
  const ip = `10.${Math.floor(Math.random() * 255)}.${Math.floor(Math.random() * 255)}.${Math.floor(Math.random() * 255)}`;
  const client = {
    lastSetCookie: "",
    get cookie() { return cookie; },
    set cookie(value) { cookie = value; },
    async request(method, path, body) {
      const headers = { "CF-Connecting-IP": ip };
      if (cookie) headers.Cookie = cookie;
      if (method !== "GET") {
        headers.Origin = APP;
        headers["Content-Type"] = "application/json";
      }
      const res = await SELF.fetch(`${APP}${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
      const setCookie = res.headers.getSetCookie().at(-1);
      if (setCookie) {
        client.lastSetCookie = setCookie;
        const [pair] = setCookie.split(";");
        cookie = pair.endsWith("=") ? "" : pair;
      }
      return { status: res.status, body: await res.json() };
    },
    get: (path) => client.request("GET", path),
    post: (path, body) => client.request("POST", path, body ?? {}),
  };
  return client;
}
