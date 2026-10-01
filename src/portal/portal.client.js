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

function show(...nodes) {
  view.replaceChildren(...nodes.filter(Boolean));
  view.querySelector("input")?.focus();
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
  show(
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
  const res = await api("GET", "/api/me");
  if (res.data.state !== "signed_in") return route(res.data.state);
  const { user, backupCodesLeft } = res.data;
  const orgs = await api("GET", "/api/orgs");
  const { organisations = [], canCreate = false } = orgs.data;

  const teams = organisations.length
    ? el("ul", { class: "list" }, organisations.map((org) => el("li", {}, [
        el("button", { class: "link inline", type: "button", text: org.name, onclick: () => showTeam(org.id) }),
        el("span", { class: "tag", text: `${TYPE_LABELS[org.type]}${org.role ? " · " + ROLE_LABELS[org.role] : ""}` }),
      ])))
    : el("p", { class: "hint", text: "You are not part of a team yet." });

  show(
    el("h1", { text: `Hello${user.name ? ", " + user.name : ""}` }),
    el("p", { class: "hint", text: `Signed in as ${user.email}` }),
    el("h2", { text: "Your sites" }),
    el("p", { class: "hint", text: "No sites yet. Creating sites comes in the next milestone." }),
    el("h2", { text: canCreate ? "Teams" : "Your team" }),
    teams,
    canCreate ? el("button", { class: "link", type: "button", text: "+ New agency or brand", onclick: showCreateOrg }) : null,
    el("h2", { text: "Security" }),
    el("p", { class: backupCodesLeft <= 2 ? "status bad" : "hint", text: `Backup codes left: ${backupCodesLeft}` }),
    el("button", { class: "link", type: "button", text: "Make new backup codes", onclick: showRegenerate }),
    signOutLink("Sign out")
  );
}

function showCreateOrg() {
  const type = selectField("Type", [["brand", "Brand"], ["agency", "Agency"]]);
  const name = field("Name", { type: "text", maxlength: "80", required: "" });
  show(
    el("h1", { text: "New agency or brand" }),
    el("p", { class: "hint", text: "After creating it, invite its owner from the team page." }),
    form([type, name], "Create", async () => {
      const res = await api("POST", "/api/orgs", { type: type.input.value, name: name.input.value });
      if (!res.ok) return res.data.error || "Something went wrong.";
      showTeam(res.data.organisation.id);
    }),
    el("button", { class: "link", type: "button", text: "Back", onclick: showHome })
  );
}

async function showTeam(orgId) {
  const res = await api("GET", `/api/orgs/${encodeURIComponent(orgId)}/team`);
  if (res.status === 401) return showLogin();
  if (!res.ok) return showMessage(res.data.error);
  const team = res.data;
  const roles = team.assignableRoles;
  const canManage = roles.length > 0;

  // Runs a change, then reloads the team (or shows what went wrong).
  const act = async (method, path, body, leftTeam = false) => {
    const r = await api(method, path, body);
    if (!r.ok) alert(r.data.error || "Something went wrong.");
    if (r.ok && leftTeam) return showHome();
    showTeam(orgId);
  };
  const base = `/api/orgs/${encodeURIComponent(orgId)}`;

  const members = el("ul", { class: "list" }, team.members.map((m) => {
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

  show(
    el("h1", { text: team.organisation.name }),
    el("p", { class: "hint", text: `${TYPE_LABELS[team.organisation.type]}${team.yourRole ? " · you are " + ROLE_LABELS[team.yourRole] : ""}` }),
    team.platformAccess ? el("p", { class: "status", text: "You are viewing this team as Wraperers support. This is recorded in the audit log." }) : null,
    el("h2", { text: "Members" }),
    members,
    pending ? el("h2", { text: "Waiting to join" }) : null,
    pending,
    inviteForm ? el("h2", { text: "Invite someone" }) : null,
    inviteForm,
    el("button", { class: "link", type: "button", text: "Back", onclick: showHome })
  );
}

function showInviteLink(orgId, data) {
  show(
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
      el("button", { class: "link", type: "button", text: "Go to the portal", onclick: start }));
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
          showTeam(r.data.organisationId);
        }),
        el("button", { class: "link", type: "button", text: "Not now", onclick: () => { setPendingInvite(null); showHome(); } }));
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
  show(
    el("h1", { text: "Make new backup codes" }),
    el("p", { text: "Your old backup codes will stop working." }),
    form([code], "Make new codes", async () => {
      const res = await api("POST", "/api/auth/backup-codes/regenerate", { code: code.input.value });
      if (!res.ok) return res.data.error || "Something went wrong.";
      showBackupCodes(res.data.backupCodes, false);
    }),
    el("button", { class: "link", type: "button", text: "Back", onclick: showHome })
  );
}

function showMessage(text) {
  show(el("h1", { text: "Please wait" }), el("p", { text: text || "Something went wrong." }), signOutLink("Back to sign in"));
}

function signOutLink(text) {
  return el("button", {
    class: "link", type: "button", text,
    onclick: async () => {
      await api("POST", "/api/auth/logout");
      const pending = getPendingInvite();
      pending ? showInvite(pending) : showLogin();
    },
  });
}

// ---------- Which screen? The server decides, based on the session ----------
function route(state) {
  if (state === "signed_in") {
    const pending = getPendingInvite();
    return pending ? showInvite(pending) : showHome();
  }
  if (state === "needs_two_step") return showTwoStep();
  if (state === "needs_setup") return showSetup();
  return showLogin();
}

function start() {
  api("GET", "/api/me")
    .then((res) => route(res.data.state))
    .catch(() => showMessage("Could not reach the server."));
}

// An invite link puts its secret after "#". Take it out of the address bar straight away.
const inviteMatch = location.hash.match(/^#invite=([A-Za-z0-9_-]{20,100})$/);
if (inviteMatch) {
  history.replaceState(null, "", location.pathname);
  setPendingInvite(inviteMatch[1]);
  showInvite(inviteMatch[1]).catch(() => showMessage("Could not reach the server."));
} else {
  start();
}
