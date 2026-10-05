// Checks the sources and that the generated files match them. Fails with a list of every problem.
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { GENERATED, ROOT, outputs, parseSource } from "./build.mjs";
import { checkWords, flaggedWords, yamlText } from "./dictionary.mjs";
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
  else if (yamlText(desc).length > 1024) problems.push(`skills/${d}/SKILL.md: description over 1024 characters`);
  // The shared skill format (agentskills.io) has only these top-level keys.
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
  // Every agent writes for a person, in sage's words; every agent but the chief ends with the report.
  for (const skill of f === "chief-of-staff.md" ? ["dictionary"] : ["report", "dictionary"]) if (!new RegExp(`^  - sage:${skill}$`, "m").test(m[1])) problems.push(`agents/${f}: must preload sage:${skill}`);
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
// stays 7 px or more on a phone, where GitHub shows a graphic 324 px wide (the README column on a 390 px screen).
const drawn = new Map(graphics());
for (const [f, svg] of drawn) {
  const file = join(ROOT, "docs/assets", f);
  if (!existsSync(file) || readFileSync(file, "utf8") !== svg) problems.push(`docs/assets/${f}: out of date; run npm run graphics`);
  const width = +/viewBox="0 0 ([\d.]+)/.exec(svg)[1];
  const small = Math.min(...[...svg.matchAll(/font-size="([\d.]+)"/g)].map((m) => +m[1]));
  const PHONE = 324;
  if ((small * PHONE) / width < 7) problems.push(`docs/assets/${f}: a ${small} px text is ${((small * PHONE) / width).toFixed(1)} px on a phone; make it ${Math.ceil((7 * width) / PHONE)} px or more`);
}
for (const f of readdirSync(join(ROOT, "docs/assets")).filter((f) => f.endsWith(".svg") && !drawn.has(f))) problems.push(`docs/assets/${f}: scripts/graphics.mjs does not draw it; draw it there, or delete it`);
// The README shows each graphic in the reader's theme, with an alt text, inside a link to the SVG's file page, so that
// a tap opens it. Not to the raw SVG ("?raw=true"): GitHub's in-page navigation fails on the redirect to it and shows
// "Error loading page". The <a> line stands alone: on the same line as <picture>, GitHub makes it a paragraph and drops
// the dark version.
const readme = readFileSync(join(ROOT, "README.md"), "utf8");
for (const name of new Set([...drawn.keys()].map((f) => f.replace(/-(light|dark)\.svg$/, "")))) {
  const svg = (theme) => `docs/assets/${name}-${theme}\\.svg`;
  const shown = new RegExp(`<a href="${svg("light")}">\\n<picture>\\n\\s*<source media="\\(prefers-color-scheme: dark\\)" srcset="${svg("dark")}">\\n\\s*<img alt="[^"]+" src="${svg("light")}"[^>]*>\\n</picture>\\n</a>\\n`);
  if (!shown.test(readme)) problems.push(`README.md: show ${name} as <a href="docs/assets/${name}-light.svg">, then <picture> with its dark <source> and an <img> with alt text, each on its own line`);
}

// sage's words (writing/dictionary.md): no flagged word in the text that a person reads. The generated skills are left
// out: their words come from the principles, pstack and the dictionary itself. Code is left out too: its names stay.
let dictionary;
try { dictionary = checkWords(parseSource(readFileSync(join(ROOT, "writing/dictionary.md"), "utf8"), "writing/dictionary.md").body); } catch (e) { problems.push(e.message); }
const readByPeople = [
  ...agents.map((f) => `plugins/sage/agents/${f}`),
  ...readdirSync(skillsDir).map((d) => `plugins/sage/skills/${d}/SKILL.md`).filter((f) => existsSync(join(ROOT, f)) && !readFileSync(join(ROOT, f), "utf8").includes(GENERATED)),
  "README.md",
  "docs/design/sage-mode.html",
  ...readdirSync(join(ROOT, "docs/assets")).filter((f) => f.endsWith(".svg")).map((f) => `docs/assets/${f}`),
];
for (const f of dictionary ? readByPeople : []) {
  const found = flaggedWords(readFileSync(join(ROOT, f), "utf8"), dictionary, { html: !f.endsWith(".md") });
  // A graphic's text comes from scripts/graphics.mjs, and nobody edits an SVG by hand.
  for (const h of found) problems.push(`${f}:${h.line}: "${h.word}" is a flagged word${h.use.length ? `; say ${h.use.join(" or ")}` : ""} (writing/dictionary.md)${f.startsWith("docs/assets/") ? "; fix it in scripts/graphics.mjs, then run npm run graphics" : ""}`);
}

try {
  for (const [rel, text] of outputs()) {
    const f = join(ROOT, rel);
    if (!existsSync(f) || readFileSync(f, "utf8") !== text) problems.push(`${rel}: out of date; run npm run build`);
  }
} catch (e) { problems.push(String(e.message)); } // a source that the build cannot read, such as a README without its markers
const core = readFileSync(join(ROOT, "instructions/core.md"), "utf8");
if (Buffer.byteLength(core) > 8 * 1024) problems.push(`instructions/core.md: ${Buffer.byteLength(core)} bytes; keep it under 8 KiB (it loads into every session, so each byte costs context there)`);

// A test must not hold a wall-clock time under a fixed number of milliseconds: on a busy machine a process waits for a
// core, and the test fails for no defect (T53). A name takes the clock when it is set from a clock reading or from a
// name that took it, or when it is a function that returns one. A lower bound may stay: a busy machine only adds time.
const CLOCK = String.raw`(?:Date\.now|performance\.now|process\.hrtime(?:\.bigint)?)\(\)`;
const FIX = 'assert CPU time (process.cpuUsage) as a ratio between two sizes with a generous bound, an order of events or a flag (for example: the lock holder still holds when the command returns), or a count. If none can, end the line with "// timing-ok: <reason>"';
let timingOk = 0;
for (const f of readdirSync(join(ROOT, "scripts")).filter((f) => f.endsWith(".test.mjs"))) {
  const lines = readFileSync(join(ROOT, "scripts", f), "utf8").split("\n").map((l) => l.replace(/(["'`])(?:\\.|(?!\1)[^\\])*\1/g, '""').replace(/(^|\s)\/\/(?! timing-ok:).*$/, "$1")); // no strings, no comments
  const clocked = new Set();
  const takes = (text) => new RegExp(`${CLOCK}${clocked.size ? `|(?<![\\w$.])(?:${[...clocked].join("|")})(?![\\w$])` : ""}`).test(text);
  for (let before = -1; before !== clocked.size; ) {
    before = clocked.size;
    let fn;
    for (const line of lines) {
      // The function that a return line is in: the last one that a line named, or none after an unnamed one.
      const named = /(?:function\s+([\w$]+)|([\w$]+)\s*=\s*(?:async\s*)?(?:\([^)]*\)|[\w$]+)\s*=>)/.exec(line)?.slice(1).find(Boolean);
      fn = named ?? (/=>\s*\{|function\s*\(/.test(line) ? undefined : fn);
      const set = /(\[[^\]]*\]|[\w$]+)\s*=(?![=>])([^;]*)/.exec(line);
      if (set && takes(set[2])) for (const name of set[1].match(/[\w$]+/g)) clocked.add(name);
      if (fn && /\breturn\b/.test(line) && takes(line.replace(/^.*?\breturn\b/, ""))) clocked.add(fn);
    }
  }
  const term = `(?:${CLOCK}${clocked.size ? `|(?<![\\w$.])(?:${[...clocked].join("|")})(?![\\w$])` : ""})`;
  const under = new RegExp(`${term}[^<>&|,;?]*?<=?\\s*[\\d_.]+|[\\d_.]+\\s*>=?[^<>&|,;?]*?${term}`);
  lines.forEach((line, i) => {
    if (!under.test(line.replace(/\/\/ timing-ok:.*$/, ""))) return;
    if (/\/\/ timing-ok: \S/.test(line)) timingOk++;
    else problems.push(`scripts/${f}:${i + 1}: a test holds a wall-clock time under a fixed number of ms, so a busy machine breaks it. Instead, ${FIX}.`);
  });
}

// Test browsers are Playwright's bundled Chromium: never the owner's Google Chrome app (T68). A line that must name it
// (a fake process list, this check) ends with "// chrome-ok: <reason>".
// The forms: a channel option in code or JSON, a --channel or --browser flag, and the app's path. Each Chrome channel counts.
const INSTALLED_CHROME = /\bchannel["']?\s*[:=]\s*["'`]chrome(?:-\w+)?["'`]|--(?:channel|browser)(?:=|\s+)["']?chrome(?:-\w+)?\b|\/Applications\/Google Chrome[^/]*\.app/; // chrome-ok: the pattern itself
const walk = (dir) => readdirSync(join(ROOT, dir), { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? (e.name === "node_modules" ? [] : walk(join(dir, e.name))) : [join(dir, e.name)]));
for (const f of [...walk("scripts"), ...walk("plugins")].filter((f) => /\.(m?js|cjs|ts|json|sh|md|html)$/.test(f))) {
  readFileSync(join(ROOT, f), "utf8").split("\n").forEach((line, i) => {
    if (INSTALLED_CHROME.test(line) && !/\/\/ chrome-ok: \S/.test(line)) problems.push(`${f}:${i + 1}: launches the installed Google Chrome; use Playwright's bundled Chromium (chromium.launch() with no channel), or end the line with "// chrome-ok: <reason>"`);
  });
}

// No test or script reads or signals the real process list (T88). A file that turns the browser sweep on puts a fake
// ps and kill first on PATH (PATH: `${<a temp folder>}:${process.env.PATH}`); none signals a process other than its own
// or runs ps or kill itself. The hook refuses the real programs under a test too; this check fails the pull request.
// Extra files to check come as arguments, so a test can check a fixture: node scripts/check.mjs <file>…
const SWEEP_ON = /SAGE_BROWSER_SWEEP["']?\s*[:=]\s*["'`]?on\b/;
const FAKE_PATH = /PATH["']?\s*[:=]\s*`\$\{[^`]+\}:\$\{process\.env\.PATH\}`/;
const SIGNALS = /\bprocess\.kill\((?!\s*process\.pid\b)/;
const RUNS_PS = /\b(?:spawn|spawnSync|exec|execSync|execFile|execFileSync)\(\s*["'`](?:\/usr)?(?:\/s?bin\/)?(?:ps|kill|pkill|killall)\b/;
for (const f of [...walk("scripts").filter((f) => /\.(m?js|cjs|sh)$/.test(f)), ...process.argv.slice(2)]) {
  const text = readFileSync(resolve(ROOT, f), "utf8");
  if (SWEEP_ON.test(text) && !FAKE_PATH.test(text)) problems.push(`${f}: turns the browser sweep on without a fake ps and kill first on PATH; set PATH: \`\${<a temp folder with fake ps and kill>}:\${process.env.PATH}\``);
  text.split("\n").forEach((line, i) => {
    if (SIGNALS.test(line)) problems.push(`${f}:${i + 1}: signals a process with process.kill; a test signals only a child it started (child.kill()) or itself`);
    if (RUNS_PS.test(line)) problems.push(`${f}:${i + 1}: runs ps or kill, which reads or signals the real process list; give the code a fake ps and kill`);
  });
}

// The build reads the dictionary too, so a problem in it comes twice: report it once.
if (problems.length) { console.error([...new Set(problems)].map((p) => `✗ ${p}`).join("\n")); process.exit(1); }
console.log(`✓ all checks pass (${timingOk} wall-clock ${timingOk === 1 ? "bound carries" : "bounds carry"} "// timing-ok:")`);
