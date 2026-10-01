-- Foundation schema: accounts, login, organisations, stores, audit.
-- Never edit this file after it has been applied; add a new migration instead.
-- All ids are random UUIDs. All times are UTC text ('YYYY-MM-DD HH:MM:SS').
--
-- Rule for future migrations: a table is either listed in GLOBAL_TABLES
-- (src/tenancy.js) or it is store-owned and MUST have
--   store_id TEXT NOT NULL REFERENCES stores(id) ON DELETE CASCADE

-- ---------- People ----------
CREATE TABLE users (
  id                TEXT PRIMARY KEY,
  email             TEXT NOT NULL UNIQUE,          -- stored lowercase
  name              TEXT NOT NULL DEFAULT '',
  password_hash     TEXT NOT NULL,                 -- "algo$iterations$salt$hash", never the password
  email_verified_at TEXT,
  status            TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
  failed_logins     INTEGER NOT NULL DEFAULT 0,
  locked_until      TEXT,
  created_at        TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at        TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Login sessions. Only a hash of the cookie value is stored.
CREATE TABLE sessions (
  id              TEXT PRIMARY KEY,
  user_id         TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash      TEXT NOT NULL UNIQUE,
  two_step_passed INTEGER NOT NULL DEFAULT 0,
  ip_hash         TEXT,
  user_agent      TEXT,
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  last_seen_at    TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at      TEXT NOT NULL
);
CREATE INDEX sessions_user ON sessions(user_id);

-- One-time links/codes sent by email. Only hashes are stored.
CREATE TABLE email_tokens (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  purpose    TEXT NOT NULL CHECK (purpose IN ('verify_email', 'reset_password', 'login_code')),
  token_hash TEXT NOT NULL UNIQUE,
  attempts   INTEGER NOT NULL DEFAULT 0,
  expires_at TEXT NOT NULL,
  used_at    TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX email_tokens_user ON email_tokens(user_id, purpose);

-- Two-step login methods. secret is the encrypted authenticator secret (NULL for email codes).
CREATE TABLE two_step_methods (
  id           TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type         TEXT NOT NULL CHECK (type IN ('totp', 'email')),
  secret       TEXT,
  confirmed_at TEXT,
  last_used_step INTEGER,                          -- stops the same authenticator code being used twice
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (user_id, type)
);

CREATE TABLE backup_codes (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  code_hash  TEXT NOT NULL,
  used_at    TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX backup_codes_user ON backup_codes(user_id);

-- ---------- Organisations and teams ----------
CREATE TABLE organisations (
  id         TEXT PRIMARY KEY,
  type       TEXT NOT NULL CHECK (type IN ('platform', 'agency', 'brand')),
  name       TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
-- There can only ever be one platform organisation (Wraperers).
CREATE UNIQUE INDEX organisations_one_platform ON organisations(type) WHERE type = 'platform';

-- Which role fits which organisation type is checked in code (src/roles.js).
CREATE TABLE memberships (
  id              TEXT PRIMARY KEY,
  organisation_id TEXT NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  user_id         TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role            TEXT NOT NULL CHECK (role IN ('owner', 'staff', 'admin', 'member', 'editor', 'viewer')),
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (organisation_id, user_id)
);
CREATE INDEX memberships_user ON memberships(user_id);

CREATE TABLE invites (
  id              TEXT PRIMARY KEY,
  organisation_id TEXT NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  email           TEXT NOT NULL,
  role            TEXT NOT NULL CHECK (role IN ('owner', 'staff', 'admin', 'member', 'editor', 'viewer')),
  token_hash      TEXT NOT NULL UNIQUE,
  invited_by      TEXT REFERENCES users(id) ON DELETE SET NULL,
  expires_at      TEXT NOT NULL,
  accepted_at     TEXT,
  created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX invites_org ON invites(organisation_id);
CREATE INDEX invites_email ON invites(email);

-- ---------- Stores ----------
-- A store belongs to exactly one organisation. No ON DELETE CASCADE here on purpose:
-- an organisation with stores can't be deleted by accident.
CREATE TABLE stores (
  id              TEXT PRIMARY KEY,
  organisation_id TEXT NOT NULL REFERENCES organisations(id),
  subdomain       TEXT NOT NULL UNIQUE,            -- <subdomain>.wraperers.com, checked by cleanSubdomain()
  name            TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'live', 'suspended')),
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX stores_org ON stores(organisation_id);

-- ---------- Abuse protection ----------
CREATE TABLE rate_limits (
  key          TEXT PRIMARY KEY,                   -- e.g. "login:<ip hash>" or "login:<email hash>"
  count        INTEGER NOT NULL DEFAULT 0,
  window_start TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ---------- Audit log ----------
-- No foreign keys: the log must survive even if the user or store is deleted.
CREATE TABLE audit_log (
  id              TEXT PRIMARY KEY,
  user_id         TEXT,
  user_email      TEXT NOT NULL,
  organisation_id TEXT,
  store_id        TEXT,
  action          TEXT NOT NULL,
  target          TEXT,
  platform_access INTEGER NOT NULL DEFAULT 0,      -- 1 = done by Wraperers staff on someone else's store
  created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX audit_store ON audit_log(store_id, created_at);
CREATE INDEX audit_user ON audit_log(user_id, created_at);
