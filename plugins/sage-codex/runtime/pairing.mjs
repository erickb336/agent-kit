// Per-connection coordination only. The transport must authenticate both inputs.
const FIELDS = ["session", "turn", "call", "tool", "actor", "hash"];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const text = (value) => typeof value === "string" && value.length > 0 && value.length <= 256 && !/\p{Cc}/u.test(value);
function valid(input) {
  return input !== null && typeof input === "object" && !Array.isArray(input)
    && Object.keys(input).length === FIELDS.length && FIELDS.every(key => Object.hasOwn(input, key) && text(input[key]))
    && ["session", "turn", "actor"].every(key => UUID.test(input[key])) && /^[0-9a-f]{64}$/.test(input.hash);
}
const keyOf = (input) => JSON.stringify([input.session, input.turn, input.call]);

/** A full or closed connection denies new calls; consumed keys are never evicted. */
export function createPairing({ limit = 1024 } = {}) {
  if (!Number.isInteger(limit) || limit < 1 || limit > 4096) throw Error("Invalid pairing limit");
  const calls = new Map();
  let closed = false;
  const finish = (call, decision) => {
    if (call.done) return;
    call.done = true;
    call.resolve?.(decision);
    delete call.native;
    delete call.guard;
    delete call.resolve;
  };
  const find = (input) => {
    if (closed || !valid(input)) return null;
    const key = keyOf(input);
    if (!calls.has(key)) {
      if (calls.size >= limit) return null;
      calls.set(key, { done: false });
    }
    return calls.get(key);
  };
  const settle = (call) => {
    if (!call.done && call.native && call.guard) {
      finish(call, FIELDS.every(key => call.native[key] === call.guard[key]) ? "pass" : "deny");
    }
  };
  return {
    observe(input) {
      const call = find(input);
      if (!call || call.done) return false;
      if (call.native) { finish(call, "deny"); return false; }
      call.native = { ...input };
      settle(call);
      return true;
    },
    request(input) {
      const call = find(input);
      const denied = () => ({ result: Promise.resolve("deny"), cancel() {} });
      if (!call || call.done) return denied();
      if (call.guard) { finish(call, "deny"); return denied(); }
      const result = new Promise(resolve => { call.resolve = resolve; });
      call.guard = { ...input };
      settle(call);
      return { result, cancel: () => finish(call, "deny") };
    },
    close() {
      closed = true;
      for (const call of calls.values()) finish(call, "deny");
      calls.clear();
    },
  };
}
