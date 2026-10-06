// Read-only native packaging check: no installation, configuration writes or model turn.
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { ROOT } from "./build.mjs";

const binary = process.env.SAGE_CODEX_BIN ?? "codex";
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("CODEX_FLORA_CCA_") && !["CODEX_EXEC_SERVER_REMOTE", "CODEX_SESSION_ID", "CODEX_THREAD_ID", "CODEX_ENVIRONMENT_ID"].includes(key)));
const version = execFileSync(binary, ["--version"], { encoding: "utf8", timeout: 5000 }).trim();
const child = spawn(binary, ["app-server", "-c", 'cli_auth_credentials_store="ephemeral"', "-c", "features.remote_plugins=false", "-c", "features.plugin_hooks=true", "-c", "features.codex_hooks=true"], { env, stdio: ["pipe", "pipe", "ignore"] });
const send = (method, params, id) => child.stdin.write(JSON.stringify({ method, params, ...(id === undefined ? {} : { id }) }) + "\n");
let buffer = "";
let finished = false;
let kill;
const finish = (error) => {
  if (finished) return;
  finished = true;
  clearTimeout(timer);
  if (error) { console.error(`Codex package check failed: ${error.message}`); process.exitCode = 1; }
  child.kill("SIGTERM");
  kill = setTimeout(() => child.kill("SIGKILL"), 2000);
};
const timer = setTimeout(() => finish(new Error("plugin/read timed out; native discovery is unverified")), 25000);
child.on("error", finish);
child.on("close", () => {
  clearTimeout(kill);
  if (!finished) finish(new Error("app server exited before plugin/read completed"));
});
child.stdin.on("error", finish);
child.stdout.on("data", (data) => {
  buffer += data.toString();
  if (buffer.length > 2 * 1024 * 1024) return finish(new Error("app server output exceeded the check's limit"));
  while (buffer.includes("\n")) {
    const end = buffer.indexOf("\n");
    const line = buffer.slice(0, end);
    buffer = buffer.slice(end + 1);
    try {
      const reply = JSON.parse(line);
      if (reply.id !== 1 && reply.id !== 2) continue;
      if (reply.error) throw new Error(reply.error.message);
      if (reply.id === 1) {
        send("initialized", {});
        send("plugin/read", { marketplacePath: join(ROOT, ".agents/plugins/marketplace.json"), pluginName: "sage" }, 2);
      } else {
        const plugin = reply.result.plugin;
        const expected = readdirSync(join(ROOT, "plugins/sage-codex/skills")).map((name) => `sage:${name}`).sort();
        assert.deepEqual(plugin.skills.map((skill) => skill.name).sort(), expected);
        assert.deepEqual(plugin.hooks.map((hook) => hook.eventName).sort(), ["preToolUse", "userPromptSubmit"]);
        assert.equal(plugin.summary.source.path, join(ROOT, "plugins/sage-codex"));
        console.log(`${version}: discovered ${expected.length} skills and 2 hooks from the Codex package. No model turn or install was attempted.`);
        finish();
      }
    } catch (error) { finish(error); }
  }
});
send("initialize", { clientInfo: { name: "sage-package-check", version: "0.1.0" }, capabilities: { experimentalApi: true } }, 1);
