// Checks the sources and that the generated files match them. Fails with a list of every problem.
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { ROOT, outputs, parseSource } from "./build.mjs";
import { MOMENTS } from "../plugins/agent-kit/hooks/principles-hook.mjs";

const problems = [];
const words = (s) => s.split(/\s+/).filter(Boolean).length;

for (const f of readdirSync(join(ROOT, "principles")).filter((f) => f.endsWith(".md") && f !== "README.md")) {
  try {
    const { meta, body } = parseSource(readFileSync(join(ROOT, "principles", f), "utf8"), f);
    for (const k of ["id", "name", "applyWhen", "source"]) if (!meta[k]) problems.push(`principles/${f}: missing "${k}"`);
    if (meta.id && `${meta.id}.md` !== f) problems.push(`principles/${f}: id "${meta.id}" does not match the file name`);
    if (meta.id && !/^[a-z0-9]+(-[a-z0-9]+)*$/.test(meta.id)) problems.push(`principles/${f}: id must be lowercase words joined by hyphens`);
    if (words(body) > 200) problems.push(`principles/${f}: ${words(body)} words; the limit is 200`);
  } catch (e) { problems.push(String(e.message)); }
}

// Every skill, generated or own, follows the shared agentskills.io core: name (= folder, ≤64, lowercase-hyphen) and description (≤1024).
const skillsDir = join(ROOT, "plugins/agent-kit/skills");
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

for (const [rel, text] of outputs()) {
  const f = join(ROOT, rel);
  if (!existsSync(f) || readFileSync(f, "utf8") !== text) problems.push(`${rel}: out of date; run npm run build`);
}
const core = readFileSync(join(ROOT, "instructions/core.md"), "utf8");
if (Buffer.byteLength(core) > 8 * 1024) problems.push(`instructions/core.md: ${Buffer.byteLength(core)} bytes; keep it under 8 KiB (Codex shares a 32 KiB budget with each project's AGENTS.md)`);

if (problems.length) { console.error(problems.map((p) => `✗ ${p}`).join("\n")); process.exit(1); }
console.log("✓ all checks pass");
