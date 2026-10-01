import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { escapeHtml } from "../src/security.js";
import { cleanSubdomain, RESERVED_SUBDOMAINS } from "../src/subdomains.js";
import { isValidRole, canUseCode } from "../src/roles.js";

const APP = "https://app.wraperers.com";

describe("portal responses", () => {
  it("serves the portal with strict security headers", async () => {
    const res = await SELF.fetch(`${APP}/`);
    expect(res.status).toBe(200);
    const csp = res.headers.get("Content-Security-Policy");
    expect(csp).toContain("script-src 'self'");
    expect(csp).not.toContain("unsafe-inline");
    expect(res.headers.get("X-Frame-Options")).toBe("DENY");
    expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
    // The page itself must have no inline script or style.
    const html = await res.text();
    expect(html).not.toMatch(/<script(?![^>]*\bsrc=)/i);
    expect(html).not.toMatch(/<style|style="/i);
  });

  it("reports a healthy database", async () => {
    const res = await SELF.fetch(`${APP}/api/health`);
    expect(await res.json()).toEqual({ ok: true });
  });

  it("does not answer on any other host", async () => {
    for (const host of ["https://wraperers.com", "https://somestore.wraperers.com", "https://admin.wraperers.com"]) {
      const res = await SELF.fetch(`${host}/`);
      expect(res.status).toBe(404);
      expect(res.headers.get("Content-Security-Policy")).toBeTruthy();
    }
  });
});

describe("origin check", () => {
  const post = (origin) =>
    SELF.fetch(`${APP}/api/anything`, { method: "POST", headers: origin ? { Origin: origin } : {} });

  it("blocks state-changing requests with a missing or foreign Origin", async () => {
    expect((await post(null)).status).toBe(403);
    expect((await post("https://evil.example")).status).toBe(403);
    expect((await post("https://somestore.wraperers.com")).status).toBe(403);
    expect((await post("https://app.wraperers.com.evil.example")).status).toBe(403);
    expect((await post("http://app.wraperers.com")).status).toBe(403);
  });

  it("lets the portal's own Origin through", async () => {
    expect((await post(APP)).status).toBe(404); // passes the check; no such route yet
  });
});

describe("helpers", () => {
  it("escapes HTML", () => {
    expect(escapeHtml(`<img src=x onerror="alert('1')">&`)).toBe(
      "&lt;img src=x onerror=&quot;alert(&#39;1&#39;)&quot;&gt;&amp;"
    );
    expect(escapeHtml(null)).toBe("");
  });

  it("blocks reserved and malformed subdomains", () => {
    for (const name of ["app", "admin", "www", "api", "mail", "email", "send", "static", "assets", "cdn",
      "docs", "help", "support", "status", "blog", "dev", "staging", "test"]) {
      expect(RESERVED_SUBDOMAINS.has(name)).toBe(true);
      expect(cleanSubdomain(name)).toBeNull();
      expect(cleanSubdomain(name.toUpperCase())).toBeNull();
    }
    for (const bad of ["", "ab", "-abc", "abc-", "a.b", "a_b", "xn--80ak6aa92e", "a b", "é-shop", "x".repeat(41), null]) {
      expect(cleanSubdomain(bad)).toBeNull();
    }
    expect(cleanSubdomain("  Urban-Threads ")).toBe("urban-threads");
  });

  it("matches roles to organisation types", () => {
    expect(isValidRole("brand", "editor")).toBe(true);
    expect(isValidRole("brand", "staff")).toBe(false);
    expect(isValidRole("agency", "viewer")).toBe(false);
    expect(isValidRole("nope", "owner")).toBe(false);
    expect(canUseCode("brand", "owner")).toBe(true);
    expect(canUseCode("agency", "admin")).toBe(true);
    expect(canUseCode("brand", "editor")).toBe(false);
    expect(canUseCode("agency", "member")).toBe(false);
  });
});
