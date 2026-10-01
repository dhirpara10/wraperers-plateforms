// Organisation types and the roles each one allows.
// The database only checks that a role is one of the known words;
// this map is what makes sure a role fits its organisation type.
export const ORG_ROLES = {
  platform: ["owner", "staff"],
  agency: ["owner", "admin", "member"],
  brand: ["owner", "editor", "viewer"],
};

export function isValidRole(orgType, role) {
  return (ORG_ROLES[orgType] ?? []).includes(role);
}

// Roles trusted with Code mode and Custom code (raw HTML).
export function canUseCode(orgType, role) {
  return role === "owner" || (orgType === "agency" && role === "admin");
}
