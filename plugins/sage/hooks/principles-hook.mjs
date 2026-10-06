#!/usr/bin/env node
// The principles hook of sage. Claude Code sends one JSON event on stdin and reads one JSON answer on stdout.
//   - It puts a principle's text into the agent's context at the moment the principle applies (MOMENTS), once per
//     session. So the principle no longer depends on the agent choosing to load its skill.
//   - It stops the agent once from finishing when the code changed and no check ran after the change (prove-it-works).
// AGENT_KIT_HOOKS=off turns it off. Orchestrator sets it for its workers, because it gives each step its own principles.
// The AGENT_KIT_* names stay from the kit's first name, agent-kit, so that Orchestrator's workers keep working.
// The hook never breaks a session: on any error it answers nothing.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const SKILLS = join(dirname(fileURLToPath(import.meta.url)), "../skills");

/** The moments that a hook can see, and the skills (principles and guides) that apply then. A skill with no moment stays on the skill listing only. */
export const MOMENTS = {
  design: { why: "the request asks for a design, a plan or a new feature", skills: ["principle-exhaust-the-design-space", "principle-experience-first", "principle-foundational-thinking"] },
  refactor: { why: "the request asks for a refactor or a cleanup", skills: ["principle-subtract-before-you-add", "principle-laziness-protocol", "principle-migrate-callers-then-delete-legacy-apis"] },
  testEdit: { why: "you are about to change a test file", skills: ["principle-test-behavior-not-implementation"] },
  docEdit: { why: "you are about to write a document for a person", skills: ["principle-contextualize-and-write-for-the-reader"] },
  readmeEdit: { why: "you are about to write or change a README", skills: ["principle-contextualize-and-write-for-the-reader", "readme-guide"] },
  commit: { why: "you are about to commit", skills: ["principle-sequence-verifiable-units"] },
  checkFailed: { why: "a check failed", skills: ["principle-fix-root-causes"] },
  fixesFailed: { why: "two changes in a row did not make the same check pass", skills: ["principle-attack-the-premise"] },
  unchecked: { why: "the code changed and no check ran after the change", skills: ["principle-prove-it-works"] },
};

const DESIGN = /\b(design\w*|architect\w*|new feature|prototype|data model|schema|plan(s|ning)?)\b/i;
const REFACTOR = /\b(refactor\w*|clean(ing)?[ -]?up|simplif\w*|rewrite|restructur\w*|dead code|deprecat\w*|legacy)\b/i;
const TEST_FILE = /(^|\/)(tests?|__tests__|spec)\/|\.(test|spec)\.\w+$|_test\.\w+$|(^|\/)test_[^/]+\.py$/i;
const DOC_FILE = /\.(md|mdx|markdown|rst|adoc|txt)$/i;
/** A README document: no extension, or a document extension after an optional language part (README.zh-CN.md). Not code such as readme.rs. */
const README_FILE = /(^|\/)readme((\.[a-z]{2,3}([-_][a-z0-9]+)?)?\.(md|mdx|markdown|rst|adoc|txt))?$/i;
const COMMIT = /\bgit\s+(-C\s+\S+\s+)?commit\b/;
/** A shell command that checks the code. The match is the check's name, so "npm test | tail" and "npm test" are one check. */
const CHECK =
  /\b(?:(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?(?:test|check|lint|typecheck|build|verify|e2e)[\w:-]*|npx\s+(?:vitest|jest|playwright|tsc|eslint)|vitest|jest|playwright\s+test|pytest|go\s+(?:test|vet|build)|cargo\s+(?:test|check|build|clippy)|tsc|make\s+(?:test|check)|swift\s+(?:test|build)|xcodebuild|node\s+--test|deno\s+test|mvn\s+(?:test|verify)|gradlew?\s+(?:test|check|build))\b/;
/** A tool that looks at the running result: a browser, a preview or a simulator. It counts as a check. */
const LOOK_TOOL = /^(mcp__.*(browser|preview|simulator|chrome|playwright)|browser)/i;

export function handle(input, state) {
  const event = input.hook_event_name;
  const tool = input.tool_name ?? "";
  const shell = tool === "Bash";
  const command = [].concat(input.tool_input?.command ?? []).join(" ");

  if (event === "UserPromptSubmit") {
    state.turnStart = fingerprint(input.cwd);
    const prompt = input.prompt ?? "";
    return inject(event, state, [DESIGN.test(prompt) && "design", REFACTOR.test(prompt) && "refactor"]);
  }
  if (event === "PreToolUse") {
    const paths = shell ? [] : [input.tool_input?.file_path, input.tool_input?.notebook_path].filter((p) => typeof p === "string");
    return inject(event, state, [paths.some((p) => TEST_FILE.test(p)) && "testEdit", paths.some((p) => DOC_FILE.test(p)) && "docEdit", paths.some((p) => README_FILE.test(p)) && "readmeEdit", shell && COMMIT.test(command) && "commit"]);
  }
  if (event === "PostToolUse" || event === "PostToolUseFailure") {
    const check = shell ? CHECK.exec(command)?.[0] : LOOK_TOOL.test(tool) ? tool : undefined;
    if (!check) return undefined;
    const now = fingerprint(input.cwd);
    state.lastCheck = now;
    // Claude Code sends a failed command as PostToolUseFailure, so its PostToolUse is a success.
    if (!shell || event !== "PostToolUseFailure") {
      delete state.failures[check];
      return undefined;
    }
    // A failure after the code changed means that a fix did not work.
    const f = state.failures[check];
    if (!f) {
      state.failures[check] = { at: now, fixes: 0 };
      return inject(event, state, ["checkFailed"]);
    }
    if (now !== f.at) Object.assign(f, { at: now, fixes: f.fixes + 1 });
    return inject(event, state, [f.fixes >= 2 && "fixesFailed"]);
  }
  if (event === "PostCompact") {
    state.given = []; // the compaction can drop the text, so give it again when its moment comes
    return undefined;
  }
  if (event === "Stop") {
    // Once per state of the code: a second stop goes through, so the agent can say what it did not verify.
    if (input.stop_hook_active || !state.turnStart) return undefined;
    const now = fingerprint(input.cwd);
    if (!now || now === state.turnStart || now === state.lastCheck || now === state.lastGate) return undefined;
    state.lastGate = now;
    give(state, "unchecked");
    return {
      decision: "block",
      reason:
        "sage stops you once here: the code changed, and no check ran after the change. " +
        "Run the check that shows that the change works. If you cannot run one, say what you did not verify. Then finish.\n\n" +
        skillText("principle-prove-it-works"),
    };
  }
  return undefined;
}

/** The principles of these moments that the session did not get yet, as added context. */
function inject(event, state, moments) {
  const parts = moments.filter(Boolean).flatMap((m) => give(state, m).map((p) => `Why now: ${MOMENTS[m].why}.\n\n${skillText(p)}`));
  if (!parts.length) return undefined;
  const text = `sage: ${parts.length === 1 ? "a principle applies" : "these principles apply"} to what you do now. Follow ${parts.length === 1 ? "it" : "them"}.\n\n${parts.join("\n\n---\n\n")}`;
  return { hookSpecificOutput: { hookEventName: event, additionalContext: text } };
}

function give(state, moment) {
  const fresh = MOMENTS[moment].skills.filter((p) => !state.given.includes(p));
  state.given.push(...fresh);
  return fresh;
}

export function skillText(name) {
  const text = readFileSync(join(SKILLS, name, "SKILL.md"), "utf8");
  return text.replace(/^---\n[\s\S]*?\n---\n/, "").replace(/<!--[\s\S]*?-->/, "").trim();
}

/**
 * The content of the code in the working tree, as one hash. A commit does not change it, and documents are left out.
 * Undefined outside a git repository, so the stop check is off there.
 */
export function fingerprint(cwd) {
  try {
    const git = (dir, args, input) => execFileSync("git", ["-C", dir, ...args], { input, encoding: "utf8", maxBuffer: 256 << 20, stdio: ["pipe", "pipe", "ignore"] });
    const root = git(cwd ?? ".", ["rev-parse", "--show-toplevel"]).trim();
    const content = new Map();
    for (const entry of git(root, ["ls-files", "-s", "-z"]).split("\0")) {
      const tab = entry.indexOf("\t"); // "<mode> <blob> <stage>\t<path>"
      if (tab > 0) content.set(entry.slice(tab + 1), entry.split(" ")[1]);
    }
    const changed = git(root, ["status", "--porcelain=v1", "-z", "--untracked-files=all", "--no-renames"]).split("\0").filter(Boolean).map((e) => e.slice(3));
    const present = changed.filter((p) => existsSync(join(root, p)));
    const hashes = present.length ? git(root, ["hash-object", "--stdin-paths"], present.join("\n") + "\n").trim().split("\n") : [];
    for (const p of changed) content.set(p, "deleted");
    present.forEach((p, i) => content.set(p, hashes[i]));
    const lines = [...content].filter(([p]) => !DOC_FILE.test(p)).map(([p, h]) => `${p}\0${h}`).sort();
    return createHash("sha1").update(lines.join("\n")).digest("hex");
  } catch {
    return undefined;
  }
}

function stateFile(sessionId) {
  return join(process.env.AGENT_KIT_HOOKS_STATE ?? join(tmpdir(), "agent-kit-hooks"), `${String(sessionId).replace(/[^\w.-]/g, "_")}.json`);
}

function loadState(sessionId) {
  try {
    return JSON.parse(readFileSync(stateFile(sessionId), "utf8"));
  } catch {
    return { given: [], failures: {} };
  }
}

function saveState(sessionId, state) {
  const f = stateFile(sessionId);
  mkdirSync(dirname(f), { recursive: true });
  writeFileSync(`${f}.${process.pid}`, JSON.stringify(state));
  renameSync(`${f}.${process.pid}`, f); // whole or nothing, when two hooks finish at the same time
}

function log(entry) {
  if (process.env.AGENT_KIT_HOOKS_LOG) appendFileSync(process.env.AGENT_KIT_HOOKS_LOG, JSON.stringify({ at: new Date().toISOString(), ...entry }) + "\n");
}

// Node gives this module its real path, so a path to the hook through a symbolic link is compared as a real path too.
if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url) && process.env.AGENT_KIT_HOOKS !== "off") {
  let input;
  try {
    input = JSON.parse(readFileSync(0, "utf8"));
    const state = loadState(input.session_id ?? "unknown");
    const output = handle(input, state);
    saveState(input.session_id ?? "unknown", state);
    log({ input: { ...input, tool_response: JSON.stringify(input.tool_response ?? null).slice(0, 2000) }, output });
    if (output) process.stdout.write(JSON.stringify(output));
  } catch (err) {
    try {
      log({ input, error: String(err?.stack ?? err) });
    } catch {
      /* the log is for tests only */
    }
  }
}
