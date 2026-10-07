import { parse } from "es-module-lexer/minimal";

/** Rewrite real ESM imports only, preserving all other source text. */
export function rewriteCoreImports(source, target) {
  const [imports] = parse(source);
  const edits = imports.filter(item => item.n === "sage-core").map(item => ({
    start: item.d === -1 ? item.s - 1 : item.s,
    end: item.d === -1 ? item.e + 1 : item.e,
  })).sort((a, b) => b.start - a.start);
  for (const edit of edits) source = source.slice(0, edit.start) + JSON.stringify(target) + source.slice(edit.end);
  return source;
}
