// Checks the sources and that the generated files match them. Fails with a list of every problem.
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { ROOT, outputs, parseSource } from "./build.mjs";
import { MOMENTS } from "../plugins/sage/hooks/principles-hook.mjs";
import { BRIEF_FIELDS, REPORT_FIELDS } from "../plugins/sage/hooks/sage-hook.mjs";
import { fingerprint, overrides } from "./sync-pstack.mjs";
import { files as graphics } from "./graphics.mjs";

const problems = [];
const words = (s) => s.split(/\s+/).filter(Boolean).length;

for (const f of readdirSync(join(ROOT, "principles")).filter((f) => f.endsWith(".md") && f !== "README.md")) {
  try {
    const { meta, body } = parseSource(readFileSync(join(ROOT, "principles", f), "utf8"), f);
    for (const k of ["id", "name", "applyWhen", "source"]) if (!meta[k]) problems.push(`principles/${f}: missing "${k}"`);
    if (meta.id && `${meta.id}.md` !== f) problems.push(`principles/${f}: id "${meta.id}" does not match the file name`);
    if (meta.id && !/^[a-z0-9]+(-[a-z0-9]+)*$/.test(meta.id)) problems.push(`principles/${f}: id must be lowercase words joined by hyphens`);
    if (words(body) > 200) problems.push(`principles/${f}: ${words(body)} words; the limit is 200`);
    if (/^pstack /.test(meta.source ?? "") && !/^[0-9a-f]{16}$/.test(meta.upstream ?? "")) problems.push(`principles/${f}: overrides pstack, so it needs upstream: <the fingerprint of the pstack text it was reviewed against>`);
  } catch (e) { problems.push(String(e.message)); }
}

// Every skill, generated or own, follows the shared agentskills.io core: name (= folder, ≤64, lowercase-hyphen) and description (≤1024).
const skillsDir = join(ROOT, "plugins/sage/skills");
for (const d of readdirSync(skillsDir)) {
  const f = join(skillsDir, d, "SKILL.md");
  if (!existsSync(f)) { problems.push(`skills/${d}: no SKILL.md`); continue; }
  const m = /^---\n([\s\S]*?)\n---\n/.exec(readFileSync(f, "utf8"));
  if (!m) { problems.push(`skills/${d}/SKILL.md: no frontmatter`); continue; }
  const name = /^name:\s*(.+)$/m.exec(m[1])?.[1]?.trim();
  const desc = /^description:\s*(.+)$/m.exec(m[1])?.[1]?.trim();
  if (name !== d) problems.push(`skills/${d}/SKILL.md: name "${name}" must equal the folder name`);
  if (!name || name.length > 64 || !/^[a-z0-9]+(-[a-z0-9]+)*$/.test(name)) problems.push(`skills/${d}/SKILL.md: name must be lowercase words joined by hyphens, at most 64 characters`);
  if (!desc) problems.push(`skills/${d}/SKILL.md: missing description`);
  else if (JSON.parse(desc.startsWith('"') ? desc : JSON.stringify(desc)).length > 1024) problems.push(`skills/${d}/SKILL.md: description over 1024 characters`);
  // Codex's validator accepts only these top-level keys.
  for (const key of m[1].split("\n").filter((l) => /^[A-Za-z-]+:/.test(l)).map((l) => l.split(":")[0])) {
    if (!["name", "description", "license", "allowed-tools", "metadata"].includes(key)) problems.push(`skills/${d}/SKILL.md: key "${key}" is not in the shared skill format`);
  }
}

// Every principle that the hook gives must have its skill, because the hook reads the text from it.
for (const [moment, { principles }] of Object.entries(MOMENTS)) {
  for (const p of principles) if (!existsSync(join(skillsDir, `principle-${p}`, "SKILL.md"))) problems.push(`hooks: moment "${moment}" names "${p}", which has no skill`);
}

// Sage mode (Claude Code only). Agents: name equals the file, a description, preloaded skills that exist, sage names that exist.
const PLUGIN = join(ROOT, "plugins/sage");
const frontmatter = (file) => /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(readFileSync(file, "utf8"));
const agents = readdirSync(join(PLUGIN, "agents")).filter((f) => f.endsWith(".md"));
for (const f of agents) {
  const m = frontmatter(join(PLUGIN, "agents", f));
  if (!m) { problems.push(`agents/${f}: no frontmatter`); continue; }
  if (/^name:\s*(.+)$/m.exec(m[1])?.[1].trim() !== f.slice(0, -3)) problems.push(`agents/${f}: name must equal the file name`);
  if (!/^description:\s*\S/m.test(m[1])) problems.push(`agents/${f}: missing description`);
  for (const [, skill] of m[1].matchAll(/^\s+-\s+(\S+)\s*$/gm)) {
    const [ns, name] = skill.split(":");
    if (ns !== "sage" || !existsSync(join(skillsDir, name ?? "", "SKILL.md"))) problems.push(`agents/${f}: preloads ${skill}, which is not a sage skill`);
  }
  for (const [, name] of m[2].matchAll(/`sage:([a-z-]+)`/g)) {
    if (!agents.includes(`${name}.md`) && !existsSync(join(skillsDir, name, "SKILL.md"))) problems.push(`agents/${f}: names sage:${name}, which is neither an agent nor a skill`);
  }
  if (f !== "chief-of-staff.md" && !m[1].includes("  - sage:report")) problems.push(`agents/${f}: must preload sage:report`);
}
// The chief's brief template and the report skill list the same fields as the hook's gates, in the same order.
const template = /## The brief[\s\S]*?```\n([\s\S]*?)```/.exec(frontmatter(join(PLUGIN, "agents/chief-of-staff.md"))?.[2] ?? "")?.[1] ?? "";
const briefFields = template.split("\n").map((l) => l.split(/\s+/)[0]).filter(Boolean);
if (briefFields.join(" ") !== BRIEF_FIELDS.join(" ")) problems.push(`agents/chief-of-staff.md: the brief template has ${briefFields.join(" ")}, the hook checks ${BRIEF_FIELDS.join(" ")}`);
const report = /```\n([\s\S]*?)```/.exec(readFileSync(join(skillsDir, "report/SKILL.md"), "utf8"))?.[1] ?? "";
const reportFields = report.split("\n").map((l) => l.split(/\s{2,}/)[0].trim()).filter(Boolean);
if (reportFields.join("|") !== REPORT_FIELDS.join("|")) problems.push(`skills/report: the template has ${reportFields.join(", ")}, the hook checks ${REPORT_FIELDS.join(", ")}`);
// Every hook command runs a script that exists, in the shared hooks and in Claude's own.
for (const cfg of ["hooks.json", "claude.json"]) {
  for (const [event, groups] of Object.entries(JSON.parse(readFileSync(join(PLUGIN, "hooks", cfg), "utf8")).hooks)) for (const g of groups) for (const h of g.hooks) {
    const script = /\$\{CLAUDE_PLUGIN_ROOT\}\/([^"]+)"/.exec(h.command)?.[1];
    if (!script || !existsSync(join(PLUGIN, script))) problems.push(`hooks/${cfg} ${event}: runs ${script ?? h.command}, which does not exist`);
  }
}
if (JSON.parse(readFileSync(join(PLUGIN, ".claude-plugin/plugin.json"), "utf8")).hooks !== "./hooks/claude.json") problems.push("plugin.json: Claude Code must load hooks/claude.json, the sage mode hook");

// pstack: its licence ships with the vendored files, every link between skills resolves, and an override whose
// upstream text changed since its review is reported (the weekly sync's pull request waits for a person then).
if (!existsSync(join(ROOT, "upstream/pstack/LICENSE"))) problems.push("upstream/pstack/LICENSE: missing; pstack's MIT licence must ship with its text");
for (const d of readdirSync(skillsDir)) {
  const f = join(skillsDir, d, "SKILL.md");
  if (!existsSync(f)) continue;
  for (const [, target] of readFileSync(f, "utf8").matchAll(/\]\(\.\.\/([a-z0-9-]+)\/SKILL\.md\)/g)) if (!existsSync(join(skillsDir, target, "SKILL.md"))) problems.push(`skills/${d}: links to ${target}, which does not ship`);
}
for (const o of overrides(ROOT)) {
  const now = existsSync(join(ROOT, "upstream/pstack", o.upstream)) ? fingerprint(readFileSync(join(ROOT, "upstream/pstack", o.upstream))) : undefined;
  if (now && now !== o.reviewed) console.warn(`! ${o.file}: pstack changed ${o.upstream} since this override's review (now ${now})`);
}

// The README's graphics are exactly what scripts/graphics.mjs draws, so nobody edits or adds an SVG by hand. Each text
// stays 7 px or more on a phone, where GitHub shows a graphic 358 px wide (a 390 px screen less the page margins).
const drawn = new Map(graphics());
for (const [f, svg] of drawn) {
  const file = join(ROOT, "docs/assets", f);
  if (!existsSync(file) || readFileSync(file, "utf8") !== svg) problems.push(`docs/assets/${f}: out of date; run npm run graphics`);
  const width = +/viewBox="0 0 ([\d.]+)/.exec(svg)[1];
  const small = Math.min(...[...svg.matchAll(/font-size="([\d.]+)"/g)].map((m) => +m[1]));
  if ((small * 358) / width < 7) problems.push(`docs/assets/${f}: a ${small} px text is ${((small * 358) / width).toFixed(1)} px on a phone; make it ${Math.ceil((7 * width) / 358)} px or more`);
}
for (const f of readdirSync(join(ROOT, "docs/assets")).filter((f) => f.endsWith(".svg") && !drawn.has(f))) problems.push(`docs/assets/${f}: scripts/graphics.mjs does not draw it; draw it there, or delete it`);

for (const [rel, text] of outputs()) {
  const f = join(ROOT, rel);
  if (!existsSync(f) || readFileSync(f, "utf8") !== text) problems.push(`${rel}: out of date; run npm run build`);
}
const core = readFileSync(join(ROOT, "instructions/core.md"), "utf8");
if (Buffer.byteLength(core) > 8 * 1024) problems.push(`instructions/core.md: ${Buffer.byteLength(core)} bytes; keep it under 8 KiB (Codex shares a 32 KiB budget with each project's AGENTS.md)`);

if (problems.length) { console.error(problems.map((p) => `✗ ${p}`).join("\n")); process.exit(1); }
console.log("✓ all checks pass");
