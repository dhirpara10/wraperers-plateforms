// Names a store can never take on <store>.wraperers.com.
// Extend this list as new platform addresses are added.
export const RESERVED_SUBDOMAINS = new Set([
  "app", "admin", "www", "api", "mail", "email", "send", "static", "assets", "cdn",
  "docs", "help", "support", "status", "blog", "dev", "staging", "test",
  // extras: mail/DNS plumbing and names that could be used to impersonate Wraperers
  "smtp", "imap", "pop", "mx", "ns", "ns1", "ns2", "ftp", "autodiscover", "autoconfig",
  "webmail", "portal", "login", "auth", "account", "accounts", "billing", "pay", "payments",
  "dashboard", "secure", "security", "root", "wraperers", "preview", "demo", "store", "shop",
  "media", "img", "images", "files", "internal", "localhost",
]);

// Returns a clean subdomain, or null if it isn't allowed.
// Rules: 3-40 chars, a-z 0-9 and hyphens, no leading/trailing hyphen,
// single level only (no dots), not reserved, no punycode ("xn--") lookalikes.
export function cleanSubdomain(value) {
  const name = String(value ?? "").trim().toLowerCase();
  if (!/^[a-z0-9](?:[a-z0-9-]{1,38})[a-z0-9]$/.test(name)) return null;
  if (name.includes("--")) return null;
  if (RESERVED_SUBDOMAINS.has(name)) return null;
  return name;
}
