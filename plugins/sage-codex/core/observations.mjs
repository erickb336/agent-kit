// Optional board evidence. It supplements old tables; it never supplies a merge verdict or live process claim.
export const OBSERVATIONS_MAX_BYTES = 4 * 1024 * 1024;
export const OBSERVATION_DATA_MAX_BYTES = 64 * 1024;
const fail = reason => { throw new TypeError(`observation ${reason}`); };
const shapes = {
  pr: [["repository", "number", "state", "head"], []],
  run: [["run", "provider"], ["head", "cycle"]],
  completion: [["state", "at"], []],
  mode: [["session", "autopilot"], []],
  artifact: [["type", "label"], ["run", "url", "path", "sha256"]],
};
const object = (value, required, optional = []) => {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail("must be an object");
  if (required.some(key => !Object.hasOwn(value, key)) || Object.keys(value).some(key => !required.includes(key) && !optional.includes(key))) fail("has missing or unknown fields");
};
const text = (value, name, max) => {
  if (typeof value !== "string" || !value.trim() || value !== value.trim() || Buffer.byteLength(value) > max || /[\p{Cc}\p{Cf}]/u.test(value)) fail(`${name} must be bounded text without control characters`);
  return value;
};
const instant = (value, name) => {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value)) fail(`${name} must be an ISO UTC timestamp`);
  const time = Date.parse(value);
  if (!Number.isFinite(time) || new Date(time).toISOString() !== value.replace(/(?<=:\d{2})Z$/, ".000Z")) fail(`${name} must be a valid ISO UTC timestamp`);
  return new Date(time).toISOString();
};
const choice = (value, values, name) => { if (!values.includes(value)) fail(`${name} is not supported`); return value; };
const id = (value, prefix) => { if (typeof value !== "string" || !new RegExp(`^${prefix}[1-9]\\d*$`).test(value) || value.length > 32) fail(`needs a ${prefix} id`); return value; };
const digest = (value, size, name) => { if (typeof value !== "string" || !new RegExp(`^[0-9a-fA-F]{${size}}$`).test(value)) fail(`${name} needs ${size} hexadecimal characters`); return value.toLowerCase(); };
const https = (value, name) => {
  text(value, name, 2048);
  let url;
  try { url = new URL(value); } catch { fail(`${name} must be an HTTPS URL`); }
  if (url.protocol !== "https:" || url.username || url.password || value.includes("\\")) fail(`${name} must be HTTPS without credentials or backslashes`);
  return url.href;
};

/** Validate and canonicalize one recorded fact. No file, process, provider or network access occurs here. */
export function validateObservation(value, { now = Date.now() } = {}) {
  object(value, ["id", "task", "kind", "source", "basis", "observedAt", "recordedAt", "data"]);
  if (!Object.hasOwn(shapes, value.kind)) fail("kind is not supported");
  const observedAt = instant(value.observedAt, "observedAt"), recordedAt = instant(value.recordedAt, "recordedAt");
  if (!Number.isFinite(now) || Date.parse(recordedAt) > now || Date.parse(observedAt) > Date.parse(recordedAt)) fail("timestamps must not be in the future or after recording");
  const [required, optional] = shapes[value.kind];
  object(value.data, required, optional);
  if (Buffer.byteLength(JSON.stringify(value.data)) > OBSERVATION_DATA_MAX_BYTES) fail("data exceeds 64 KiB");
  const data = { ...value.data };
  switch (value.kind) {
    case "pr":
      data.repository = https(data.repository, "repository");
      if (new URL(data.repository).search || new URL(data.repository).hash) fail("repository must not contain a query or fragment");
      if (!Number.isSafeInteger(data.number) || data.number < 1) fail("PR number must be a positive whole number");
      choice(data.state, ["open", "closed", "merged"], "PR state");
      data.head = digest(data.head, 40, "head");
      break;
    case "run":
      id(data.run, "R");
      if (typeof data.provider !== "string" || !/^[a-z][a-z0-9-]{0,63}$/.test(data.provider)) fail("provider must be a lowercase identifier");
      if (data.head !== undefined) data.head = digest(data.head, 40, "head");
      if (data.cycle !== undefined && (!Number.isSafeInteger(data.cycle) || data.cycle < 1)) fail("cycle must be a positive whole number");
      break;
    case "completion":
      choice(data.state, ["merged", "concluded", "abandoned"], "completion state");
      data.at = instant(data.at, "completion time");
      if (Date.parse(data.at) > Date.parse(observedAt)) fail("completion time must not follow its observation");
      break;
    case "mode":
      text(data.session, "session", 200);
      if (typeof data.autopilot !== "boolean") fail("autopilot must be true or false");
      break;
    case "artifact": {
      choice(data.type, ["brief", "report", "proof", "issue", "artifact"], "artifact type");
      text(data.label, "label", 200);
      if (data.run !== undefined) id(data.run, "R");
      if ((data.url === undefined) === (data.path === undefined)) fail("artifact needs exactly one URL or local path");
      if (data.url !== undefined) {
        data.url = https(data.url, "artifact URL");
        if (data.sha256 !== undefined) fail("a digest belongs to a local artifact path");
      } else {
        text(data.path, "artifact path", 1024);
        const parts = data.path.split("/");
        if (!['briefs', 'reports', 'artifacts'].includes(parts[0]) || parts.length < 2 || parts.some(part => !part || part === "." || part === "..") || data.path.includes("\\")) fail("artifact path must stay under briefs, reports or artifacts");
        data.sha256 = digest(data.sha256, 64, "artifact sha256");
      }
      break;
    }
  }
  return { id: id(value.id, "O"), task: id(value.task, "T"), kind: value.kind, source: text(value.source, "source", 200), basis: choice(value.basis, ["observed", "reported"], "basis"), observedAt, recordedAt, data };
}

/** A missing sidecar is handled by its reader. A present file must contain this complete versioned schema. */
export function validateObservations(value, options = {}) {
  object(value, ["version", "records"]);
  if (value.version !== 1 || !Array.isArray(value.records) || Buffer.byteLength(JSON.stringify(value)) > OBSERVATIONS_MAX_BYTES) fail("file needs version 1 and at most 4 MiB of records");
  const records = value.records.map((record, index) => {
    const checked = validateObservation(record, options);
    if (checked.id !== `O${index + 1}`) fail("record identities must be sequential and unique");
    return checked;
  });
  return { version: 1, records };
}
