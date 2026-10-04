#!/usr/bin/env node
// Brings pstack (github.com/cursor/plugins, folder pstack/) up to date in upstream/pstack/: the files that
// upstream/pstack.json includes, at a commit of upstream (the latest by default). It never touches the overrides in
// principles/. It reports each override whose upstream file changed since the override was last reviewed (its
// `upstream:` fingerprint), because only a person can decide whether the override should follow.
//   node scripts/sync-pstack.mjs [--ref <commit>] [--from <git url>] [--summary <file>]
// In GitHub Actions it also writes changed=true|false and touched=<n> to $GITHUB_OUTPUT.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = process.env.PSTACK_SYNC_ROOT ?? join(dirname(fileURLToPath(import.meta.url)), ".."); // tests point it at a copy
const CONF = join(ROOT, "upstream/pstack.json");
const DIR = join(ROOT, "upstream/pstack");

export const fingerprint = (text) => createHash("sha256").update(text).digest("hex").slice(0, 16);

/** Every file under `base` whose path matches a pattern: "*" matches within one segment, a final "**" matches the rest. */
export function included(base, patterns) {
  const out = [];
  const walk = (dir) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else out.push(relative(base, p));
    }
  };
  if (existsSync(base)) walk(base);
  const match = (path, pattern) => {
    const re = pattern.split("/").map((seg) => (seg === "**" ? ".+" : seg.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, "[^/]*"))).join("/");
    return new RegExp(`^${re}$`).test(path);
  };
  return out.filter((p) => patterns.some((pat) => match(p, pat))).sort();
}

const hashes = (base, files) => Object.fromEntries(files.map((f) => [f, fingerprint(readFileSync(join(base, f)))]));

/** The overrides in principles/ that name a pstack principle, with the fingerprint they were reviewed against. */
export function overrides(root = ROOT) {
  return readdirSync(join(root, "principles"))
    .filter((f) => f.endsWith(".md") && f !== "README.md")
    .map((f) => {
      const fm = /^---\n([\s\S]*?)\n---/.exec(readFileSync(join(root, "principles", f), "utf8"))?.[1] ?? "";
      const upstreamFile = /^source:\s*pstack (principle-[a-z-]+)/m.exec(fm)?.[1];
      return upstreamFile && { file: `principles/${f}`, upstream: `skills/${upstreamFile}/SKILL.md`, reviewed: /^upstream:\s*(\S+)/m.exec(fm)?.[1] };
    })
    .filter(Boolean);
}

function sync({ ref, from, summaryFile }) {
  const conf = JSON.parse(readFileSync(CONF, "utf8"));
  const tmp = mkdtempSync(join(tmpdir(), "pstack-"));
  const git = (...args) => execFileSync("git", ["-C", tmp, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  try {
    execFileSync("git", ["clone", "-q", "--filter=blob:none", "--sparse", "--no-checkout", from ?? `https://github.com/${conf.repo}.git`, tmp], { stdio: ["ignore", "pipe", "pipe"] });
    git("sparse-checkout", "set", conf.path);
    git("checkout", "-q", ref ?? "HEAD");
    const src = join(tmp, conf.path);
    const sha = git("rev-parse", "HEAD");
    const version = JSON.parse(readFileSync(join(src, ".cursor-plugin/plugin.json"), "utf8")).version;
    const files = included(src, conf.include);
    const before = hashes(DIR, included(DIR, conf.include));
    const after = hashes(src, files);
    rmSync(DIR, { recursive: true, force: true });
    for (const f of files) {
      mkdirSync(dirname(join(DIR, f)), { recursive: true });
      cpSync(join(src, f), join(DIR, f));
    }
    const old = { sha: conf.sha, version: conf.version };
    Object.assign(conf, { sha, version, synced: new Date().toISOString().slice(0, 10) });
    writeFileSync(CONF, JSON.stringify(conf, null, 2) + "\n");

    const added = files.filter((f) => !(f in before));
    const changed = files.filter((f) => f in before && before[f] !== after[f]);
    const removed = Object.keys(before).filter((f) => !(f in after));
    const touched = overrides().filter((o) => o.upstream in after && o.reviewed !== after[o.upstream]);
    const lines = [
      `pstack ${old.version ?? "none"} → ${version} (${conf.repo} ${sha.slice(0, 7)})`,
      `added ${added.length} · changed ${changed.length} · removed ${removed.length} · overrides to review ${touched.length}`,
      ...added.map((f) => `+ ${f}`),
      ...changed.map((f) => `~ ${f}`),
      ...removed.map((f) => `- ${f}`),
      ...touched.map((o) => `! ${o.file} overrides ${o.upstream}, which changed since its review (now ${after[o.upstream]}). Compare, update the override if needed, then set its upstream: to ${after[o.upstream]}.`),
      ...(old.sha && old.sha !== sha ? [`compare: https://github.com/${conf.repo}/compare/${old.sha}...${sha}`] : []),
    ];
    const text = lines.join("\n");
    if (summaryFile) writeFileSync(summaryFile, text + "\n");
    if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `changed=${added.length + changed.length + removed.length > 0}\ntouched=${touched.length}\nversion=${version}\n`);
    return text;
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const opt = (name) => (args.includes(`--${name}`) ? args[args.indexOf(`--${name}`) + 1] : undefined);
  console.log(sync({ ref: opt("ref"), from: opt("from"), summaryFile: opt("summary") }));
}
