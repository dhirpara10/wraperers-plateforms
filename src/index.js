import { Hono } from "hono";
import { securityHeaders, applySecurityHeaders, requirePortalHost, requireSameOrigin } from "./security.js";
import { AccessDenied } from "./tenancy.js";
import { loadSession } from "./auth/sessions.js";
import auth from "./auth/routes.js";
import teams from "./teams.js";
import portalHtml from "./portal/index.html";
import portalCss from "./portal/portal.css";
import portalJs from "./portal/portal.client.js";

const app = new Hono();

// Order matters: headers on every response, then host check, then Origin check,
// and only then is the session cookie read.
app.use("*", securityHeaders);
app.use("*", requirePortalHost);
app.use("*", requireSameOrigin);
app.use("/api/*", loadSession);

// ---------- Static portal files (same origin, so the CSP allows them) ----------
app.get("/assets/portal.css", (c) => c.body(portalCss, 200, { "Content-Type": "text/css; charset=utf-8" }));
app.get("/assets/portal.client.js", (c) =>
  c.body(portalJs, 200, { "Content-Type": "text/javascript; charset=utf-8" })
);

// ---------- API ----------
// Says whether the database is reachable and migrated. Reveals nothing else.
app.get("/api/health", async (c) => {
  try {
    await c.env.DB.prepare("SELECT 1 FROM stores LIMIT 1").first();
    return c.json({ ok: true });
  } catch {
    return c.json({ ok: false }, 503);
  }
});

app.route("/api", auth);
app.route("/api", teams);

app.all("/api/*", (c) => c.json({ error: "Not found" }, 404));

// ---------- Portal page ----------
app.get("/", (c) => c.html(portalHtml));

app.notFound((c) => c.text("Not found", 404));

app.onError((err, c) => {
  let res;
  if (err instanceof AccessDenied) {
    res = c.json({ error: "Not found" }, 404);
  } else {
    console.error(err); // details go to the logs, never to the browser
    res = c.json({ error: "Something went wrong" }, 500);
  }
  applySecurityHeaders(res.headers);
  return res;
});

export default app;
