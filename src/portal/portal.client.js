// Portal front-end. Served from /assets/ on the same origin (the CSP blocks inline scripts).
// All text goes in with textContent, never innerHTML, so nothing typed by a user can run as code.

const view = document.getElementById("view");

// ---------- Small helpers ----------
function el(tag, props = {}, children = []) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (key === "text") node.textContent = value;
    else if (key === "class") node.className = value;
    else if (key.startsWith("on")) node.addEventListener(key.slice(2), value);
    else node.setAttribute(key, value);
  }
  for (const child of [].concat(children)) if (child) node.append(child);
  return node;
}

async function api(method, path, body) {
  const res = await fetch(path, {
    method,
    headers: body ? { "Content-Type": "application/json" } : {},
    body: body ? JSON.stringify(body) : undefined,
    credentials: "same-origin",
  });
  const data = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, data };
}

// Sign-in screens: the small centred card.
function show(...nodes) {
  document.body.classList.remove("app");
  view.replaceChildren(...nodes.filter(Boolean));
  view.querySelector("input")?.focus();
}

// Signed-in pages: wide layout with the top bar. Set by renderPage() on every page load.
let me = null;

function showPage(...nodes) {
  document.body.classList.add("app");
  const here = location.hash.startsWith("#/security") ? "security" : "home";
  const navLink = (href, text, name) => el("a", here === name ? { href, text, "aria-current": "page" } : { href, text });
  const nav = el("nav", { "aria-label": "Main" }, [
    navLink("#/", "Home", "home"),
    navLink("#/security", "Security", "security"),
    signOutLink("Sign out", "link inline"),
  ]);
  view.replaceChildren(
    el("header", { class: "topbar" }, [
      el("a", { class: "logo", href: "#/", text: "Wraperers" }),
      el("span", { class: "who", text: me?.user.email ?? "" }),
      nav,
    ]),
    el("div", { class: "page" }, nodes.filter(Boolean))
  );
  window.scrollTo(0, 0);
}

function field(label, attrs) {
  const input = el("input", attrs);
  return { input, row: el("label", { class: "field" }, [el("span", { text: label }), input]) };
}

function selectField(label, options) {
  const input = el("select", {}, options.map(([value, text]) => el("option", { value, text })));
  return { input, row: el("label", { class: "field" }, [el("span", { text: label }), input]) };
}

const ROLE_LABELS = { owner: "Owner", staff: "Staff", admin: "Admin", member: "Member", editor: "Editor", viewer: "Viewer" };
const TYPE_LABELS = { platform: "Wraperers", agency: "Agency", brand: "Brand" };
const STATUS_LABELS = { draft: "Draft", live: "Live", suspended: "Suspended" };

// A form with one error line and a button that disables while the request runs.
function form(fields, buttonText, onSubmit) {
  const error = el("p", { class: "error", role: "alert" });
  const button = el("button", { type: "submit", class: "button", text: buttonText });
  const node = el("form", { novalidate: "" }, [...fields.map((f) => f.row), error, button]);
  node.addEventListener("submit", async (event) => {
    event.preventDefault();
    error.textContent = "";
    button.disabled = true;
    try {
      const message = await onSubmit();
      if (message) error.textContent = message;
    } catch {
      error.textContent = "Could not reach the server. Please try again.";
    }
    button.disabled = false;
  });
  return node;
}

const codeAttrs = {
  type: "text", inputmode: "numeric", autocomplete: "one-time-code", maxlength: "7", placeholder: "123456", required: "",
};

// ---------- Screens ----------
function showLogin() {
  const email = field("Email", { type: "email", autocomplete: "username", required: "" });
  const password = field("Password", { type: "password", autocomplete: "current-password", required: "" });
  show(
    el("h1", { text: "Sign in" }),
    form([email, password], "Continue", async () => {
      const res = await api("POST", "/api/auth/login", { email: email.input.value, password: password.input.value });
      if (!res.ok) return res.data.error || "Something went wrong.";
      route(res.data.state);
    })
  );
}

async function showSetup() {
  const res = await api("POST", "/api/auth/two-step/setup/start");
  if (!res.ok) return res.status === 401 ? showLogin() : showMessage(res.data.error);

  const code = field("6-digit code from the app", codeAttrs);
  const qr = el("img", {
    class: "qr",
    alt: "QR code for your authenticator app",
    src: `data:image/svg+xml;utf8,${encodeURIComponent(res.data.qr)}`,
  });
  show(
    el("h1", { text: "Set up two-step login" }),
    el("p", { text: "Every account needs this. Open an authenticator app (Google Authenticator, Microsoft Authenticator, 1Password, Authy) and scan this code." }),
    qr,
    el("p", { class: "hint", text: "Can't scan? Type this key into the app instead:" }),
    el("code", { class: "secret", text: res.data.secret.replace(/(.{4})/g, "$1 ").trim() }),
    form([code], "Turn on two-step login", async () => {
      const confirm = await api("POST", "/api/auth/two-step/setup/confirm", { code: code.input.value });
      if (!confirm.ok) return confirm.data.error || "Something went wrong.";
      showBackupCodes(confirm.data.backupCodes, true);
    }),
    signOutLink("Cancel")
  );
}

function showBackupCodes(codes, firstTime) {
  const saved = el("input", { type: "checkbox", id: "saved" });
  const button = el("button", { class: "button", text: "Continue", disabled: "", onclick: () => route("signed_in") });
  saved.addEventListener("change", () => (button.disabled = !saved.checked));
  (firstTime ? show : showPage)(
    el("h1", { text: firstTime ? "Save your backup codes" : "Your new backup codes" }),
    el("p", { text: "If you lose your phone, each of these codes lets you sign in once. They are shown only this one time. Keep them somewhere safe, like a password manager." }),
    el("ul", { class: "codes" }, codes.map((code) => el("li", { text: code }))),
    el("button", {
      class: "link", type: "button", text: "Copy all codes",
      onclick: (event) => navigator.clipboard.writeText(codes.join("\n")).then(() => (event.target.textContent = "Copied")),
    }),
    el("label", { class: "check" }, [saved, el("span", { text: "I have saved these codes" })]),
    button
  );
}

function showTwoStep(useBackup = false) {
  const code = useBackup
    ? field("Backup code", { type: "text", autocomplete: "off", placeholder: "xxxxx-xxxxx", required: "" })
    : field("6-digit code from your authenticator app", codeAttrs);
  show(
    el("h1", { text: "Two-step login" }),
    form([code], "Sign in", async () => {
      const body = useBackup ? { backupCode: code.input.value } : { code: code.input.value };
      const res = await api("POST", "/api/auth/two-step/verify", body);
      if (res.status === 429) return showMessage(res.data.error);
      if (!res.ok) return res.data.error || "Something went wrong.";
      route("signed_in");
    }),
    el("button", {
      class: "link", type: "button",
      text: useBackup ? "Use my authenticator app instead" : "Lost your phone? Use a backup code",
      onclick: () => showTwoStep(!useBackup),
    }),
    signOutLink("Start again")
  );
}

async function showHome() {
  const [orgs, sites] = await Promise.all([api("GET", "/api/orgs"), api("GET", "/api/stores")]);
  const { organisations = [], canCreate = false } = orgs.data;
  const stores = sites.data.stores ?? [];
  const canCreateSite = organisations.some((org) => org.canCreateSite);

  const siteList = stores.length
    ? el("ul", { class: "list" }, stores.map((site) => el("li", {}, [
        el("div", {}, [
          el("a", { href: `#/site/${encodeURIComponent(site.id)}`, text: site.name }),
          el("div", { class: "hint", text: `${site.subdomain}.wraperers.com` }),
        ]),
        el("span", { class: "tag", text: STATUS_LABELS[site.status] ?? site.status }),
      ])))
    : el("div", { class: "empty" }, [
        el("strong", { text: "No sites yet" }),
        el("p", { class: "hint", text: canCreateSite ? "Create your first site to get started." : "When your team creates a site, it will show here." }),
      ]);

  const teamList = organisations.length
    ? el("ul", { class: "list" }, organisations.map((org) => el("li", {}, [
        el("a", { href: `#/team/${encodeURIComponent(org.id)}`, text: org.name }),
        el("span", { class: "tag", text: `${TYPE_LABELS[org.type]}${org.role ? " · " + ROLE_LABELS[org.role] : ""}` }),
      ])))
    : el("div", { class: "empty" }, [
        el("strong", { text: "You are not part of a team yet" }),
        el("p", { class: "hint", text: "Ask your team owner to send you an invite link." }),
      ]);

  showPage(
    el("h1", { text: `Hello${me.user.name ? ", " + me.user.name : ""}` }),
    me.backupCodesLeft <= 2
      ? el("p", { class: "status bad" }, [
          el("span", { text: `Only ${me.backupCodesLeft} backup codes left. ` }),
          el("a", { href: "#/security", text: "Make new ones" }),
        ])
      : null,
    el("section", {}, [
      el("h2", { text: "Your sites" }),
      siteList,
      canCreateSite ? el("a", { class: "link", href: "#/new-site", text: "+ New site" }) : null,
    ]),
    el("section", {}, [
      el("h2", { text: canCreate ? "Teams" : "Your team" }),
      teamList,
      canCreate ? el("a", { class: "link", href: "#/new-org", text: "+ New agency or brand" }) : null,
    ])
  );
}

function showSecurity() {
  showPage(
    el("h1", { text: "Security" }),
    el("section", {}, [
      el("h2", { text: "Two-step login" }),
      el("p", { text: "On. You sign in with your password and a code from your authenticator app." }),
    ]),
    el("section", {}, [
      el("h2", { text: "Backup codes" }),
      el("p", { class: me.backupCodesLeft <= 2 ? "status bad" : "hint", text: `Backup codes left: ${me.backupCodesLeft} of 10` }),
      el("button", { class: "link", type: "button", text: "Make new backup codes", onclick: showRegenerate }),
    ])
  );
}

// ---------- Sites ----------
// Turns a site name into a suggested address: "Kurta Co." -> "kurta-co"
function suggestSubdomain(name) {
  return name.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40).replace(/-+$/, "");
}

async function showCreateSite() {
  const res = await api("GET", "/api/orgs");
  const orgs = (res.data.organisations ?? []).filter((org) => org.canCreateSite);
  if (!orgs.length) {
    return showPage(el("h1", { text: "New site" }), el("p", { text: "You can't create sites. Ask your team owner." }),
      el("a", { class: "link", href: "#/", text: "Back" }));
  }

  const org = selectField("For", orgs.map((o) => [o.id, `${o.name} (${TYPE_LABELS[o.type]})`]));
  const name = field("Site name", { type: "text", maxlength: "80", required: "", placeholder: "Kurta Co" });
  const address = field("Address", {
    type: "text", maxlength: "40", required: "", autocapitalize: "off", autocomplete: "off", spellcheck: "false", placeholder: "kurta-co",
  });
  const status = el("p", { class: "hint", "aria-live": "polite" });
  address.row.querySelector("span").after(el("span", { class: "hint suffix", text: "Your free address: <name>.wraperers.com" }));
  address.row.append(status);

  // Suggest an address from the name, until the person types their own.
  let addressEdited = false;
  let timer;
  const check = () => {
    clearTimeout(timer);
    const value = address.input.value.trim().toLowerCase();
    status.className = "hint";
    status.textContent = value ? `${value}.wraperers.com` : "";
    if (!value) return;
    timer = setTimeout(async () => {
      const r = await api("GET", `/api/subdomains/check?name=${encodeURIComponent(value)}`);
      if (address.input.value.trim().toLowerCase() !== value) return; // they kept typing
      status.className = r.data.ok ? "hint good" : "hint bad-text";
      status.textContent = r.data.ok ? `✓ ${value}.wraperers.com is available` : r.data.reason;
    }, 350);
  };
  name.input.addEventListener("input", () => {
    if (addressEdited) return;
    address.input.value = suggestSubdomain(name.input.value);
    check();
  });
  address.input.addEventListener("input", () => {
    addressEdited = address.input.value !== "";
    check();
  });

  showPage(
    el("h1", { text: "New site" }),
    orgs.length === 1 ? el("p", { class: "hint", text: `For ${orgs[0].name}` }) : null,
    form(orgs.length === 1 ? [name, address] : [org, name, address], "Create site", async () => {
      const r = await api("POST", "/api/stores", {
        organisationId: orgs.length === 1 ? orgs[0].id : org.input.value,
        name: name.input.value,
        subdomain: address.input.value,
      });
      if (!r.ok) return r.data.error || "Something went wrong.";
      go(`/site/${r.data.store.id}`);
    }),
    el("a", { class: "link", href: "#/", text: "Back" })
  );
}

async function showSite(storeId) {
  const res = await api("GET", `/api/stores/${encodeURIComponent(storeId)}`);
  if (res.status === 401) return showLogin();
  if (!res.ok) {
    return showPage(el("h1", { text: "Site not found" }), el("p", { text: "It doesn't exist, or you don't have access to it." }),
      el("a", { class: "link", href: "#/", text: "Back to home" }));
  }
  const { store, organisation, yourRole, platformAccess } = res.data;
  const facts = (rows) => el("dl", { class: "facts" }, rows.flatMap(([k, v]) => [el("dt", { text: k }), el("dd", {}, [v])]));

  showPage(
    el("h1", { text: store.name }),
    platformAccess ? el("p", { class: "status", text: "You are viewing this site as Wraperers support. This is recorded in the audit log." }) : null,
    facts([
      ["Address", el("span", { text: `${store.subdomain}.wraperers.com` })],
      ["Status", el("span", { class: "tag", text: STATUS_LABELS[store.status] ?? store.status })],
      ["Team", el("a", { href: `#/team/${encodeURIComponent(organisation.id)}`, text: `${organisation.name} (${TYPE_LABELS[organisation.type]})` })],
      ["Your role", el("span", { text: yourRole ? ROLE_LABELS[yourRole] : "Wraperers support" })],
    ]),
    el("div", { class: "empty" }, [
      el("strong", { text: "Not online yet" }),
      el("p", { class: "hint", text: "Next: pages and the editor. After that, publishing to your address." }),
    ]),
    el("a", { class: "link", href: "#/", text: "Back" })
  );
}

function showCreateOrg() {
  const type = selectField("Type", [["brand", "Brand"], ["agency", "Agency"]]);
  const name = field("Name", { type: "text", maxlength: "80", required: "" });
  showPage(
    el("h1", { text: "New agency or brand" }),
    el("p", { class: "hint", text: "After creating it, invite its owner from the team page." }),
    form([type, name], "Create", async () => {
      const res = await api("POST", "/api/orgs", { type: type.input.value, name: name.input.value });
      if (!res.ok) return res.data.error || "Something went wrong.";
      go(`/team/${res.data.organisation.id}`);
    }),
    el("a", { class: "link", href: "#/", text: "Back" })
  );
}

async function showTeam(orgId) {
  const res = await api("GET", `/api/orgs/${encodeURIComponent(orgId)}/team`);
  if (res.status === 401) return showLogin();
  if (!res.ok) {
    return showPage(el("h1", { text: "Team not found" }), el("p", { text: "It doesn't exist, or you don't have access to it." }),
      el("a", { class: "link", href: "#/", text: "Back to home" }));
  }
  const team = res.data;
  const roles = team.assignableRoles;
  const canManage = roles.length > 0;

  // Runs a change, then reloads the team (or shows what went wrong).
  const act = async (method, path, body, leftTeam = false) => {
    const r = await api(method, path, body);
    if (!r.ok) alert(r.data.error || "Something went wrong.");
    if (r.ok && leftTeam) return go("/");
    showTeam(orgId);
  };
  const base = `/api/orgs/${encodeURIComponent(orgId)}`;

  const members = !team.members.length
    ? el("div", { class: "empty" }, [
        el("strong", { text: "No members yet" }),
        el("p", { class: "hint", text: canManage ? "Invite the owner below." : "" }),
      ])
    : el("ul", { class: "list" }, team.members.map((m) => {
    const who = el("div", {}, [
      el("strong", { text: m.name || m.email }),
      el("div", { class: "hint", text: m.isYou ? `${m.email} (you)` : m.email }),
    ]);
    let roleNode = el("span", { class: "tag", text: ROLE_LABELS[m.role] });
    if (canManage && roles.includes(m.role)) {
      const select = el("select", { class: "small", "aria-label": `Role for ${m.email}` },
        roles.map((r) => el("option", { value: r, text: ROLE_LABELS[r] })));
      select.value = m.role;
      select.addEventListener("change", () => act("PATCH", `${base}/members/${encodeURIComponent(m.userId)}`, { role: select.value }));
      roleNode = select;
    }
    const removable = (canManage && roles.includes(m.role)) || (m.isYou && !team.platformAccess);
    const remove = removable
      ? el("button", {
          class: "link inline danger", type: "button", text: m.isYou ? "Leave" : "Remove",
          onclick: () => {
            const question = m.isYou ? `Leave ${team.organisation.name}?` : `Remove ${m.email} from ${team.organisation.name}?`;
            if (confirm(question)) act("DELETE", `${base}/members/${encodeURIComponent(m.userId)}`, undefined, m.isYou);
          },
        })
      : null;
    return el("li", {}, [who, el("div", { class: "actions" }, [roleNode, remove])]);
  }));

  const pending = team.invites.length
    ? el("ul", { class: "list" }, team.invites.map((inv) => el("li", {}, [
        el("div", {}, [el("strong", { text: inv.email }), el("div", { class: "hint", text: `${ROLE_LABELS[inv.role]} · link expires ${inv.expiresAt.slice(0, 10)}` })]),
        roles.includes(inv.role)
          ? el("button", { class: "link inline danger", type: "button", text: "Cancel", onclick: () => act("DELETE", `${base}/invites/${encodeURIComponent(inv.id)}`) })
          : null,
      ])))
    : null;

  let inviteForm = null;
  if (canManage) {
    const email = field("Email", { type: "email", autocomplete: "off", required: "" });
    const role = selectField("Role", roles.map((r) => [r, ROLE_LABELS[r]]));
    role.input.value = roles[roles.length - 1]; // start on the lowest role, so nobody becomes an owner by accident
    inviteForm = form([email, role], "Make invite link", async () => {
      const r = await api("POST", `${base}/invites`, { email: email.input.value, role: role.input.value });
      if (!r.ok) return r.data.error || "Something went wrong.";
      showInviteLink(orgId, r.data);
    });
  }

  showPage(
    el("h1", { text: team.organisation.name }),
    el("p", { class: "hint", text: `${TYPE_LABELS[team.organisation.type]}${team.yourRole ? " · you are " + ROLE_LABELS[team.yourRole] : ""}` }),
    team.platformAccess ? el("p", { class: "status", text: "You are viewing this team as Wraperers support. This is recorded in the audit log." }) : null,
    el("h2", { text: "Members" }),
    members,
    pending ? el("h2", { text: "Waiting to join" }) : null,
    pending,
    inviteForm ? el("h2", { text: "Invite someone" }) : null,
    inviteForm,
    el("a", { class: "link", href: "#/", text: "Back" })
  );
}

function showInviteLink(orgId, data) {
  showPage(
    el("h1", { text: "Invite link ready" }),
    el("p", { text: `Send this link to ${data.invite.email} yourself (WhatsApp, Instagram...). It works once and expires in ${data.days} days.` }),
    el("code", { class: "secret", text: data.link }),
    el("button", {
      class: "button", type: "button", text: "Copy link",
      onclick: (event) => navigator.clipboard.writeText(data.link).then(() => (event.target.textContent = "Copied")),
    }),
    el("p", { class: "hint", text: "Anyone with this link can join as this person, so only send it to them. You won't see it again; if it's lost, make a new one." }),
    el("button", { class: "link", type: "button", text: "Back to team", onclick: () => showTeam(orgId) })
  );
}

// ---------- Opening an invite link (#invite=...) ----------
// The secret is kept in this tab only (sessionStorage) while the person signs in.
const INVITE_KEY = "pendingInvite";
const getPendingInvite = () => { try { return sessionStorage.getItem(INVITE_KEY); } catch { return null; } };
const setPendingInvite = (token) => { try { token ? sessionStorage.setItem(INVITE_KEY, token) : sessionStorage.removeItem(INVITE_KEY); } catch {} };

async function showInvite(token) {
  const res = await api("POST", "/api/invites/lookup", { token });
  if (!res.ok) {
    setPendingInvite(null);
    return show(el("h1", { text: "Invite" }), el("p", { text: res.data.error || "Something went wrong." }),
      el("button", { class: "link", type: "button", text: "Go to the portal", onclick: () => go("/") }));
  }
  const inv = res.data;
  const intro = el("p", { text: `You're invited to join ${inv.organisation.name} (${TYPE_LABELS[inv.organisation.type]}) as ${ROLE_LABELS[inv.role]}.` });

  if (inv.hasAccount) {
    if (inv.signedInAs === inv.email) {
      return show(el("h1", { text: "Join the team" }), intro,
        form([], "Accept invite", async () => {
          const r = await api("POST", "/api/invites/accept", { token });
          if (!r.ok) return r.data.error || "Something went wrong.";
          setPendingInvite(null);
          go(`/team/${r.data.organisationId}`);
        }),
        el("button", { class: "link", type: "button", text: "Not now", onclick: () => { setPendingInvite(null); go("/"); } }));
    }
    setPendingInvite(token);
    return show(el("h1", { text: "Join the team" }), intro,
      el("p", { text: `Sign in as ${inv.email} to accept.` }),
      inv.signedInAs
        ? signOutLink(`Sign out of ${inv.signedInAs}, then sign in`)
        : el("button", { class: "button", type: "button", text: "Sign in", onclick: showLogin }));
  }

  if (inv.signedInAs) {
    setPendingInvite(token);
    return show(el("h1", { text: "Join the team" }), intro,
      el("p", { text: `This invite is for ${inv.email}, but you are signed in as ${inv.signedInAs}.` }),
      signOutLink("Sign out to continue"));
  }

  const name = field("Your name", { type: "text", autocomplete: "name", maxlength: "80", required: "" });
  const password = field("Choose a password (12+ characters)", { type: "password", autocomplete: "new-password", required: "" });
  const again = field("Password again", { type: "password", autocomplete: "new-password", required: "" });
  show(
    el("h1", { text: "Create your account" }), intro,
    el("p", { class: "hint", text: `Your sign-in email will be ${inv.email}.` }),
    form([name, password, again], "Create account", async () => {
      if (password.input.value !== again.input.value) return "The two passwords don't match.";
      const r = await api("POST", "/api/invites/accept", { token, name: name.input.value, password: password.input.value });
      if (!r.ok) return r.data.error || "Something went wrong.";
      setPendingInvite(null);
      route(r.data.state);
    })
  );
}

function showRegenerate() {
  const code = field("6-digit code from your authenticator app", codeAttrs);
  showPage(
    el("h1", { text: "Make new backup codes" }),
    el("p", { text: "Your old backup codes will stop working." }),
    form([code], "Make new codes", async () => {
      const res = await api("POST", "/api/auth/backup-codes/regenerate", { code: code.input.value });
      if (!res.ok) return res.data.error || "Something went wrong.";
      showBackupCodes(res.data.backupCodes, false);
    }),
    el("a", { class: "link", href: "#/security", text: "Back" })
  );
}

function showMessage(text) {
  show(el("h1", { text: "Please wait" }), el("p", { text: text || "Something went wrong." }), signOutLink("Back to sign in"));
}

function signOutLink(text, className = "link") {
  return el("button", {
    class: className, type: "button", text,
    onclick: async () => {
      await api("POST", "/api/auth/logout");
      me = null;
      const pending = getPendingInvite();
      pending ? showInvite(pending) : showLogin();
    },
  });
}

// ---------- Which screen? The server decides, based on the session ----------
function route(state) {
  if (state === "signed_in") {
    const pending = getPendingInvite();
    return pending ? showInvite(pending) : renderPage();
  }
  if (state === "needs_two_step") return showTwoStep();
  if (state === "needs_setup") return showSetup();
  return showLogin();
}

// Signed-in pages have their own address (#/...), so refresh and Back keep your place.
// Signing in from a saved address lands on that page.
const PAGES = [
  [/^(#\/?)?$/, () => showHome()],
  [/^#\/security$/, () => showSecurity()],
  [/^#\/new-org$/, () => showCreateOrg()],
  [/^#\/new-site$/, () => showCreateSite()],
  [/^#\/site\/([0-9a-f-]{36})$/, (id) => showSite(id)],
  [/^#\/team\/([0-9a-f-]{36})$/, (id) => showTeam(id)],
];

async function renderPage() {
  const res = await api("GET", "/api/me");
  if (res.data.state !== "signed_in") return route(res.data.state);
  me = res.data;
  for (const [pattern, page] of PAGES) {
    const match = location.hash.match(pattern);
    if (match) return page(match[1]);
  }
  go("/");
}

function go(path) {
  const hash = `#${path}`;
  if (location.hash === hash) renderPage().catch(() => showMessage("Could not reach the server."));
  else location.hash = hash; // the hashchange listener renders it
}

// An invite link puts its secret after "#". Take it out of the address bar straight away.
function handleAddress() {
  const invite = location.hash.match(/^#invite=([A-Za-z0-9_-]{20,100})$/);
  if (invite) {
    history.replaceState(null, "", location.pathname);
    setPendingInvite(invite[1]);
    return showInvite(invite[1]);
  }
  return renderPage();
}

window.addEventListener("hashchange", () => handleAddress().catch(() => showMessage("Could not reach the server.")));
handleAddress().catch(() => showMessage("Could not reach the server."));
