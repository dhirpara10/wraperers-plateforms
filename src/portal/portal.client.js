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
  view.replaceChildren(...nodes);
  view.querySelector("input")?.focus();
}

function field(label, attrs) {
  const input = el("input", attrs);
  return { input, row: el("label", { class: "field" }, [el("span", { text: label }), input]) };
}

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
  const { user, organisations, backupCodesLeft } = res.data;

  const teams = organisations.length
    ? el("ul", { class: "list" }, organisations.map((org) => el("li", {}, [
        el("strong", { text: org.name }),
        el("span", { class: "tag", text: `${org.type} · ${org.role}` }),
      ])))
    : el("p", { class: "hint", text: "You are not part of a team yet." });

  show(
    el("h1", { text: `Hello${user.name ? ", " + user.name : ""}` }),
    el("p", { class: "hint", text: `Signed in as ${user.email}` }),
    el("h2", { text: "Your sites" }),
    el("p", { class: "hint", text: "No sites yet. Creating sites comes in the next milestone." }),
    el("h2", { text: "Your team" }),
    teams,
    el("h2", { text: "Security" }),
    el("p", { class: backupCodesLeft <= 2 ? "status bad" : "hint", text: `Backup codes left: ${backupCodesLeft}` }),
    el("button", { class: "link", type: "button", text: "Make new backup codes", onclick: showRegenerate }),
    signOutLink("Sign out")
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
      showLogin();
    },
  });
}

// ---------- Which screen? The server decides, based on the session ----------
function route(state) {
  if (state === "signed_in") return showHome();
  if (state === "needs_two_step") return showTwoStep();
  if (state === "needs_setup") return showSetup();
  return showLogin();
}

api("GET", "/api/me")
  .then((res) => route(res.data.state))
  .catch(() => showMessage("Could not reach the server."));
