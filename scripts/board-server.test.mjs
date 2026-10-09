import "./test-env.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import fs, { mkdtempSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { createHash, randomBytes } from "node:crypto";
import { request } from "node:http";
import { createServer } from "node:net";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createBoardServer } from "../packages/sage-board/server.mjs";

const HEADERS = {
  tasks: "id title size risk route state branch pr round keys",
  runs: "id task role round candidate branch status tokens report started ended",
  findings: "task key round source severity summary triage reason status",
  ledger: "task pr sha kind cycle run at",
  gates: "id task question options recommendation default answer at",
  decisions: "at task decision why",
};
const key = Buffer.from("sample/project-abcdef/T1").toString("base64url");
const row = (title = "Sample first task", id = "T1", state = "framed") => `${id}\t${title}\tsmall\t\tbuild\t${state}\tcodex/sample\t\t0\t\n`;
const tasks = (...rows) => `${HEADERS.tasks.replaceAll(" ", "\t")}\n${rows.join("")}`;

function populate(root, title = "Sample first task") {
  const project = join(root, "project-abcdef"); mkdirSync(project, { recursive: true });
  for (const [name, header] of Object.entries(HEADERS)) writeFileSync(join(project, `${name}.tsv`), `${header.replaceAll(" ", "\t")}\n`);
  writeFileSync(join(project, "tasks.tsv"), tasks(row(title), row("Sample abandoned task", "T2", "abandoned")));
  return project;
}

// The production listener requires a fixed port. Reserve a free test port once, then use that exact port.
async function freePort() {
  const socket = createServer();
  await new Promise((accept, reject) => { socket.once("error", reject); socket.listen(0, "127.0.0.1", accept); });
  const port = socket.address().port;
  await new Promise((accept, reject) => socket.close(error => error ? reject(error) : accept()));
  return port;
}

async function fixture(t, { missing = false, allowedHosts = [] } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "sage-board-server-")), root = join(dir, "source"), port = await freePort();
  const secret = randomBytes(32).toString("base64url");
  if (!missing) populate(root);
  const sources = [{ id: "sample", path: root, label: "Sample source" }];
  const server = createBoardServer({ sources, secret, port, allowedHosts });
  t.after(async () => { await server.close(); rmSync(dir, { recursive: true, force: true }); });
  await server.start();
  return { dir, root, project: join(root, "project-abcdef"), port, secret, sources, server, authorization: `Basic ${Buffer.from(`sage:${secret}`).toString("base64")}` };
}

function read(f, path = "/", { method = "GET", headers = {}, rawHeaders } = {}) {
  return new Promise((accept, reject) => {
    const req = request({ host: "127.0.0.1", port: f.port, path, method, agent: false, headers: rawHeaders ?? { Host: `127.0.0.1:${f.port}`, Authorization: f.authorization, ...headers } }, response => {
      let body = ""; response.setEncoding("utf8"); response.on("data", chunk => body += chunk);
      response.on("end", () => accept({ status: response.statusCode, headers: response.headers, body }));
      response.on("error", reject);
    });
    req.on("error", reject); req.setTimeout(10_000, () => req.destroy(new Error("board request did not finish"))); req.end();
  });
}

function events(f, path = "/?events=1") {
  const queue = [], waiters = new Set();
  let response, buffer = "", ended = false;
  const stop = error => { ended = true; for (const waiter of waiters) { clearTimeout(waiter.timer); waiter.reject(error); } waiters.clear(); };
  const req = request({ host: "127.0.0.1", port: f.port, path, agent: false, headers: { Host: `127.0.0.1:${f.port}`, Authorization: f.authorization } }, incoming => {
    response = incoming;
    if (incoming.statusCode !== 200) { stop(new Error(`event status ${incoming.statusCode}`)); incoming.resume(); return; }
    incoming.setEncoding("utf8");
    incoming.on("data", chunk => {
      buffer += chunk;
      for (let end; (end = buffer.indexOf("\n\n")) !== -1;) {
        const frame = buffer.slice(0, end); buffer = buffer.slice(end + 2);
        if (!frame.includes("event: board\n")) continue;
        try {
          const payload = JSON.parse(frame.split("\n").find(line => line.startsWith("data: ")).slice(6));
          let consumed = false;
          for (const waiter of waiters) if (waiter.predicate(payload)) { consumed = true; clearTimeout(waiter.timer); waiters.delete(waiter); waiter.accept(payload); }
          if (!consumed) queue.push(payload);
        } catch (error) { stop(error); }
      }
    });
    incoming.on("error", stop); incoming.on("end", () => stop(new Error("event stream ended")));
  });
  req.on("error", stop); req.end();
  return {
    next(predicate = () => true) {
      const index = queue.findIndex(predicate);
      if (index >= 0) return Promise.resolve(queue.splice(index, 1)[0]);
      if (ended) return Promise.reject(new Error("event stream is closed"));
      return new Promise((accept, reject) => {
        const waiter = { accept, reject, predicate, timer: null };
        // A generous deadlock guard, not a latency or performance assertion.
        waiter.timer = setTimeout(() => { waiters.delete(waiter); reject(new Error("no matching board event")); }, 10_000);
        waiters.add(waiter);
      });
    },
    close() { req.destroy(); response?.destroy(); stop(new Error("event test closed")); },
  };
}

test("board server serves authenticated pages and HEAD with exact CSP hashes and no data writes", async t => {
  const f = await fixture(t), file = join(f.project, "tasks.tsv"), before = readFileSync(file);
  const page = await read(f);
  assert.equal(page.status, 200); assert.match(page.body, /Sample first task/); assert.match(page.body, /new EventSource/);
  assert.equal(f.server.address().address, "127.0.0.1"); assert.equal(f.server.address().port, f.port);
  assert.equal(page.headers["cache-control"], "no-store"); assert.equal(page.headers["x-content-type-options"], "nosniff");
  assert.equal(page.headers["referrer-policy"], "no-referrer"); assert.equal(page.headers["access-control-allow-origin"], undefined);
  for (const tag of ["script", "style"]) for (const [, content] of page.body.matchAll(new RegExp(`<${tag}>([\\s\\S]*?)<\\/${tag}>`, "g"))) {
    assert.ok(page.headers["content-security-policy"].includes(`'sha256-${createHash("sha256").update(content).digest("base64")}'`));
  }
  assert.doesNotMatch(page.headers["content-security-policy"], /unsafe-inline|https:/);
  assert.match(page.headers["content-security-policy"], /frame-ancestors 'none'/);
  const head = await read(f, "/", { method: "HEAD" }); assert.equal(head.status, 200); assert.equal(head.body, ""); assert.equal(head.headers["content-length"], page.headers["content-length"]);
  const detail = await read(f, `/task/${key}`); assert.equal(detail.status, 200); assert.match(detail.body, /class="detail"/); assert.doesNotMatch(detail.body, /Sample abandoned task/);
  const hidden = Buffer.from("sample/project-abcdef/T2").toString("base64url");
  assert.match((await read(f, `/task/${hidden}`)).body, /Sample abandoned task/);
  assert.deepEqual(readFileSync(file), before);
});

test("board server authenticates every page and event route, with no credential or source disclosure", async t => {
  const f = await fixture(t);
  for (const path of ["/", `/task/${key}`, "/?events=1", `/?events=1&task=${key}`]) {
    for (const authorization of ["", `Basic ${Buffer.from(`wrong:${f.secret}`).toString("base64")}`, `Basic ${Buffer.from("sage:wrong").toString("base64")}`]) {
      const result = await read(f, path, { headers: { Authorization: authorization } });
      assert.equal(result.status, 401); assert.match(result.headers["www-authenticate"], /^Basic /);
      assert.doesNotMatch(result.body, /Sample first task/); assert.ok(!result.body.includes(f.root)); assert.ok(!result.body.includes(f.secret));
    }
  }
  const duplicate = await read(f, "/", { rawHeaders: ["Host", `127.0.0.1:${f.port}`, "Authorization", f.authorization, "Authorization", f.authorization] });
  assert.equal(duplicate.status, 401);
  const eventHead = await read(f, "/?events=1", { method: "HEAD" }); assert.equal(eventHead.status, 200); assert.equal(eventHead.body, "");
});

test("board server rejects foreign, duplicate and mismatched browser authority headers", async t => {
  const f = await fixture(t, { allowedHosts: ["sample.tailnet.ts.net"] });
  for (const headers of [
    { Host: "attacker.test" }, { Host: `localhost:${f.port}.attacker.test` }, { Host: `127.0.0.1:${f.port}.` },
    { Origin: "https://attacker.test" }, { Origin: "null" }, { Origin: "https://sample.tailnet.ts.net" },
    { "Sec-Fetch-Site": "cross-site" }, { "Sec-Fetch-Site": "same-site" },
  ]) assert.equal((await read(f, "/", { headers })).status, 403);
  for (const name of ["Host", "Origin", "Sec-Fetch-Site"]) {
    const value = name === "Host" ? `127.0.0.1:${f.port}` : name === "Origin" ? `http://127.0.0.1:${f.port}` : "same-origin";
    const headers = ["Authorization", f.authorization, ...(name === "Host" ? [] : ["Host", `127.0.0.1:${f.port}`]), name, value, name, value];
    assert.equal((await read(f, "/", { rawHeaders: headers })).status, 403);
  }
  assert.equal((await read(f, "/", { headers: { Origin: `http://127.0.0.1:${f.port}`, "Sec-Fetch-Site": "same-origin" } })).status, 200);
  assert.equal((await read(f, "/", { headers: { Host: "sample.tailnet.ts.net", Origin: "https://sample.tailnet.ts.net", "Sec-Fetch-Site": "same-origin" } })).status, 200);
});

test("board server exposes only canonical read routes and refuses invalid configuration", async t => {
  const f = await fixture(t);
  for (const path of ["/tasks.tsv", "/../config.json", "/%2e%2e/config.json", "/?events=1&events=1", "/?events=1&other=x", `/?events=1&task=${key}&task=${key}`, `/?task=${key}&events=1`, `/task/${key}=`, "/task/_w", `/task/${Buffer.from("missing").toString("base64url")}`, "/task/YR"]) {
    const result = await read(f, path); assert.equal(result.status, 404, path); assert.doesNotMatch(result.body, /Sample first task/);
  }
  assert.equal((await read(f, "/", { method: "POST" })).status, 405);
  const options = { sources: f.sources, secret: f.secret, port: f.port };
  for (const changed of [{ secret: "short" }, { secret: `bad\n${f.secret}` }, { port: 0 }, { sources: [] }, { sources: Array(1) }, { sources: [{ id: 2, path: f.root }] }, { sources: [{ id: "one", path: f.root, label: {} }] }, { allowedHosts: ["127.1"] }, { allowedHosts: ["name."] }, { allowedHosts: ["https://host"] }, { allowedHosts: Array(1) }]) assert.throws(() => createBoardServer({ ...options, ...changed }), TypeError);
});

test("board server fails on an occupied fixed port and closes without changing another listener", async t => {
  const f = await fixture(t), other = createBoardServer({ sources: f.sources, secret: f.secret, port: f.port });
  t.after(() => other.close());
  await assert.rejects(other.start(), { code: "EADDRINUSE" });
  assert.equal((await read(f)).status, 200);
  assert.deepEqual(await f.server.start(), f.server.address());
  await Promise.all([f.server.close(), f.server.close()]); assert.equal(f.server.address(), null);
  await assert.rejects(f.server.start(), /closed/);
});

test("board event streams deliver initial and atomic file updates for the selected page and reconnect", async t => {
  const f = await fixture(t), board = events(f), task = events(f, `/?events=1&task=${key}`);
  t.after(() => { board.close(); task.close(); });
  const first = await board.next(), firstTask = await task.next();
  assert.equal(first.stale, false); assert.deepEqual(first.diagnostics, []); assert.match(first.html, /class="board"/);
  assert.match(firstTask.html, /class="detail"/); assert.match(firstTask.html, /Agent runs/);
  const temporary = join(f.project, "tasks.pending"), target = join(f.project, "tasks.tsv");
  writeFileSync(temporary, tasks(row("Sample replaced title"))); renameSync(temporary, target);
  const updated = await board.next(p => p.html.includes("Sample replaced title") && !p.stale);
  const updatedTask = await task.next(p => p.html.includes("Sample replaced title") && !p.stale);
  assert.ok(Number(updated.revision) > Number(first.revision)); assert.match(updatedTask.html, /class="detail"/);
  const reconnect = events(f); t.after(() => reconnect.close());
  const snapshot = await reconnect.next(); assert.equal(snapshot.revision, updated.revision); assert.match(snapshot.html, /Sample replaced title/);
});

test("board event streams keep the last valid content while an incomplete write is stale, then recover", async t => {
  const f = await fixture(t), stream = events(f); t.after(() => stream.close());
  const initial = await stream.next(); assert.equal(initial.stale, false);
  const file = join(f.project, "tasks.tsv"); writeFileSync(file, "incomplete header\nprivate partial data\n");
  const stale = await stream.next(p => p.stale);
  assert.match(stale.html, /Sample first task/); assert.doesNotMatch(stale.html, /private partial data/);
  assert.ok(stale.diagnostics.some(d => /tasks/.test(d.message))); assert.ok(Number(stale.revision) > Number(initial.revision));
  const page = await read(f); assert.match(page.body, /Sample first task/); assert.match(page.body, /Incomplete sources/);
  writeFileSync(file, tasks(row("Sample repaired title")));
  const repaired = await stream.next(p => !p.stale && p.html.includes("Sample repaired title")); assert.deepEqual(repaired.diagnostics, []);
});

test("board watches a missing root and reattaches after root replacement without polling", async t => {
  const f = await fixture(t, { missing: true }), stream = events(f); t.after(() => stream.close());
  const missing = await stream.next(); assert.equal(missing.stale, true); assert.ok(missing.diagnostics.some(d => d.message === "ENOENT"));
  populate(f.root, "Sample created source");
  await stream.next(p => !p.stale && p.html.includes("Sample created source"));
  const old = join(f.dir, "old-source"); renameSync(f.root, old);
  const removed = await stream.next(p => p.stale && p.diagnostics.some(d => d.message === "ENOENT")); assert.match(removed.html, /Sample created source/);
  populate(f.root, "Sample replacement source");
  await stream.next(p => !p.stale && p.html.includes("Sample replacement source"));
  writeFileSync(join(f.project, "tasks.tsv"), tasks(row("Sample replacement changed")));
  await stream.next(p => !p.stale && p.html.includes("Sample replacement changed"));
});

test("board watcher errors publish a stale diagnostic and recover on an observed root change", async t => {
  const original = fs.watch, captured = [];
  fs.watch = (...args) => { const watcher = original(...args); captured.push({ path: args[0], options: args[1], watcher }); return watcher; };
  syncBuiltinESMExports();
  let f;
  try { f = await fixture(t); } finally { fs.watch = original; syncBuiltinESMExports(); }
  const stream = events(f); t.after(() => stream.close()); await stream.next();
  const root = captured.find(item => item.path === f.root && item.options.recursive); assert.ok(root);
  root.watcher.emit("error", new Error("sample watcher failure"));
  const stale = await stream.next(p => p.stale && p.diagnostics.some(d => /File watching/.test(d.message)));
  assert.match(stale.html, /Sample first task/); assert.doesNotMatch(stale.html, /sample watcher failure/);
  renameSync(f.root, join(f.dir, "old-source"));
  await stream.next(p => p.stale && p.diagnostics.some(d => d.message === "ENOENT"));
  populate(f.root, "Sample watcher restored");
  await stream.next(p => !p.stale && p.html.includes("Sample watcher restored"));
});
