# Principles

Short working principles for coding agents. The plugin's principles are these files plus pstack's other principles in `upstream/pstack/`, which go in as they are.

## The files

- There is one file for each principle: `<id>.md`.
- The frontmatter has these fields:
  - `id`: the file name;
  - `name`;
  - `applyWhen`: one line;
  - `source`: the credit;
  - `upstream`: for an override of a pstack principle only, the fingerprint of the pstack text it was reviewed against. The weekly sync flags the override when that text changes.
- The body is 200 words or fewer. It gives the rule, when it applies, when it does not, and when to stop.

## Credit

Fifteen principles here override pstack's, by Lauren Tan (MIT), at [github.com/cursor/plugins](https://github.com/cursor/plugins). The licence is in [LICENSE-pstack](LICENSE-pstack). Each file's `source` names the original. The texts are shortened and rewritten, and some change the meaning on purpose, for example with a Stop rule.

"Contextualize and write for the reader" is this kit's own.

Thank you to Lauren Tan for pstack. Its principles inspired this collection.
