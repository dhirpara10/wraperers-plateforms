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

// Plain-language names shown in the portal.
export const ROLE_LABELS = {
  owner: "Owner", staff: "Staff", admin: "Admin", member: "Member", editor: "Editor", viewer: "Viewer",
};

// Which roles someone may hand out (invite as, change to, or remove) in a team.
// access comes from getOrgAccess (src/tenancy.js).
//   - an owner manages every role in their own organisation
//   - an agency admin manages admins and members, never owners
//   - a Wraperers platform owner can manage any team, for support (audit-logged)
//   - everyone else (members, editors, viewers, platform staff) manages nothing
export function assignableRoles(access) {
  if (!access) return [];
  const all = ORG_ROLES[access.org.type] ?? [];
  if (access.platformAccess) return access.role === "owner" ? all : [];
  if (access.role === "owner") return all;
  if (access.org.type === "agency" && access.role === "admin") return ["admin", "member"];
  return [];
}

// Only the Wraperers platform owner creates new agency and brand organisations for now.
// (Agencies creating brands for their clients comes with milestone 4.)
export const CREATABLE_ORG_TYPES = ["agency", "brand"];

// Who can create a site (store) in an organisation. access comes from getOrgAccess.
//   - Wraperers owner and staff, in any organisation (building for clients; audit-logged)
//   - owners of agencies and brands, and agency admins
export function canCreateStore(access) {
  if (!access) return false;
  if (access.platformAccess || access.org.type === "platform") return true;
  if (access.role === "owner") return true;
  return access.org.type === "agency" && access.role === "admin";
}

// Most sites an organisation can have. A brand has its own one site.
export const MAX_STORES = { platform: 100, agency: 100, brand: 1 };
