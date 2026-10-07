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
function readSessionRecords(transcriptPath, { sessionsDir } = {}, count = 1) {
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
    let used = 0, start = 0;
    const ends = [];
    while (used < LIMIT && ends.length < count) {
      const size = readSync(fd, bytes, used, Math.min(4096, LIMIT - used), used);
      if (size === 0) break;
      used += size;
      let end;
      while (ends.length < count && (end = bytes.subarray(start, used).indexOf(10)) >= 0) {
        start += end + 1;
        ends.push(start - 1);
      }
    }
    if (ends.length !== count) refuse();
    let offset = 0;
    const rows = ends.map((end) => {
      const row = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(offset, end)));
      offset = end + 1;
      return row;
    });
    const header = rows[0];
    if (!record(header) || header.type !== "session_meta" || !record(header.payload)) refuse();
    return rows;
  } catch {
    refuse();
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}


const identity = (header) => Object.fromEntries(FIELDS.filter((field) => Object.hasOwn(header.payload, field)).map((field) => [field, header.payload[field]]));

export function readSessionIdentity(transcriptPath, options) {
  return identity(readSessionRecords(transcriptPath, options)[0]);
}

/** Read the initial native turn only. Never infer the current turn from later transcript content. */
export function readInitialSession(transcriptPath, options) {
  const [header, first] = readSessionRecords(transcriptPath, options, 2);
  if (!record(first) || first.type !== "event_msg" || !record(first.payload) || first.payload.type !== "task_started"
    || typeof first.payload.turn_id !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(first.payload.turn_id)) refuse();
  return { metadata: identity(header), turn: first.payload.turn_id };
}
