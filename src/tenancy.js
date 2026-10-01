// Tenant isolation. Every read or write of store data must start here.
//
// Rule: a user can reach a store only if
//   (a) they are a member of the organisation that owns the store, or
//   (b) they are a member of the platform organisation (Wraperers support).
// Case (b) is flagged as `platformAccess` so the caller can audit-log it.

// Tables that are NOT owned by a single store. Every other table must have
// a `store_id` column (test/schema.test.js enforces this).
export const GLOBAL_TABLES = new Set([
  "users", "sessions", "email_tokens", "two_step_methods", "backup_codes",
  "organisations", "memberships", "invites", "stores", "rate_limits", "audit_log",
]);

export class AccessDenied extends Error {
  constructor() {
    super("Not found");
    this.status = 404; // 404, not 403: don't reveal that another store exists
  }
}

// Returns { store, role, orgType, platformAccess } or null.
export async function getStoreAccess(db, userId, storeId) {
  if (!userId || !storeId) return null;
  const row = await db
    .prepare(
      `SELECT s.id, s.organisation_id, s.subdomain, s.name, s.status,
              m.role AS role, o.type AS org_type
         FROM stores s
         JOIN memberships m ON m.user_id = ?1
         JOIN organisations o ON o.id = m.organisation_id
        WHERE s.id = ?2
          AND (m.organisation_id = s.organisation_id OR o.type = 'platform')
        ORDER BY (m.organisation_id = s.organisation_id) DESC
        LIMIT 1`
    )
    .bind(userId, storeId)
    .first();
  if (!row) return null;
  const { role, org_type, ...store } = row;
  return { store, role, orgType: org_type, platformAccess: org_type === "platform" };
}

// Same as getStoreAccess but throws, and can require specific roles.
export async function requireStoreAccess(db, userId, storeId, roles = null) {
  const access = await getStoreAccess(db, userId, storeId);
  if (!access) throw new AccessDenied();
  if (roles && !roles.includes(access.role)) throw new AccessDenied();
  return access;
}

// Stores the user can see. Platform members see every store.
export async function listStoresForUser(db, userId) {
  const { results } = await db
    .prepare(
      `SELECT DISTINCT s.id, s.organisation_id, s.subdomain, s.name, s.status
         FROM stores s
         JOIN memberships m ON m.user_id = ?1
         JOIN organisations o ON o.id = m.organisation_id
        WHERE m.organisation_id = s.organisation_id OR o.type = 'platform'
        ORDER BY s.name`
    )
    .bind(userId)
    .all();
  return results;
}

// A database handle locked to one store. Store-owned tables (from milestone 2)
// are read and written only through this, so `store_id` can't be forgotten.
export function storeScope(db, access) {
  const storeId = access?.store?.id;
  if (!storeId) throw new AccessDenied();
  const table = (name) => {
    if (!/^[a-z_]+$/.test(name) || GLOBAL_TABLES.has(name)) throw new Error("Not a store table");
    return name;
  };
  return {
    storeId,
    // where: extra SQL using ?2, ?3... (?1 is always the store id)
    all: (name, where = "1=1", ...params) =>
      db.prepare(`SELECT * FROM ${table(name)} WHERE store_id = ?1 AND (${where})`).bind(storeId, ...params).all(),
    first: (name, where = "1=1", ...params) =>
      db.prepare(`SELECT * FROM ${table(name)} WHERE store_id = ?1 AND (${where})`).bind(storeId, ...params).first(),
    insert: (name, row) => {
      const data = { ...row, store_id: storeId }; // always overrides any store_id passed in
      const cols = Object.keys(data);
      if (!cols.every((col) => /^[a-z_]+$/.test(col))) throw new Error("Bad column");
      return db
        .prepare(`INSERT INTO ${table(name)} (${cols.join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`)
        .bind(...Object.values(data))
        .run();
    },
    delete: (name, where, ...params) =>
      db.prepare(`DELETE FROM ${table(name)} WHERE store_id = ?1 AND (${where})`).bind(storeId, ...params).run(),
  };
}
