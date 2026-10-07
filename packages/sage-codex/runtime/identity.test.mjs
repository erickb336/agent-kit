import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

async function fixture(t) {
  const { readSessionIdentity } = await import("./identity.mjs");
  const root = realpathSync(mkdtempSync(join(tmpdir(), "sage-identity-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const sessionsDir = join(root, "sessions");
  mkdirSync(sessionsDir);
  const file = join(sessionsDir, "session.jsonl");
  return { root, sessionsDir, file, read: (path = file) => readSessionIdentity(path, { sessionsDir }) };
}
const header = (payload) => JSON.stringify({ type: "session_meta", payload }) + "\n";

test("identity retains only native identity fields and ignores later transcript text", async (t) => {
  const f = await fixture(t);
  const identity = { id: "root", session_id: "root", cli_version: "0.160.0", parent_thread_id: null, agent_path: null };
  writeFileSync(f.file, header({ ...identity, instructions: "private" }) + "invalid later content".repeat(100000));
  assert.deepEqual(f.read(), identity);
});

test("identity refuses outside paths, directories, and links in any component", async (t) => {
  const f = await fixture(t);
  const outside = join(f.root, "outside");
  writeFileSync(outside, header({ id: "other" }));
  symlinkSync(outside, f.file);
  assert.throws(() => f.read(), /identity is unavailable/);
  assert.throws(() => f.read(outside), /identity is unavailable/);
  assert.throws(() => f.read(f.sessionsDir), /identity is unavailable/);
  const nested = join(f.sessionsDir, "nested");
  symlinkSync(f.root, nested);
  assert.throws(() => f.read(join(nested, "outside")), /identity is unavailable/);
  assert.throws(() => f.read(`${f.sessionsDir}/../outside`), /identity is unavailable/);
});

test("identity requires a complete bounded first metadata line", async (t) => {
  const f = await fixture(t);
  for (const input of ["", "{}\n", header(null), "not json\n", JSON.stringify({ type: "session_meta", payload: {} }),
    " ".repeat(256 * 1024) + header({}), JSON.stringify({ type: "other", payload: {} }) + "\n"]) {
    writeFileSync(f.file, input);
    assert.throws(() => f.read(), /identity is unavailable/);
  }
  writeFileSync(f.file, Buffer.concat([Buffer.from('{"type":"session_meta","payload":{"id":"'), Buffer.from([0xff]), Buffer.from('"}}\n')]));
  assert.throws(() => f.read(), /identity is unavailable/);
});

test("identity errors omit filesystem details and metadata stays subject to caller validation", async (t) => {
  const f = await fixture(t);
  assert.throws(() => f.read(), { message: "Codex session identity is unavailable" });
  writeFileSync(f.file, header({ instructions: "private" }));
  assert.deepEqual(f.read(), {});
  writeFileSync(f.file, header({ id: { malformed: true }, parent_thread_id: null }));
  assert.deepEqual(f.read(), { id: { malformed: true }, parent_thread_id: null });
});


const firstTurn = "33333333-3333-4333-8333-333333333333";
const started = (turn = firstTurn) => JSON.stringify({ type: "event_msg", payload: { type: "task_started", turn_id: turn } }) + "\n";

test("initial session reads exactly the metadata and first native turn", async (t) => {
  const f = await fixture(t);
  const { readInitialSession } = await import("./identity.mjs");
  writeFileSync(f.file, header({ id: "root", instructions: "private" }) + started() + "invalid later content");
  assert.deepEqual(readInitialSession(f.file, f), { metadata: { id: "root" }, turn: firstTurn });
});

test("initial session refuses missing or ambiguous first turn and ignores later replacements", async (t) => {
  const f = await fixture(t);
  const { readInitialSession } = await import("./identity.mjs");
  for (const suffix of ["", started("invalid"), "{}\n" + started(), started().trimEnd(), " ".repeat(256 * 1024) + started()]) {
    writeFileSync(f.file, header({}) + suffix);
    assert.throws(() => readInitialSession(f.file, f), /identity is unavailable/);
  }
  writeFileSync(f.file, header({}) + started() + started("44444444-4444-4444-8444-444444444444"));
  assert.equal(readInitialSession(f.file, f).turn, firstTurn);
});
