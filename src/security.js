// Adapted from wraperers-v2/src/security.js. No Cloudflare Access here:
// the portal has its own login (src/auth).
import { ipHash } from "./auth/sessions.js";

// ---------- Output escaping: use for EVERY piece of user text shown in HTML ----------
const ESC = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
export function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (ch) => ESC[ch]);
}

// ---------- Security headers ----------
// Stricter than v2's admin: no inline scripts or styles, no third-party scripts.
export const PORTAL_CSP = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self' https://fonts.googleapis.com",
  "font-src 'self' https://fonts.gstatic.com",
  "img-src 'self' data: blob:",
  "connect-src 'self'",
  "manifest-src 'self'",
  "frame-ancestors 'none'",
  "base-uri 'none'",
  "form-action 'self'",
  "object-src 'none'",
].join("; ");

export function applySecurityHeaders(headers) {
  headers.set("X-Content-Type-Options", "nosniff");
  headers.set("Referrer-Policy", "strict-origin-when-cross-origin");
  // No includeSubDomains: this host must not set policy for the rest of wraperers.com.
  headers.set("Strict-Transport-Security", "max-age=31536000");
  headers.set("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
  headers.set("X-Frame-Options", "DENY");
  headers.set("Cross-Origin-Opener-Policy", "same-origin");
  headers.set("Cache-Control", "no-store");
  headers.set("Content-Security-Policy", PORTAL_CSP);
}

export const securityHeaders = async (c, next) => {
  await next();
  applySecurityHeaders(c.res.headers);
};

// ---------- Only answer on the portal's own address ----------
export const requirePortalHost = async (c, next) => {
  if (new URL(c.req.url).origin !== c.env.APP_ORIGIN) {
    return c.text("Not found", 404);
  }
  await next();
};

// ---------- Block cross-site form/API submissions ----------
// Exact match against the configured portal origin, so a store subdomain
// (which can run custom code) can never submit to the portal.
export const requireSameOrigin = async (c, next) => {
  if (!["GET", "HEAD", "OPTIONS"].includes(c.req.method)) {
    const origin = c.req.header("Origin");
    if (!origin || origin !== c.env.APP_ORIGIN) {
      return c.json({ error: "Bad origin" }, 403);
    }
  }
  await next();
};

// ---------- Audit log helper ----------
// details: { target, storeId, organisationId, platformAccess, userId, email }
// userId/email are for events with no signed-in user yet (e.g. a failed login).
export async function audit(c, action, details = {}) {
  const user = c.get("user");
  await c.env.DB
    .prepare(
      `INSERT INTO audit_log (id, user_id, user_email, organisation_id, store_id, action, target, platform_access, ip_hash)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .bind(
      crypto.randomUUID(),
      details.userId ?? user?.id ?? null,
      String(details.email ?? user?.email ?? "unknown").slice(0, 254),
      details.organisationId ?? null,
      details.storeId ?? null,
      action,
      details.target ?? null,
      details.platformAccess ? 1 : 0,
      await ipHash(c)
    )
    .run();
}
