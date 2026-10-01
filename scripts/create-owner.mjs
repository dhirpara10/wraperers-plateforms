#!/usr/bin/env node
// One-time setup: creates the Wraperers platform organisation and its first owner.
//
//   npm run create-owner -- --local     (your local dev database)
//   npm run create-owner -- --remote    (the real database in Cloudflare)
//
// The password is typed here, hashed on this computer, and only the hash is sent
// to the database. It is never printed, saved to a file, or put in shell history.
// The script refuses to run if a platform owner already exists.
// Two-step login is set up in the browser the first time the owner signs in.

import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { hashPassword, passwordProblem } from "../src/auth/password.js";

const target = process.argv.includes("--remote") ? "--remote" : process.argv.includes("--local") ? "--local" : null;
if (!target) {
  console.error("Say which database: --local or --remote");
  process.exit(1);
}

function wrangler(args) {
  return execFileSync("npx", ["wrangler", "d1", "execute", "DB", target, "--json", ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function query(sql) {
  return JSON.parse(wrangler(["--command", sql]))[0].results;
}

const sqlText = (value) => `'${String(value).replace(/'/g, "''")}'`;

// Asks a question; with hidden = true the typed characters are not shown.
function ask(question, hidden = false) {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    if (hidden) {
      rl._writeToOutput = (text) => {
        if (text.includes(question)) rl.output.write(question);
      };
    }
    rl.question(question, (answer) => {
      rl.close();
      if (hidden) process.stdout.write("\n");
      resolve(answer);
    });
  });
}

// When input is piped in (automated local tests only), read lines instead of prompting.
async function pipedAnswers() {
  let text = "";
  for await (const chunk of process.stdin) text += chunk;
  return text.split("\n");
}

async function main() {
  const existing = query(
    "SELECT count(*) AS n FROM memberships m JOIN organisations o ON o.id = m.organisation_id WHERE o.type = 'platform' AND m.role = 'owner'"
  )[0].n;
  if (existing > 0) {
    console.error("A platform owner already exists. This script only creates the first one.");
    process.exit(1);
  }

  let email, name, password, again;
  if (process.stdin.isTTY) {
    console.log(`Creating the first platform owner in the ${target === "--remote" ? "REAL (remote)" : "local"} database.\n`);
    email = await ask("Email: ");
    name = await ask("Your name: ");
    password = await ask("Password (hidden, 12+ characters): ", true);
    again = await ask("Password again: ", true);
  } else {
    if (target === "--remote") {
      console.error("For the real database, run this in a terminal and type the password yourself.");
      process.exit(1);
    }
    [email, name, password] = await pipedAnswers();
    again = password;
  }

  email = String(email ?? "").trim().toLowerCase();
  name = String(name ?? "").trim().slice(0, 80);
  if (email.length > 254 || !/^[^\s@']+@[^\s@']+\.[^\s@']+$/.test(email)) {
    console.error("That doesn't look like an email address.");
    process.exit(1);
  }
  const problem = passwordProblem(password, email);
  if (problem) {
    console.error(problem);
    process.exit(1);
  }
  if (password !== again) {
    console.error("The two passwords don't match.");
    process.exit(1);
  }
  if (query(`SELECT count(*) AS n FROM users WHERE email = ${sqlText(email)}`)[0].n > 0) {
    console.error("A user with that email already exists.");
    process.exit(1);
  }

  const userId = crypto.randomUUID();
  const hash = await hashPassword(password);
  const sql = [
    `INSERT INTO organisations (id, type, name)
       SELECT ${sqlText(crypto.randomUUID())}, 'platform', 'Wraperers'
       WHERE NOT EXISTS (SELECT 1 FROM organisations WHERE type = 'platform');`,
    `INSERT INTO users (id, email, name, password_hash, email_verified_at)
       VALUES (${sqlText(userId)}, ${sqlText(email)}, ${sqlText(name)}, ${sqlText(hash)}, datetime('now'));`,
    `INSERT INTO memberships (id, organisation_id, user_id, role)
       SELECT ${sqlText(crypto.randomUUID())}, id, ${sqlText(userId)}, 'owner' FROM organisations WHERE type = 'platform';`,
    `INSERT INTO audit_log (id, user_id, user_email, action, target)
       VALUES (${sqlText(crypto.randomUUID())}, ${sqlText(userId)}, ${sqlText(email)}, 'setup.owner_created', 'create-owner script');`,
  ].join("\n");

  // The file holds only the hash, is readable only by you, and is deleted straight away.
  const dir = mkdtempSync(join(tmpdir(), "wraperers-owner-"));
  const file = join(dir, "owner.sql");
  try {
    writeFileSync(file, sql, { mode: 0o600 });
    wrangler(["--file", file]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }

  console.log(`\nDone. ${email} is now the platform owner.`);
  console.log("Next: sign in to the portal. You'll be asked to set up your authenticator app.");
}

main().catch((err) => {
  console.error("Failed:", err.stderr?.toString().trim() || err.message);
  process.exit(1);
});
