// Standalone browser check. Provide Playwright through NODE_PATH; do not add it to the default test command.
// Example: NODE_PATH="$PLAYWRIGHT_MODULES" BOARD_BROWSER_CHANNEL=chrome node --test scripts/board-enhancement.test.mjs
import "./test-env.mjs";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { createServer as createPortServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { buildBoardModel } from "../plugins/sage/core/board-model.mjs";
import { renderBoardHtml } from "../plugins/sage/core/board-render.mjs";
import { createBoardServer } from "../packages/sage-board/server.mjs";

const require = createRequire(import.meta.url);
const { chromium } = require("playwright");
const NOW = "2026-10-08T20:00:00Z";
let browser;
before(async () => { browser = await chromium.launch({ channel: process.env.BOARD_BROWSER_CHANNEL ?? "chrome", headless: true }); });
after(async () => { await browser?.close(); });

function model({ gamma = null, delta = false, current = false } = {}) {
  const task = (id, title, state) => ({ id, title, state, size: "small", risk: "", route: "build,code-review,qa", branch: "", pr: "", round: "0", keys: "" });
  const project = (name, tasks, gates = []) => ({ key: `sample/${name}-abcdef`, name: `${name}-abcdef`, diagnostics: [], tables: { tasks, gates } });
  const projects = [
    project("alpha", [task("T1", "Sample alpha queued", "framed"), task("T2", "Sample alpha review", "reviewing")], [{ id: "G1", task: "T2", question: "Sample: accept the result?", options: "yes|no", recommendation: "yes", answer: "" }]),
    project("beta", [task("T3", "Sample beta held", "held"), task("T4", "Sample beta work", "building")]),
  ];
  if (current) {
    const head = "a".repeat(40);
    projects[0].tables.tasks[1].pr = "7";
    projects[0].tables.runs = [{ id: "R1", task: "T2", role: "code-reviewer", status: "running", started: NOW, tokens: "1200" }];
    projects[0].observations = { records: [
      { id: "O1", task: "T2", kind: "pr", source: "Sample recorder", observedAt: NOW, data: { number: 7, state: "open", head, repository: "https://example.test/sample/sage" } },
      { id: "O2", task: "T2", kind: "run", source: "Sample recorder", observedAt: NOW, data: { run: "R1", provider: "Codex", head, cycle: 1 } },
    ] };
  }
  if (gamma) projects.push(project("gamma", [task("T5", "Sample gamma work", gamma)]));
  if (delta) projects.push(project("delta", [task("T6", "Sample delta queued", "framed")]));
  return buildBoardModel([{ id: "sample", label: "Sample source", diagnostics: [], projects }], { now: NOW });
}

async function pageFor(t, { live = false, snapshot = !live, scripts = true, phone = false, current = false } = {}) {
  const context = await browser.newContext({ javaScriptEnabled: scripts, viewport: phone ? { width: 390, height: 844 } : { width: 1280, height: 900 } });
  t.after(() => context.close());
  await context.route("**/*", route => route.abort());
  const page = await context.newPage();
  if (live) {
    // Only the transport is a fixture. The renderer's actual script handles the event and changes the real DOM.
    await page.evaluate(() => {
      window.EventSource = class extends EventTarget {
        constructor() { super(); window.sampleBoardStream = this; }
        close() {}
      };
    });
  }
  await page.setContent(renderBoardHtml(model({ current }), { live, snapshot }));
  return page;
}

const visibleCards = async page => (await page.locator(".card:not([hidden]) h3").allTextContents()).sort();
const needsButton = page => page.getByRole("button", { name: /^Needs you / });
async function update(page, data) {
  await page.evaluate(html => window.sampleBoardStream.dispatchEvent(new MessageEvent("board", { data: JSON.stringify({ html, stale: false }) })), renderBoardHtml(data, { snapshot: false, live: true }));
  assert.equal(await page.locator("#live-state").textContent(), "Live updates connected.");
}

test("T205: real DOM keeps selection and theme across live project and count changes", async t => {
  const page = await pageFor(t, { live: true });
  assert.deepEqual(await visibleCards(page), ["T1 · Sample alpha queued", "T2 · Sample alpha review", "T3 · Sample beta held", "T4 · Sample beta work"]);
  assert.equal(await page.locator("#light").isChecked(), false);
  await page.locator("#light").check();
  await page.getByRole("button", { name: "alpha", exact: true }).click();
  await needsButton(page).click();
  assert.deepEqual(await visibleCards(page), ["T2 · Sample alpha review"]);

  await update(page, model({ gamma: "held" }));
  assert.equal(await page.getByRole("button", { name: "alpha", exact: true }).getAttribute("aria-pressed"), "true");
  assert.equal(await needsButton(page).getAttribute("aria-pressed"), "true");
  assert.equal(await needsButton(page).textContent(), "Needs you (3)");
  assert.equal(await page.locator("#board-summary").textContent(), "3 need you · 0 recorded agents · 0 inferred PRs · 1 in review");
  assert.deepEqual(await visibleCards(page), ["T2 · Sample alpha review"]);
  assert.equal(await page.locator("#light").isChecked(), true);
  assert.equal(await page.locator("body").evaluate(body => getComputedStyle(body).getPropertyValue("--bg").trim()), "#fafafa");

  // This button did not exist when the script first ran; a direct listener on the old buttons cannot handle it.
  await page.getByRole("button", { name: "gamma", exact: true }).click();
  assert.deepEqual(await visibleCards(page), ["T5 · Sample gamma work"]);
  await update(page, model({ gamma: "building" }));
  assert.equal(await needsButton(page).textContent(), "Needs you (2)");
  assert.deepEqual(await visibleCards(page), []);
  await needsButton(page).click();
  assert.deepEqual(await visibleCards(page), ["T5 · Sample gamma work"]);

  await update(page, model({ delta: true }));
  assert.equal(await page.getByRole("button", { name: "gamma", exact: true }).count(), 0);
  assert.equal(await page.getByRole("button", { name: "All projects", exact: true }).getAttribute("aria-pressed"), "true");
  assert.equal(await needsButton(page).getAttribute("aria-pressed"), "false");
  assert.deepEqual(await visibleCards(page), ["T1 · Sample alpha queued", "T2 · Sample alpha review", "T3 · Sample beta held", "T4 · Sample beta work", "T6 · Sample delta queued"]);
  assert.equal(await page.locator("#light").isChecked(), true);
  await page.getByRole("button", { name: "delta", exact: true }).click();
  assert.deepEqual(await visibleCards(page), ["T6 · Sample delta queued"]);
});

test("T205: phone filtering puts visible owner work first and removes empty columns", async t => {
  const page = await pageFor(t, { live: true, phone: true });
  await page.getByRole("button", { name: "alpha", exact: true }).click();
  const columnOrder = () => page.locator(".column").evaluateAll(columns => columns
    .filter(column => getComputedStyle(column).display !== "none")
    .sort((a, b) => a.getBoundingClientRect().top - b.getBoundingClientRect().top)
    .map(column => column.querySelector("h2").textContent.replace(/ \(\d+\)$/, "")));
  assert.deepEqual(await columnOrder(), ["In review", "Backlog"]);
  assert.deepEqual(await visibleCards(page), ["T1 · Sample alpha queued", "T2 · Sample alpha review"]);
  await needsButton(page).click();
  assert.deepEqual(await columnOrder(), ["In review"]);
  assert.deepEqual(await visibleCards(page), ["T2 · Sample alpha review"]);
  await update(page, model({ gamma: "held" }));
  assert.deepEqual(await columnOrder(), ["In review"]);
  await page.getByRole("button", { name: "gamma", exact: true }).click();
  assert.deepEqual(await columnOrder(), ["Building"]);
  assert.deepEqual(await visibleCards(page), ["T5 · Sample gamma work"]);
  await update(page, model({ gamma: "building" }));
  assert.deepEqual(await columnOrder(), []);
  await needsButton(page).click();
  assert.deepEqual(await columnOrder(), ["Building"]);
  assert.equal(await page.locator(".column.attention:not(.empty)").count(), 0);
});

test("T205: offline task anchors open details and initial cards remain usable with scripts off", async t => {
  const page = await pageFor(t);
  const title = page.getByRole("link", { name: "T2 · Sample alpha review", exact: true });
  const href = await title.getAttribute("href");
  assert.match(href, /^#detail-/);
  const detail = page.locator(href);
  assert.equal(await detail.evaluate(element => element.open), false);
  await title.click();
  assert.equal(await detail.evaluate(element => element.open), true);
  assert.equal(await detail.getByRole("heading", { name: "Brief", exact: true }).isVisible(), true);

  const plain = await pageFor(t, { scripts: false });
  assert.deepEqual(await visibleCards(plain), ["T1 · Sample alpha queued", "T2 · Sample alpha review", "T3 · Sample beta held", "T4 · Sample beta work"]);
  const plainDetail = plain.locator(href);
  await plainDetail.locator("summary").click();
  assert.equal(await plainDetail.getByRole("heading", { name: "Agent runs", exact: true }).isVisible(), true);
  assert.equal(await plainDetail.getByText("No runs recorded.", { exact: true }).isVisible(), true);
  await plain.locator("#light").check();
  assert.equal(await plain.locator("body").evaluate(body => getComputedStyle(body).getPropertyValue("--bg").trim()), "#fafafa");
});

test("T205: sample desktop and phone text meets 4.5 contrast in both themes", async t => {
  const artifactDir = process.env.BOARD_BROWSER_ARTIFACT_DIR;
  if (artifactDir) mkdirSync(artifactDir, { recursive: true });
  const evidence = [];
  for (const phone of [false, true]) {
    const page = await pageFor(t, { phone, snapshot: false, current: true });
    if (!phone) await page.setViewportSize({ width: 1600, height: 1000 });
    await page.evaluate(() => {
      const label = document.createElement("aside");
      label.textContent = "SAMPLE DATA · Browser QA fixture · No live task data";
      label.setAttribute("style", "padding:10px 20px;background:#ffec99;color:#171717;font:700 14px system-ui");
      document.body.prepend(label);
    });
    for (const theme of ["dark", "light"]) {
      if (theme === "light") await page.locator("#light").check();
      const measurements = await page.evaluate(() => {
        const rgba = text => {
          const values = text.match(/[\d.]+/g).map(Number);
          return [...values.slice(0, 3), values[3] ?? 1];
        };
        const over = (front, back) => front.slice(0, 3).map((value, i) => value * front[3] + back[i] * (1 - front[3]));
        const luminance = rgb => rgb.map(value => value / 255).map(value => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4).reduce((sum, value, i) => sum + value * [0.2126, 0.7152, 0.0722][i], 0);
        return [
          ["normal", ".card p:not([class])"],
          ["muted", ".card .muted"],
          ["link", ".card h3 a"],
          ["needs", ".needs-reason"],
          ["current", ".step.running"],
        ].map(([kind, selector]) => {
          const element = document.querySelector(selector);
          if (!element) throw new Error(`No sample ${kind} text`);
          const backgrounds = [];
          for (let node = element; node; node = node.parentElement) {
            const style = getComputedStyle(node);
            if (style.backgroundImage !== "none") throw new Error(`An image needs a separate contrast check: ${kind}`);
            backgrounds.push(rgba(style.backgroundColor));
          }
          const background = backgrounds.reverse().reduce((color, layer) => over(layer, color), [255, 255, 255]);
          const foreground = over(rgba(getComputedStyle(element).color), background);
          const values = [luminance(foreground), luminance(background)].sort((a, b) => a - b);
          return { kind, text: element.textContent, foreground, background, ratio: (values[1] + 0.05) / (values[0] + 0.05) };
        });
      });
      assert.deepEqual(measurements.map(item => item.kind), ["normal", "muted", "link", "needs", "current"]);
      for (const item of measurements) assert.ok(item.ratio >= 4.5, `${phone ? "phone" : "desktop"} ${theme} ${item.kind}: ${item.ratio}`);
      const viewport = phone ? "phone" : "desktop";
      evidence.push({ viewport, theme, measurements });
      if (artifactDir) await page.screenshot({ path: join(artifactDir, `sample-${viewport}-${theme}.png`), fullPage: true });
    }
  }
  if (artifactDir) writeFileSync(join(artifactDir, "contrast.json"), JSON.stringify({ sampleData: true, node: process.version, playwright: require("playwright/package.json").version, browser: browser.version(), evidence }, null, 2) + "\n");
});

test("T205: real browser authenticates pages and live streams, watches files, and reconnects", async t => {
  const dir = mkdtempSync(join(tmpdir(), "sage-board-browser-server-"));
  const root = join(dir, "sample-source"), project = join(root, "project-abcdef");
  mkdirSync(project, { recursive: true });
  const headers = {
    tasks: "id title size risk route state branch pr round keys",
    runs: "id task role round candidate branch status tokens report started ended",
    findings: "task key round source severity summary triage reason status",
    ledger: "task pr sha kind cycle run at",
    gates: "id task question options recommendation default answer at",
    decisions: "at task decision why",
  };
  for (const [name, header] of Object.entries(headers)) writeFileSync(join(project, `${name}.tsv`), `${header.replaceAll(" ", "\t")}\n`);
  const taskFile = join(project, "tasks.tsv");
  const table = title => `${headers.tasks.replaceAll(" ", "\t")}\nT1\t${title}\tsmall\t\tbuild\tbuilding\tcodex/sample\t\t0\t\nT2\tSample held task\tsmall\t\tbuild\theld\tcodex/sample-held\t\t0\t\n`;
  const replaceTasks = title => {
    const temporary = join(project, "tasks.next");
    writeFileSync(temporary, table(title));
    renameSync(temporary, taskFile);
  };
  replaceTasks("Sample served task");
  const reservation = createPortServer();
  await new Promise((accept, reject) => { reservation.once("error", reject); reservation.listen(0, "127.0.0.1", accept); });
  const port = reservation.address().port;
  await new Promise((accept, reject) => reservation.close(error => error ? reject(error) : accept()));
  const origin = `http://127.0.0.1:${port}`;
  const options = { sources: [{ id: "sample", path: root, label: "Sample source" }], secret: randomBytes(32).toString("base64url"), port };
  let server = createBoardServer(options), context;
  t.after(async () => {
    try { await context?.close(); } finally {
      try { await server.close(); } finally { rmSync(dir, { recursive: true, force: true }); }
    }
  });
  await server.start();
  context = await browser.newContext({ httpCredentials: { username: "sage", password: options.secret, origin } });
  // Only this isolated server may receive requests. The browser supplies Basic credentials itself.
  await context.route("**/*", route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
  const page = await context.newPage(), responses = [];
  page.on("response", response => {
    if (response.url().startsWith(origin)) responses.push({ path: new URL(response.url()).pathname + new URL(response.url()).search, status: response.status() });
  });
  await page.addInitScript(() => {
    window.samplePolicyViolations = [];
    document.addEventListener("securitypolicyviolation", event => window.samplePolicyViolations.push(event.violatedDirective));
  });
  const initial = await page.goto(origin);
  assert.equal(initial.status(), 200);
  assert.match(initial.headers()["content-security-policy"], /script-src 'sha256-/);
  assert.doesNotMatch(initial.headers()["content-security-policy"], /unsafe-inline/);
  await page.getByText("Live updates connected.", { exact: true }).waitFor();
  assert.deepEqual(await visibleCards(page), ["T1 · Sample served task", "T2 · Sample held task"]);
  assert.equal(await page.locator("body").evaluate(body => getComputedStyle(body).backgroundColor), "rgb(18, 18, 18)");
  assert.deepEqual(await page.evaluate(() => window.samplePolicyViolations), []);
  assert.ok(responses.some(response => response.path === "/?events=1" && response.status === 200));
  assert.equal(readFileSync(taskFile, "utf8"), table("Sample served task"));

  await page.evaluate(() => { window.sampleDocumentMarker = "sample-board-document"; });
  replaceTasks("Sample watched replacement");
  await page.getByRole("link", { name: "T1 · Sample watched replacement", exact: true }).waitFor();
  assert.equal(await page.evaluate(() => window.sampleDocumentMarker), "sample-board-document");
  assert.deepEqual(await visibleCards(page), ["T1 · Sample watched replacement", "T2 · Sample held task"]);
  await needsButton(page).click();
  assert.deepEqual(await visibleCards(page), ["T2 · Sample held task"]);
  await needsButton(page).click();

  writeFileSync(taskFile, "Sample invalid table header\nSample incomplete write\n");
  await page.getByText("Update failed; showing the last valid snapshot.", { exact: true }).waitFor();
  assert.deepEqual(await visibleCards(page), ["T1 · Sample watched replacement", "T2 · Sample held task"]);
  assert.doesNotMatch(await page.locator("#board-content").textContent(), /Sample incomplete write/);
  replaceTasks("Sample restored task");
  await page.getByRole("link", { name: "T1 · Sample restored task", exact: true }).waitFor();
  await page.getByText("Live updates connected.", { exact: true }).waitFor();

  const taskPath = `/task/${Buffer.from("sample/project-abcdef/T1").toString("base64url")}`;
  await Promise.all([page.waitForURL(origin + taskPath), page.getByRole("link", { name: "T1 · Sample restored task", exact: true }).click()]);
  await page.getByRole("heading", { name: "T1 · Sample restored task", exact: true }).waitFor();
  await page.getByText("Live updates connected.", { exact: true }).waitFor();
  assert.equal(await page.getByRole("heading", { name: "Agent runs", exact: true }).isVisible(), true);
  assert.ok(responses.some(response => response.path === taskPath && response.status === 200));
  assert.ok(responses.some(response => response.path === `/?events=1&task=${taskPath.slice(6)}` && response.status === 200));
  assert.deepEqual(await page.evaluate(() => window.samplePolicyViolations), []);
  await page.evaluate(() => { window.sampleDocumentMarker = "sample-task-document"; });
  replaceTasks("Sample task live change");
  await page.getByRole("heading", { name: "T1 · Sample task live change", exact: true }).waitFor();
  assert.equal(await page.evaluate(() => window.sampleDocumentMarker), "sample-task-document");

  await server.close();
  await page.getByText("Connection lost; showing the last snapshot. Reconnecting.", { exact: true }).waitFor();
  assert.equal(await page.getByRole("heading", { name: "T1 · Sample task live change", exact: true }).isVisible(), true);
  replaceTasks("Sample reconnected task");
  server = createBoardServer(options);
  await server.start();
  await page.getByRole("heading", { name: "T1 · Sample reconnected task", exact: true }).waitFor();
  await page.getByText("Live updates connected.", { exact: true }).waitFor();
  assert.equal(page.url(), origin + taskPath);
  assert.equal(await page.evaluate(() => window.sampleDocumentMarker), "sample-task-document");
  assert.deepEqual(await page.evaluate(() => window.samplePolicyViolations), []);
  assert.equal(readFileSync(taskFile, "utf8"), table("Sample reconnected task"));
});
