const TEAM = new Set(["implementer", "code-reviewer", "security-reviewer", "ux-reviewer", "qa"]);
const ROLES = new Set(["chief-of-staff", "lead", "pe", "designer", "arena-judge", ...TEAM]);

/** Role identity comes from the trusted adapter, not an agent's name or message. */
export function parseRolePlan(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || Object.keys(value).length !== 2 || !Object.hasOwn(value, "issuerRole") || !Object.hasOwn(value, "role")
    || !ROLES.has(value.issuerRole) || !ROLES.has(value.role)) throw Error("Invalid role plan");
  return { issuerRole: value.issuerRole, role: value.role };
}

/** Evaluate inside the same transaction that consumes project and total capacity. */
export function checkRoleReservation(reservations, assignment, input) {
  const plan = parseRolePlan(input);
  if (plan.role === "chief-of-staff") throw Error("The chief is the owner session, not a child role");
  if (plan.issuerRole !== "chief-of-staff" && plan.issuerRole !== "lead") {
    throw Error("A specialist cannot start an agent; report to the chief");
  }
  if (plan.issuerRole === "lead" && !TEAM.has(plan.role)) throw Error("A lead can start only its permitted team");
  const project = reservations.filter(row => row.assignment.project === assignment.project);
  if (plan.role === "lead" && project.filter(row => !row.rolePlan || row.rolePlan.role === "lead").length >= 3) {
    throw Error("The project already holds three lead slots");
  }
  if (plan.issuerRole === "lead" && project.filter(row => row.assignment.session === assignment.session
    && row.assignment.epoch === assignment.epoch && row.assignment.issuer === assignment.issuer).length >= 3) {
    throw Error("The lead already holds three child slots");
  }
  return plan;
}
