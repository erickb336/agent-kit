#!/usr/bin/env node
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createStateTool } from "../../core/index.mjs";

// Codex inherits the selected model. Its logbook is separate unless SAGE_HOME is explicit.
export const tool = createStateTool({ defaultRoot: (env) => join(env.CODEX_HOME ?? join(homedir(), ".codex"), "sage") });
if (process.argv[1] === fileURLToPath(import.meta.url)) tool.runCli();
