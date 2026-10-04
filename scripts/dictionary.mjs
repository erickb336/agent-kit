// sage's words have one source: writing/dictionary.md. From its body come the README's word table (scripts/build.mjs)
// and the flagged words that `npm run check` fails on (scripts/check.mjs).

const section = (body, heading) => body.split(/^## /m).find((s) => s.startsWith(`${heading}\n`)) ?? "";
/** The rows of the table under a heading, as cells, with the bold markers of the first cell removed. */
const rows = (body, heading) => section(body, heading).split("\n").filter((l) => l.startsWith("| **"))
  .map((l) => l.slice(1, -1).split(" | ").map((c) => c.trim())).map(([w, ...rest]) => [w.replace(/\*\*/g, ""), ...rest]);

/** The README's word table: each word, then each name, with its meaning. */
export function wordTable(body) {
  const line = ([w, meaning]) => `| **${w[0].toUpperCase()}${w.slice(1)}** | ${meaning} |`;
  return ["| Word | Meaning |", "| --- | --- |", ...rows(body, "Words").map(line), ...rows(body, "Names").map(line)].join("\n");
}

export const TABLE_START = "<!-- The word table comes from writing/dictionary.md: edit it there, then run npm run build. -->";
export const TABLE_END = "<!-- The end of the word table. -->";
/** The README with its word table replaced by a new one. */
export function withWordTable(readme, table) {
  const i = readme.indexOf(TABLE_START), j = readme.indexOf(TABLE_END);
  if (i < 0 || j < i) throw new Error(`README.md: the word table needs the lines ${TABLE_START} and ${TABLE_END}`);
  return `${readme.slice(0, i + TABLE_START.length)}\n\n${table}\n\n${readme.slice(j)}`;
}

const pattern = (w) => w.replace(/[- ]/g, "[- ]?");
/** The check's words: the flagged words, the allowed names, and for each flagged word the approved words to use. */
export function checkWords(body) {
  const list = (key) => (new RegExp(`^\\*\\*${key}:\\*\\*\\s*(.+)$`, "m").exec(body)?.[1] ?? "").split(", ").map((s) => s.replace(/ \(.*$/, "").trim()).filter(Boolean);
  const words = list("Flagged");
  const use = new Map(words.map((f) => [f, rows(body, "Words").filter(([, , not]) => not.split(/[,;]/).some((n) => n.trim().replace(/ \(.*$/, "") === f)).map(([w]) => w)]));
  return { words, allowed: list("Allowed names"), use };
}

const blank = (s) => s.replace(/[^\n]/g, " ");
/** The text that a person reads, with the parts a flagged word may be in blanked out, so that line numbers stay. */
function prose(text, html) {
  let t = text.replace(/^(description:\s*)(".*")$/m, (all, key, value) => key + JSON.parse(value)); // a YAML description, without its own quotes
  if (html) t = t.replace(/<(script|style|code)\b[\s\S]*?<\/\1>/gi, blank).replace(/<[^>]*>/g, blank);
  return t
    .replace(/^[ \t]*```[\s\S]*?^[ \t]*```/gm, blank) // code blocks
    .replace(/`[^`\n]*`/g, blank) // code spans
    .replace(/\]\([^)\n]*\)/g, blank) // link URLs
    .replace(/\b(?:href|src|srcset)="[^"\n]*"/g, blank) // URLs in HTML
    .replace(/(?<!=)"[^"\n]*"|“[^”\n]*”/g, blank); // quotes, but not an attribute value such as an alt text
}

/** Each flagged word, or its plural, in a text: its line, the word as written, and the approved words to use. */
export function flaggedWords(text, { words, allowed, use }, { html = false } = {}) {
  const t = prose(text, html);
  const re = new RegExp(`\\b(?:${words.map(pattern).join("|")})s?\\b`, "gi");
  return [...t.matchAll(re)].filter((m) => !allowed.includes(m[0])).map((m) => {
    const f = words.find((w) => new RegExp(`^${pattern(w)}s?$`, "i").test(m[0]));
    return { line: t.slice(0, m.index).split("\n").length, word: m[0], use: use.get(f) ?? [] };
  });
}
