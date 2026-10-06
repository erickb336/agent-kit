// Read only the bounded first native session record. This does not authenticate a hook caller.
import { constants, openSync, closeSync, fstatSync, lstatSync, readSync } from "node:fs";
import { isAbsolute, normalize, parse, relative, resolve, sep } from "node:path";
import { TextDecoder } from "node:util";

const LIMIT = 256 * 1024;
const FIELDS = ["id", "session_id", "parent_thread_id", "agent_path", "cli_version"];
const record = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const pathValue = (value) => typeof value === "string" && value.length <= 4096 && isAbsolute(value)
  && normalize(value) === value && !/\p{Cc}/u.test(value);
const refuse = () => { throw new Error("Codex session identity is unavailable"); };

/** sessionsDir must be a trusted, canonical native profile directory supplied by the caller. */
export function readSessionIdentity(transcriptPath, { sessionsDir } = {}) {
  let fd;
  try {
    if (!pathValue(sessionsDir) || !pathValue(transcriptPath)) refuse();
    const child = relative(sessionsDir, transcriptPath);
    if (!child || child === ".." || child.startsWith(`..${sep}`) || isAbsolute(child)) refuse();
    // Refuse links in every component, including the caller's directory.
    let cursor = parse(transcriptPath).root;
    const components = transcriptPath.slice(cursor.length).split(sep);
    for (let index = 0; index < components.length; index++) {
      cursor = resolve(cursor, components[index]);
      const stat = lstatSync(cursor);
      if (stat.isSymbolicLink() || (index < components.length - 1 && !stat.isDirectory())) refuse();
    }
    fd = openSync(transcriptPath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    if (!fstatSync(fd).isFile()) refuse();
    const bytes = Buffer.alloc(LIMIT);
    let used = 0, end = -1;
    while (used < LIMIT && end < 0) {
      const count = readSync(fd, bytes, used, Math.min(4096, LIMIT - used), used);
      if (count === 0) break;
      end = bytes.subarray(used, used + count).indexOf(10);
      if (end >= 0) end += used;
      used += count;
    }
    if (end < 0) refuse();
    const header = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, end)));
    if (!record(header) || header.type !== "session_meta" || !record(header.payload)) refuse();
    return Object.fromEntries(FIELDS.filter((field) => Object.hasOwn(header.payload, field)).map((field) => [field, header.payload[field]]));
  } catch {
    refuse();
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}
