import assert from "node:assert/strict";
import { test } from "node:test";
const load = () => import("./pairing.mjs");
const evidence = () => ({ session: "11111111-1111-4111-8111-111111111111", turn: "22222222-2222-4222-8222-222222222222", actor: "11111111-1111-4111-8111-111111111111", call: "call-1", tool: "control", hash: "a".repeat(64) });

test("pairing accepts one exact call in either arrival order", async () => {
  const { createPairing } = await load();
  for (const nativeFirst of [false, true]) {
    const gate = createPairing();
    if (nativeFirst) assert.equal(gate.observe(evidence()), true);
    const request = gate.request(evidence());
    if (!nativeFirst) assert.equal(gate.observe(evidence()), true);
    assert.equal(await request.result, "pass");
    assert.equal(await gate.request(evidence()).result, "deny");
    assert.equal(gate.observe(evidence()), false);
  }
});

test("pairing denies mismatched actor, tool or input", async () => {
  const { createPairing } = await load();
  for (const change of [{ actor: "33333333-3333-4333-8333-333333333333" }, { tool: "other" }, { hash: "b".repeat(64) }]) {
    const gate = createPairing();
    gate.observe(evidence());
    assert.equal(await gate.request({ ...evidence(), ...change }).result, "deny");
    assert.equal(await gate.request(evidence()).result, "deny");
  }
});

test("pairing never substitutes another session, turn or call", async () => {
  const { createPairing } = await load();
  for (const change of [{ session: "33333333-3333-4333-8333-333333333333" }, { turn: "33333333-3333-4333-8333-333333333333" }, { call: "other" }]) {
    const gate = createPairing();
    gate.observe(evidence());
    const request = gate.request({ ...evidence(), ...change });
    request.cancel();
    assert.equal(await request.result, "deny");
  }
});

test("pairing rejects duplicate native evidence even when the later record matches", async () => {
  const { createPairing } = await load();
  for (const duplicate of [evidence(), { ...evidence(), hash: "b".repeat(64) }]) {
    const gate = createPairing();
    assert.equal(gate.observe(evidence()), true);
    assert.equal(gate.observe(duplicate), false);
    assert.equal(await gate.request(duplicate).result, "deny");
  }
});

test("pairing denies both duplicate guards and a cancelled guard cannot return", async () => {
  const { createPairing } = await load();
  const gate = createPairing();
  const first = gate.request(evidence());
  const second = gate.request(evidence());
  assert.equal(await first.result, "deny");
  assert.equal(await second.result, "deny");
  assert.equal(gate.observe(evidence()), false);
  const other = { ...evidence(), call: "other" };
  const cancelled = gate.request(other);
  cancelled.cancel(); cancelled.cancel();
  assert.equal(await cancelled.result, "deny");
  assert.equal(gate.observe(other), false);
  assert.equal(await gate.request(other).result, "deny");
});

test("pairing bounds retained calls without making consumed calls reusable", async () => {
  const { createPairing } = await load();
  const gate = createPairing({ limit: 1 });
  gate.observe(evidence());
  assert.equal(await gate.request(evidence()).result, "pass");
  assert.equal(gate.observe({ ...evidence(), call: "other" }), false);
  assert.equal(await gate.request({ ...evidence(), call: "other" }).result, "deny");
  assert.equal(await gate.request(evidence()).result, "deny");
  for (const limit of [0, -1, 1.5, 4097, NaN, Infinity]) assert.throws(() => createPairing({ limit }));
});

test("pairing close denies pending and future calls without cross-connection evidence", async () => {
  const { createPairing } = await load();
  const first = createPairing(), second = createPairing();
  first.observe(evidence());
  const request = second.request(evidence());
  second.close(); second.close();
  assert.equal(await request.result, "deny");
  assert.equal(second.observe(evidence()), false);
  assert.equal(await second.request(evidence()).result, "deny");
  assert.equal(await first.request(evidence()).result, "pass");
});

test("pairing rejects malformed records and copies accepted evidence", async () => {
  const { createPairing } = await load();
  const missing = Object.keys(evidence()).map(key => { const e = evidence(); delete e[key]; return e; });
  for (const bad of [null, [], {}, ...missing, { ...evidence(), extra: true }, { ...evidence(), hash: "z".repeat(64) }, { ...evidence(), actor: "unknown" }, { ...evidence(), tool: "\n" }, { ...evidence(), call: "x".repeat(257) }]) {
    const gate = createPairing();
    assert.equal(gate.observe(bad), false);
    assert.equal(await gate.request(bad).result, "deny");
  }
  const gate = createPairing(), original = evidence();
  gate.observe(original); original.hash = "b".repeat(64);
  assert.equal(await gate.request(evidence()).result, "pass");
});
