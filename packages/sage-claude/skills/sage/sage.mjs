#!/usr/bin/env node
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createStateTool } from "sage-core";

const tool = createStateTool({
  defaultRoot: (env) => join(env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude"), "sage"),
  models: ["opus", "sonnet", "haiku", "fable", "inherit"],
  modelDefaults: { arena_models: "opus,sonnet,sonnet", ...Object.fromEntries(["code-reviewer", "security-reviewer", "ux-reviewer", "qa"].flatMap((role) => ["tiny", "small"].map((size) => [`model.${role}.${size}`, "fable"]))) },
});
export const { SIZES, BLOCKS, RISKS, KINDS, STATES, DEFAULTS, PR, sageRoot, git, projectRoot, optionsOf, slug, worktreeRoot, BRANCH, ofTask, projectName, storeDir, config, cyclesFor, modelFor, read, mergeCheck, sage, withLock, board, answerPaths } = tool;
if (process.argv[1] === fileURLToPath(import.meta.url)) tool.runCli();
