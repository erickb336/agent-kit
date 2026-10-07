import { readFileSync } from "node:fs";

const ROLES = new Set(["lead", "implementer", "pe", "designer", "arena-judge", "code-reviewer", "security-reviewer", "ux-reviewer", "qa"]);
const render = (name, bindings) => {
  const text = readFileSync(new URL(`./roles/${name}.md`, import.meta.url), "utf8").trim();
  const keys = [...new Set([...text.matchAll(/\{\{([A-Z_]+)\}\}/g)].map(match => match[1]))];
  if (!bindings || typeof bindings !== "object" || Array.isArray(bindings)
    || Object.keys(bindings).length !== keys.length || keys.some(key => !Object.hasOwn(bindings, key)
      || typeof bindings[key] !== "string" || !bindings[key].trim() || bindings[key].length > 16 * 1024
      || /\{\{|\}\}|\0/.test(bindings[key]))) throw Error("Role instructions require exact provider bindings");
  return text.replace(/\{\{([A-Z_]+)\}\}/g, (_, key) => bindings[key]);
};

/** Provider bindings are packaged setup instructions, never task text or model arguments. */
export function renderRoleInstructions(role, bindings = {}) {
  if (!ROLES.has(role)) throw Error("Unknown child role");
  return render(role, bindings);
}

export function renderReportInstructions(bindings) {
  return render("report", bindings);
}

/** The owner adapter supplies packaged bindings; this is not a child role. */
export function renderChiefInstructions(bindings) {
  return render("chief-of-staff", bindings);
}
