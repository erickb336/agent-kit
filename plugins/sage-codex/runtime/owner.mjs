// Classify the captured local Codex root prompt path; this does not activate a mode.
import { isAbsolute } from "node:path";
import { RUNTIME_VERSION } from "./events.mjs";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const FIELDS = ["cwd", "hook_event_name", "model", "permission_mode", "prompt", "session_id", "transcript_path", "turn_id"];
const START_FIELDS = ["cwd", "hook_event_name", "model", "permission_mode", "session_id", "source", "transcript_path"];
const record = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const text = (value, limit) => typeof value === "string" && value.length > 0 && value.length <= limit && !/\p{Cc}/u.test(value);

/** The caller supplies native hook input and independently checked runtime/metadata. */
export function ownerPrompt(input, options) {
  if (options?.version !== RUNTIME_VERSION || !record(input) || input.hook_event_name !== "UserPromptSubmit") return null;
  if (Object.keys(input).length !== FIELDS.length || FIELDS.some((key) => !Object.hasOwn(input, key))) return null;
  if (!text(input.session_id, 36) || !UUID.test(input.session_id) || !text(input.turn_id, 36) || !UUID.test(input.turn_id)
    || !text(input.cwd, 4096) || !isAbsolute(input.cwd) || !text(input.transcript_path, 4096) || !isAbsolute(input.transcript_path)
    || !text(input.model, 256) || !text(input.permission_mode, 64)
    || typeof input.prompt !== "string" || Buffer.byteLength(input.prompt, "utf8") > 1024 * 1024) return null;
  const metadata = options.metadata;
  if (!record(metadata) || metadata.id !== input.session_id || metadata.session_id !== input.session_id
    || metadata.cli_version !== RUNTIME_VERSION || Object.hasOwn(metadata, "parent_thread_id") || Object.hasOwn(metadata, "agent_path")) return null;
  return { kind: "owner-prompt", session: input.session_id, turn: input.turn_id, text: input.prompt };
}

/** Creation-version evidence only for the captured fresh-root SessionStart callback. */
export function freshRuntime(input, { metadata } = {}) {
  if (!record(input) || input.hook_event_name !== "SessionStart" || input.source !== "startup") return null;
  if (Object.keys(input).length !== START_FIELDS.length || START_FIELDS.some((key) => !Object.hasOwn(input, key))) return null;
  if (!text(input.session_id, 36) || !UUID.test(input.session_id)
    || !text(input.cwd, 4096) || !isAbsolute(input.cwd) || !text(input.transcript_path, 4096) || !isAbsolute(input.transcript_path)
    || !text(input.model, 256) || !text(input.permission_mode, 64)) return null;
  if (!record(metadata) || metadata.id !== input.session_id || metadata.session_id !== input.session_id
    || metadata.cli_version !== RUNTIME_VERSION || Object.hasOwn(metadata, "parent_thread_id") || Object.hasOwn(metadata, "agent_path")) return null;
  return { kind: "fresh-runtime", session: input.session_id, version: metadata.cli_version };
}


/** Bind fresh creation evidence to its first native turn, without reusable session authority. */
export function initialRuntime(input, { metadata, turn } = {}) {
  const runtime = freshRuntime(input, { metadata });
  if (!runtime || !text(turn, 36) || !UUID.test(turn)) return null;
  return { ...runtime, kind: "initial-runtime", turn };
}

export function initialOwnerPrompt(input, { runtime, metadata } = {}) {
  if (!record(runtime) || runtime.kind !== "initial-runtime" || runtime.session !== input?.session_id || runtime.turn !== input?.turn_id) return null;
  return ownerPrompt(input, { version: runtime.version, metadata });
}
