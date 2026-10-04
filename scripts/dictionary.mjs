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

/** A flagged word as a pattern: a hyphen, a space or a line break between its parts, or none. */
const pattern = (w) => w.replace(/[- ]/g, "(?:-|\\s+)?");
/** The check's words: the flagged words, the allowed names, and for each flagged word the approved words to use. */
export function checkWords(body) {
  const list = (key) => (new RegExp(`^\\*\\*${key}:\\*\\*\\s*(.+)$`, "m").exec(body)?.[1] ?? "").split(", ").map((s) => /^(.+?)(?: \((.*)\))?$/.exec(s.trim())).filter(Boolean);
  const flagged = list("Flagged");
  const said = (f) => rows(body, "Words").filter(([, , not]) => not.split(/[,;]/).some((n) => n.trim().replace(/ \(.*$/, "") === f)).map(([w]) => w);
  // A flagged word that no word replaces names its replacement itself: "merge gate (say merge check)".
  const use = new Map(flagged.map(([, f, note]) => [f, note?.startsWith("say ") ? [note.slice(4)] : said(f)]));
  return { words: flagged.map(([, f]) => f), allowed: list("Allowed names").map(([, n]) => n), use };
}

/** The text of a one-line YAML value, without its quotes. It reads any escape and never throws: a double-quoted
 * value keeps \" and \\, and each other escape becomes one space; a single-quoted value turns '' into '. */
export function yamlText(value) {
  const v = value.trim();
  if (/^".*"$/.test(v) && v.length > 1) return v.slice(1, -1).replace(/\\(?:(["\\/])|x[0-9a-fA-F]{2}|u[0-9a-fA-F]{4}|U[0-9a-fA-F]{8}|.)/g, (e, c) => c ?? " ");
  if (/^'.*'$/.test(v) && v.length > 1) return v.slice(1, -1).replace(/''/g, "'");
  return v;
}

// A blanked part keeps its line breaks, and its other characters become NUL, not spaces, so that a two-word term
// such as "main agent" never joins across a tag or a code span ("main</td><td>Agents").
const blank = (s) => s.replace(/[^\n]/g, "\0");
/** A tag, blanked except the text of its alt, title and aria-label, which a person reads. */
const tag = (t) => t.replace(/(\s(?:alt|title|aria-label)=)(?:"([^"]*)"|'([^']*)')|[^\n]/gi, (m, key, dq, sq) => (key ? `${blank(key)}\0${dq ?? sq}\0` : "\0"));
/** Markdown's indented code: after a blank line, lines indented 4 or more past the text before them (a list
 * item's text starts after its marker). In a list item, "    code" is still the item's text, as GitHub shows it. */
function indentedCode(text) {
  let base = 0, afterBlank = true, code = false;
  return text.split("\n").map((line) => {
    const indent = line.replace(/\t/g, "    ").search(/\S/);
    if (indent < 0) return (afterBlank = true), line;
    if ((afterBlank || code) && indent >= base + 4) return (code = true), blank(line);
    base = /^\s*(?:[-*+]|\d+[.)])\s+/.exec(line)?.[0].length ?? indent;
    afterBlank = code = false;
    return line;
  }).join("\n");
}

/** The text that a person reads, with the parts a flagged word may be in blanked out, so that line numbers stay. */
function prose(text, html) {
  const t = text.replace(/^---\n[\s\S]*?\n---(?:\n|$)/, (front) => front.replace(/^(description:)(.*)$/m, (all, key, value) => `${key} ${yamlText(value)}`));
  return (html ? t : indentedCode(t))
    .replace(/^[ \t]*(`{3,}|~{3,})[^\n]*\n[\s\S]*?^[ \t]*\1/gm, blank) // fenced code blocks
    .replace(/(`+)(?!`)[^\n]*?(?<!`)\1(?!`)/g, blank) // code spans, with one backtick or more
    .replace(/<pre class="mermaid">[\s\S]*?<\/pre>/g, (m) => m.replace(/"/g, " ")) // a Mermaid label's quotes are syntax
    .replace(/<(script|style|code)\b[\s\S]*?<\/\1>/gi, blank)
    .replace(/<!--[\s\S]*?-->/g, blank)
    .replace(/<[/!]?[A-Za-z](?:[^>"']|"[^"]*"|'[^']*')*>|<https?:[^>\s]*>/g, tag) // tags, and Markdown's autolinks
    .replace(/\]\([^)\n]*\)/g, blank) // link URLs
    // Quotes: double, but not an inch mark (5"); single, but not an apostrophe (it's, the owners'); and curly.
    .replace(/(?<!\d)"[^"\n]*"|“[^”\n]*”|(?<![\p{L}\p{N}])'(?:[^'\n]|'(?=\p{L}))*'(?![\p{L}\p{N}])|‘(?:[^’\n]|’(?=\p{L}))*’/gu, blank);
}

/** Each flagged word, or its plural, in a text: its line, the word as written, and the approved words to use. A word
 * ends at a character that is not a letter or a digit, so _store_ in Markdown's italics counts and storeDir does not. */
export function flaggedWords(text, { words, allowed, use }, { html = false } = {}) {
  const t = prose(text, html);
  const re = new RegExp(`(?<![\\p{L}\\p{N}])(?:${words.map(pattern).join("|")})s?(?![\\p{L}\\p{N}])`, "giu");
  return [...t.matchAll(re)].filter((m) => !allowed.includes(m[0])).map((m) => {
    const f = words.find((w) => new RegExp(`^${pattern(w)}s?$`, "iu").test(m[0]));
    return { line: t.slice(0, m.index).split("\n").length, word: m[0].replace(/\s+/g, " "), use: use.get(f) ?? [] };
  });
}
