# Wraperers Platform — project context

Read this whole file before making changes. It explains the business, what already exists, the decisions already made, and how to work on this project.

## 1. The business

Wraperers (wraperers.com) builds online stores for clothing and fashion brands. It is run by Dhruv, an Information Systems student in Melbourne, originally from India. Main market: small Indian clothing brands that sell through Instagram DMs.

- Positioning: a lower-cost, better-supported alternative to Shopify for fashion brands. Custom stores, the brand's own admin panel, fashion features built in, no app bills.
- Offer: free homepage preview first, then setup fee + monthly fee (₹1,200/month maintenance to start, founding-client pricing for the first clients).
- Long-term goal: a "mini Shopify" platform where Dhruv, his team, partner agencies and brands build and run stores, with reusable templates and features built once and rolled out to every store.
- Add-on features are called **Wraps** (e.g. COD Confirm, Heatmaps, Google Shopping, WhatsApp Updates, Size Finder, Reviews). Wraps are free; only usage with a real cost (WhatsApp messages, SMS) is paid, through prepaid credits.
- Brand colours: orange `#FF6A2B`, button shadow `#B8420E`, light background `#EEEEE8`, dark text `#18191C`. Font: Bricolage Grotesque.

## 2. What already exists: `wraperers-v2` (LIVE — do not break)

The live marketing site + admin, in the sibling folder `../wraperers-v2`. **This project (`wraperers-platform`) is separate. Never modify `../wraperers-v2` unless Dhruv explicitly asks.** Copy code from it when useful.

Stack: Cloudflare Workers + Hono, D1 (SQLite), R2, Turnstile, Cloudflare Access. No frontend framework: server-rendered HTML for the public site, a vanilla-JS single-page admin.

Live addresses:
- `wraperers.com` (public site), `www.wraperers.com` (301 to wraperers.com)
- `admin.wraperers.com` (admin, protected by Cloudflare Access + `admin_users` table check)

Bindings (wrangler.toml): `DB` (D1 `wraperers-db`), `MEDIA` (R2 `wraperers-media`); vars `ADMIN_HOST`, `SITE_URL`, `ACCESS_TEAM_DOMAIN`, `ACCESS_AUD`, `TURNSTILE_SITE_KEY`; secrets `TURNSTILE_SECRET`, `IP_SALT`. Text-module rule loads `**/*.html`, `**/*.css`, `**/*.client.js` as strings.

Key files in `../wraperers-v2/src`:
- `index.js` — routes by hostname (admin vs public), www redirect
- `security.js` — security headers + CSP, `requireSameOrigin` (exact Origin check on POST/PUT/PATCH/DELETE), `requireAdmin(roles)` (verifies Access JWT with `jose`, then checks `admin_users`), `escapeHtml`, `audit()`
- `util.js` — `safeUrl` (blocks `javascript:` etc.), `safeColor`, `safeAnchor`, `extAttrs`
- `defaults.js` — default site settings + `mergeDeep`
- `layout.js` — page shell: head/SEO/OG, theme colour vars, header, mobile menu, footer
- `styles.js` — all public-site CSS as a JS string
- `page.js` — `getSettings`, `getProjects`, `servePage` (catch-all; code pages without layout are served raw)
- `blocks/types.js` — every section type, its fields and defaults (the editor builds forms from this)
- `blocks/validate.js` — server-side validation: `cleanBlocks` (drops unknown fields, checks URLs/lengths, owner-only Custom code), `cleanSlug` (reserved paths), `cleanMeta`, `cleanCode`
- `blocks/render.js` — renderers for each section (homeHero, offerHero, work, services, why, process, compare, featureGroups, spotlight, roles, packages, faq, contact, cta, text, custom) + `renderBody`; Work section has live demo previews, tag filters and a Preview popup
- `enquiries.js` — contact form (Turnstile, rate limit via D1, honeypot, hashed IP) + admin enquiry routes
- `admin/pages-api.js` — pages: drafts, publish (keeps 30 versions in `page_history`), discard, history/restore, code mode, preview
- `admin/projects-api.js` — portfolio projects + hosted one-file demo pages at `/work/<slug>`
- `admin/settings-api.js` — brand, contact, menu, footer, SEO settings (owner only)
- `admin/media.js` — image uploads to R2 (type checked by magic bytes, no SVG, 5 MB max)
- `admin/index.html`, `admin/admin.css`, `admin/app.client.js` — the admin SPA: dashboard, enquiries, pages + block editor (drag/reorder, live sandboxed preview, autosave drafts, code mode with Tidy + .html upload, history), projects, site settings

D1 tables: `settings`, `pages` (incl. `mode`, `blocks`, `code`, `draft`, `show_layout`, `version`), `page_history`, `projects` (incl. `tags`), `enquiries`, `rate_limits`, `admin_users`, `audit_log`.

## 3. What we are building now: the client portal (this folder)

A multi-store platform where people log in, build sites, host them and connect domains, without leaving the portal.

### Decisions already made
- **Separate project and database.** New Worker `wraperers-platform`, new D1 database, reuse code copied from v2. Once stable, wraperers.com moves onto the platform as store #1.
- **Addresses:**
  - `app.wraperers.com` — the portal
  - `<store>.wraperers.com` — free address for every site (no second domain for now; Dhruv will buy a separate store domain later, like myshopify.com, and sites will move to it)
  - Custom domains connected inside the portal via **Cloudflare for SaaS** (custom hostnames)
- **Login:** email + password + required two-step login.
  - Passwords hashed with a strong one-way hash (PBKDF2 via WebCrypto with a high iteration count, or better if available on Workers). Never store or log plain passwords.
  - Email verification on signup, password reset by email.
  - Two-step: authenticator app (TOTP) recommended; email code allowed (mainly for brand users). Backup codes.
  - Lockout / rate limits on repeated failures.
  - Transactional email via **Resend** (API key as a Worker secret), sending from `@wraperers.com`.
- **Who uses it:** Wraperers (Dhruv + his team), agencies + their teams, brands + their teams.

| Group | Roles | Access |
|---|---|---|
| Wraperers (platform) | Owner, Staff | All stores, for support. Every action audit-logged. |
| Agencies | Owner, Admin, Member | Stores the agency created/manages |
| Brands | Owner, Editor, Viewer | Only their own store |

  An agency builds a store and invites the brand owner, who sees only that store. Brands can also sign up directly. Owners manage their own team. Code mode and Custom code are limited to trusted roles (owners/admins).

### Security rules (non-negotiable)
- **Tenant isolation:** every store-owned row has `store_id`. All queries go through helpers that require the current store and check the user's access. Add tests that prove one store can never read or write another's data.
- **Cookies:** session cookies use the `__Host-` prefix, `Secure`, `HttpOnly`, `SameSite=Strict`, `Path=/`, no `Domain` — so store subdomains (which can run custom code) can't read or overwrite them.
- **Origin check** on every state-changing request (exact match to `https://app.wraperers.com`).
- **Reserved subdomains** that stores can't take: app, admin, www, api, mail, email, send, static, assets, cdn, docs, help, support, status, blog, dev, staging, test (extend as needed).
- Strict CSP on the portal; no inline scripts in the portal (load JS from the same origin, as v2 does).
- Escape all user content; validate everything server-side (reuse v2's validate.js approach); store HTML only for owner/admin roles.
- Media in R2 under a per-store prefix, type-checked by magic bytes, no SVG uploads.
- Secrets only as Worker secrets, never in code or wrangler.toml.
- Audit log for logins, role changes, publishes, domain changes, deletes, and all platform-staff access.

### Milestones
1. **Foundation** ← start here
   1. New project, D1 schema, `app.wraperers.com` connected
   2. Signup, email verification, login, two-step setup, backup codes, password reset, sessions, lockout
   3. Organisations (platform / agency / brand), memberships + roles, team invites by email
   4. Portal home: "Your sites" (empty) and "Your team"
2. **Sites:** create a site from a template; the v2 block editor, code mode, history, media and settings, all scoped per store
3. **Hosting:** serve sites on `<store>.wraperers.com` (wildcard routing; reserved names blocked), then custom domains via Cloudflare for SaaS with a DNS-instructions screen and live status
4. **Team and clients:** agency → brand handover and invites with limited access
5. **Wraps:** on/off framework per store + first Wraps (contact form/enquiries, heatmaps via Microsoft Clarity ID, tracking pixels + cookie consent, SEO sitemap/robots)
6. **Billing:** plans and payments (likely Razorpay for India); usage credits for paid Wraps
7. **Commerce (later):** products, variants/sizes, cart, checkout (UPI, cards, COD via Razorpay), COD confirmation on WhatsApp, Shiprocket shipping, GST invoices, orders and stock

### Known constraints
- Cloudflare free tier at first; plan to move to Workers Paid ($5/month) before real clients rely on it (D1 free-tier limits are hard cutoffs).
- Universal SSL covers first-level subdomains only (`*.wraperers.com`), not `*.something.wraperers.com` — keep store subdomains first-level.
- The live v2 site already uses `wraperers.com`, `www` and `admin` as Worker custom domains. Make sure wildcard routing for stores never captures those.

## 4. How to work with Dhruv

- He is learning as he builds. Explain what each change does in plain language, and why, before or after making it. Keep explanations short.
- Work in small, tested steps. After each step, tell him exactly how to test it (commands, URLs, what he should see).
- Security is the top priority; call out risks honestly, including when an idea of his has a downside.
- Before any destructive action (dropping tables, deleting R2 objects, removing domains, changing DNS), explain it and ask first.
- Never touch `../wraperers-v2` unless asked.
- Commit after each working step with a clear message.
- Prices or limits of outside services (Cloudflare, Resend, Meta, etc.) change: say "check current pricing" rather than stating numbers as fact.

## 5. How this repo is laid out

- `src/index.js` — the Worker entry: host check, security headers, Origin check, routes
- `src/security.js` — `escapeHtml`, `securityHeaders`, `requireSameOrigin`, `audit` (adapted from v2; no Cloudflare Access)
- `src/subdomains.js` — `RESERVED_SUBDOMAINS` and `cleanSubdomain`
- `src/roles.js` — organisation types and the roles each type allows
- `src/tenancy.js` — tenant-isolation helpers; every store lookup must go through these
- `src/portal/` — portal HTML/CSS/JS, loaded as text and served from the same origin (no inline scripts or styles)
- `migrations/` — D1 migrations, applied in order. Never edit an applied migration; add a new one.
- `test/` — Vitest tests running inside the Workers runtime (`npm test`)

Rule for new tables: every table is either store-owned (must have a `store_id` column) or listed in `GLOBAL_TABLES` in `src/tenancy.js`. `test/schema.test.js` fails otherwise.

Commands: `npm run dev` (local server on http://localhost:8787), `npm test`, `npm run db:migrate:local`.
