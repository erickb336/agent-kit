---
id: readme
name: Write a project README
applyWhen: you write, change or review a README of any project, in any language.
source: this kit's own words, from sage's README (github.com/erickb336/sage) as the worked example, the READMEs that its Examples table credits by link, and the owner's working preferences
---

A README is the front door of a project. A reader arrives cold and decides in a few seconds to stay or leave. Write it so that the first screen answers their questions, and the rest lets them start and go deeper. sage's own [README](https://github.com/erickb336/sage#readme) is the worked example.

**The top 10 lines answer five questions**

1. What is it? One bold sentence: "**<name> is a <kind of thing> that <does what> for <whom>.**"
2. Why use it? The problem it solves, or the main result, in one or two sentences.
3. What does it look like? One graphic or screenshot that shows the main idea.
4. Can I trust it? Only true badges that a machine checks: the CI result and the licence.
5. Where next? A contents line, or a link to the quick start.

**The order of sections**

A project is large when it has more than one kind of user, more than one way in, or a README over 150 lines. Otherwise it is small.

| Section | What it holds | Small | Large |
| --- | --- | --- | --- |
| Title, pitch, graphic | The answers to the five questions | required | required |
| Quick start | Install and a first result in 5 commands or fewer | required | required |
| Usage | Examples of the common jobs, each with what the reader sees | required | required |
| Why | The problem, the alternatives, and when not to use the project | optional | required |
| How it works | A diagram of the parts and the flow, then short text | optional | required |
| What's new | The last 3 to 5 changes, newest first | optional | required |
| Concepts | The project's own words, one meaning each | none | required |
| FAQ | The real questions that users asked | optional | required |
| Under the hood | The folders, how to change the project, and how to run its checks | one line: run the checks | required |
| Credits | The work that the project uses or comes from | when it uses others' work | required |
| Licence | The licence name and a link to its file | required | required |

**Diagrams and graphics**

- Prefer a diagram, then a table, then text. Use a screenshot only for a real screen.
- Draw each diagram from text or code: Mermaid in the README, D2, Graphviz, or a script in the repository. Do not commit a hand-drawn image that nobody can redraw.
- Make a light and a dark version. Show them with `<picture>` and `prefers-color-scheme`. Mermaid follows the reader's theme by itself.
- Give each image an alt text that says what it shows and its main point. "Diagram" alone is not an alt text.
- Check the graphics in CI: the check redraws each one and fails when the file in the repository is different.
- Keep the text in a graphic readable on a phone, where the README column is about 320 px wide.
- Give each graphic one main point, and label its parts with the project's words.
- Use only shapes, logos and characters that the project owns or has a licence for. Never draw another product's logo or a character from a book, film or game.

sage shows each graphic this way. `scripts/graphics.mjs` draws both files, and `npm run check` fails when they differ from its output:

```html
<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/assets/loop-dark.svg">
  <img alt="How sage works: you, the chief of staff, the team (design, build, review, QA), the pull request, the logbook, and the outer loop that seals each lesson." src="docs/assets/loop-light.svg" width="100%">
</picture>
```

**Commands**

- Put each command in a fenced block with its language, for example `sh`.
- Put one command in each block, so that one click copies it.
- Do not put a prompt sign (`$` or `>`) in the block.
- Make each block work as it is. When the reader must change a value, say so before the block, and use a clear placeholder such as `<your-project>`.
- Say where to run the command, and what the reader sees after it.
- Name the systems and the versions that the project needs, in a table when there are more than two.
- Run the quick start in a clean place (a fresh clone or a container) before each release. Better: run it in CI.

**Claims**

- Back each claim such as "fast" or "small" with a measured comparison. Say what you measured and how.
- Say when not to use the project. The reader trusts the rest more.

**Words**

- Follow the writing standard: about 80% of Simplified Technical English.
- Put the main point first in each section.
- Use the project's dictionary words. Explain a new word once, in Concepts or where it first appears.
- Use relative links to files in the repository, and check that each link resolves.

**Examples**

Each of these READMEs does one thing especially well. Read the raw file, and take the lesson, not the text.

| README | Kind | The lesson |
| --- | --- | --- |
| [sage](https://github.com/erickb336/sage#readme) | agent plugin | Graphics drawn by a script in light and dark, checked in CI; a word table for the project's own words |
| [ripgrep](https://github.com/BurntSushi/ripgrep#readme) | CLI tool | A timing table against other tools, with the exact commands; a section on when not to use it |
| [uv](https://github.com/astral-sh/uv#readme) | package manager | A one-line pitch, then a benchmark chart in light and dark with an alt text and a caption that says what it measured |
| [fzf](https://github.com/junegunn/fzf#readme) | CLI tool | A table of install commands, one row for each package manager |
| [FastAPI](https://github.com/fastapi/fastapi#readme) | web framework | One example in steps (create it, run it, check it, then upgrade it), each with what the reader sees |
| [Transformers](https://github.com/huggingface/transformers#readme) | ML library | A "why use it" list and a "when not to use it" list, one after the other |
| [Tauri](https://github.com/tauri-apps/tauri#readme) | desktop apps | One command to start, and a table of the supported platforms and versions |
| [Excalidraw](https://github.com/excalidraw/excalidraw#readme) | web app | A cover in light and dark, a two-line pitch, then a picture of the product before the list of features |

More examples: [awesome-readme](https://github.com/matiassingers/awesome-readme).

**The checklist**

- [ ] The first sentence says what the project is, what it does and for whom.
- [ ] The top 10 lines answer the five questions.
- [ ] The sections follow the order, with all the required ones for the project's size.
- [ ] The quick start gives a first result in 5 commands or fewer, and it works in a clean place.
- [ ] Each command block has one command, no prompt sign and a language.
- [ ] Each diagram comes from text or code, in light and dark, and CI checks it.
- [ ] Each image has an alt text with its main point.
- [ ] No graphic uses a logo or a character that the project does not own.
- [ ] Each badge is true and checked by a machine.
- [ ] The Why section says when not to use the project.
- [ ] Each claim such as "fast" has a measured comparison and its method.
- [ ] What's new lists the latest changes, newest first.
- [ ] The text follows the writing standard and the project's dictionary.
- [ ] Each link resolves.
