// Structured task instructions. Role and tool authority come from separate policy.
export const BRIEF_FIELDS = Object.freeze(["GOAL", "SCOPE", "CONTEXT", "DECISIONS", "ACCEPTANCE", "VERIFY", "BUDGET", "FORBIDDEN", "REPORT", "STANDING"]);
const LIMIT = 32 * 1024;

export function parseBrief(input) {
  if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).length !== BRIEF_FIELDS.length
    || BRIEF_FIELDS.some(field => !Object.hasOwn(input, field))) throw Error("A brief needs every required text field");
  const brief = Object.fromEntries(BRIEF_FIELDS.map(field => [field, input[field]]));
  for (const value of Object.values(brief)) {
    if (typeof value !== "string" || value.trim().length === 0 || value.includes("\0")) throw Error("A brief needs every required text field");
    if (value.length > LIMIT) throw Error("The encoded brief exceeds 32 KiB");
    if (Buffer.from(value, "utf8").toString("utf8") !== value) throw Error("A brief needs valid Unicode text");
  }
  if (Buffer.byteLength(JSON.stringify(brief), "utf8") > LIMIT) throw Error("The encoded brief exceeds 32 KiB");
  return brief;
}

export function renderBrief(input) {
  const brief = parseBrief(input);
  return BRIEF_FIELDS.map(field => `${field}\n${brief[field]}`).join("\n\n");
}
