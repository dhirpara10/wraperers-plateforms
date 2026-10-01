// Small helpers shared by the API routes.

// The request body as an object, or {} if it isn't valid JSON.
export async function readJson(c) {
  const body = await c.req.json().catch(() => null);
  return body && typeof body === "object" ? body : {};
}

// Names (people, teams, sites): trimmed, no control characters, 1-80 characters.
export function cleanName(value) {
  const name = String(value ?? "").replace(/[\u0000-\u001f\u007f]/g, "").trim();
  return name.length >= 1 && name.length <= 80 ? name : null;
}
