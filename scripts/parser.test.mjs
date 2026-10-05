// T125 PR 1: the shell parser (mvdan/sh in plugins/sage/hooks/parser/parser.wasm) reads the hook's attack lists in bash
// and zsh mode, refuses what it cannot read, and loads and parses synchronously and fast enough for the hook.
// Nothing here runs a command line: the parser only reads text.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseCommands, MAX_LENGTH } from "../plugins/sage/hooks/parser/parser.mjs";

const LOADER = fileURLToPath(new URL("../plugins/sage/hooks/parser/parser.mjs", import.meta.url));
const read = (src, zsh) => {
  try {
    return parseCommands(src, { zsh });
  } catch (e) {
    return e;
  }
};
const MODES = [false, true];

test("the loader is synchronous: a plain function call gives the command list, with hosts and pipes as objects", () => {
  const commands = parseCommands('ps -ax | head -1; echo "$(kill 1)"');
  assert.deepEqual(
    commands.map(({ words, piped, host }) => [words.join(" "), piped, host && `${host.cmd.words[0]}:${host.index}`]),
    [["ps -ax", true, undefined], ["head -1", false, undefined], ["kill 1", false, "echo:1"], ["echo $(…)", false, undefined]],
  );
  assert.equal(commands[0].pipeTo, commands[1]);
});

test("the shapes of the hook's contract: quotes, redirections, heredocs, here-strings, case arms, keywords", () => {
  const shape = (src, zsh = false) => parseCommands(src, { zsh }).map(({ words, bodies, grouped, writes }) => ({ words, bodies, grouped, writes }));
  assert.deepEqual(shape("2>/dev/null ps>out 'a b' \"c\\\"d\" e\\ f"), [{ words: ["ps", "a b", 'c"d', "e f"], bodies: [], grouped: false, writes: true }]);
  assert.deepEqual(shape("cat <<EOF\nhi $(ps)\nEOF\nbash <<<'kill 1'"), [
    { words: ["ps"], bodies: [], grouped: false, writes: false },
    { words: ["cat"], bodies: ["hi $(ps)"], grouped: false, writes: false },
    { words: ["bash"], bodies: ["kill 1"], grouped: false, writes: false },
  ]);
  assert.deepEqual(shape("case $1 in top) echo t;; ps|kill) :;; esac"), [
    { words: ["echo", "t"], bodies: [], grouped: true, writes: false },
    { words: [":"], bodies: [], grouped: true, writes: false },
  ]);
  assert.deepEqual(shape("while pgrep x; do time ps; done > log"), [
    { words: ["pgrep", "x"], bodies: [], grouped: true, writes: true },
    { words: ["ps"], bodies: [], grouped: true, writes: true },
  ]);
});

// The lines of scripts/sage-hook.test.mjs that the hook refuses or passes today (R446, R454, R466), and main's
// regression list (MAIN_DENIES), read from that file so the two never drift apart.
const hookTests = readFileSync(fileURLToPath(new URL("./sage-hook.test.mjs", import.meta.url)), "utf8");
const MAIN_DENIES = new Function(`return ${/const MAIN_DENIES = (\[[\s\S]*?\n\]);/.exec(hookTests)[1]}`)();
const GUARDED = /^(?:ps|PS|kill|pkill|pgrep|lsof|top|fuser|pidof|htop|kill-port(?:@\d+)?|fkill|Get-Process)$/;
const R446 = ["while pgrep -f vite >/dev/null; do sleep 1; done", "if pgrep -f vite; then echo up; fi", "for p in 1 2; do kill $p; done", "until ! lsof -i :5173; do sleep 1; done", "! ps", "{ ps; }", "if true; then :; elif ps; then :; else kill 1; fi", "while true; do pgrep -fl vite; sleep 1; done", "function f { ps; }", "sh -c ps", 'bash -c "lsof"', "eval ps", "sudo -u root ps", "xargs -I {} kill {}", "env -u X ps", "timeout -s TERM 60 pkill node", "nice -n 5 top -l 1", "kill %1", "kill $!"];
const R454 = ["fuser -k 3000/tcp", "pidof node", "htop", "npx kill-port 3000", "npx -y kill-port@2 3000", "npx -p kill-port kill-port 3000", "npx fkill node", "npm exec -- kill-port 3000", "pnpm dlx kill-port 3000", "bunx fkill :3000", "sudo fuser 3000/tcp", "ps>/tmp/out", "2>/dev/null ps -ax", ">/dev/null kill 1", "ps</dev/null", "&>/dev/null pgrep node", "{fd}>/dev/null lsof -i :3000", "kill 1 2>&1", "ps 2>&1 | head", 'bash <<< "kill 1"', "case $1 in\n a) ps;;\nesac", "case x in (a) kill 1;; esac", "case x in a) :;& b) top;;& esac", "case x in a) :;; esac | top", "x=$(case a in a) :;; esac); top", 'bash -lc "ps"', "bash -c ps x", "bash <<EOF\nps\nEOF", "bash -s <<EOF\nkill 1\nEOF", "eval kill 1", "pwsh -Command Get-Process"];
const R466 = ["(case x in (a) ps -ax;; esac)", "{ case x in (a) ps;; esac; }", "(case x in (a) (case y in (b) kill 1;; esac);; esac)", "diff <(ps) x", "tee >(kill 1) < f", "cat <(echo $(ps))"];
const UNREADABLE = ["(case x in a) %", "( %", "case x in a) %", "x=$(case x in a) %)", "(case x in a) % )", "case x in (% x) :;; esac"];
/** A guarded program as a word of a command, or as a line of a heredoc or here-string that a shell reads. */
const names = (commands) => commands.some((c) => c.words.some((w) => GUARDED.test(w)) || c.bodies.some((b) => b.split(/\s+/).some((w) => GUARDED.test(w))));

// Where zsh has no such form, zsh mode refuses the line (fail closed): {fd}> redirections and the ;;& case terminator.
const ZSH_ONLY_REFUSES = ["{fd}>/dev/null lsof -i :3000", "case x in a) :;& b) top;;& esac"];

test("R446, R454 and R466: each line that the hook refuses parses, with its process program in a command, or zsh mode refuses it", () => {
  for (const zsh of MODES) {
    const refused = [];
    for (const line of [...R446, ...R454, ...R466]) {
      const commands = read(line, zsh);
      if (commands instanceof Error) refused.push(line);
      else assert.ok(names(commands), `${zsh ? "zsh" : "bash"}: ${JSON.stringify(line)} gives no process program`);
    }
    assert.deepEqual(refused, zsh ? ZSH_ONLY_REFUSES : []);
  }
});

test("R454-N6: a case pattern is not a command", () => {
  for (const zsh of MODES) {
    assert.deepEqual(parseCommands("case $1 in\n top) echo top;;\n ps|kill) echo other;;\nesac", { zsh }).map((c) => c.words.join(" ")), ["echo top", "echo other"]);
    assert.deepEqual(parseCommands("case x in (top) :;; esac", { zsh }).map((c) => c.words.join(" ")), [":"]);
  }
});

test("R466-FAILCLOSED: each line that the hook's reader cannot read is refused in both modes", () => {
  for (const zsh of MODES) for (const line of UNREADABLE) for (const fill of ["ps", "git push origin main"]) assert.ok(read(line.replace("%", fill), zsh) instanceof Error, `${zsh}: ${line}`);
});

// The lines of main's regression list that do not parse: an open quote, "(" or case, and a case pattern of more than
// one word (the shell refuses it too). zsh mode also refuses {fd}> and ;;&.
const OPEN = ["git push origin main", "gh pr merge 1 --admin"].flatMap((x) => [`(case x in a) ${x}`, `( ${x}`, `case x in a) ${x}`, `x=$(case x in a) ${x})`, `(case x in a) ${x} )`, `echo '${x}`]);
const PATTERN = ["git push origin main", "gh pr merge 1 --admin"].flatMap((x) => [`case $1 in\n ${x}) echo top;;\n ps|kill) echo other;;\nesac`, `case x in (${x}) :;; esac`, `x=$(case $1 in ${x}) echo t;; esac); echo "$x"`]);
const BASH_REFUSES = ['echo "gh pr merge 41 --squash --delete-branch --match-head-commit a1b2c3d4e5f60718293a4b5c6d7e8f9012345678', "git push origin 'feat", ...OPEN, ...PATTERN];
const ZSH_REFUSES = [...BASH_REFUSES, ...["git push origin main", "gh pr merge 1 --admin"].flatMap((x) => [`{fd}>/dev/null ${x} -i :3000`, `case x in a) :;& b) ${x};;& esac`])];

test("main's regression list: each line parses with its push, merge, API call or process program in a command, or is refused", () => {
  assert.equal(MAIN_DENIES.length, 342);
  for (const zsh of MODES) {
    const refused = [];
    for (const line of MAIN_DENIES) {
      const commands = read(line, zsh);
      if (commands instanceof Error) refused.push(line);
      else assert.ok(commands.some((c) => [...c.words, ...c.bodies].some((w) => /push|merge|git\/refs|(?:^|\s)(?:ps|kill|pkill|pgrep|lsof|top|fuser|pidof|htop)(?:\s|$)|kill-port|fkill|Get-Process/.test(w))), `${zsh ? "zsh" : "bash"}: ${JSON.stringify(line)}`);
    }
    assert.deepEqual(refused.sort(), (zsh ? ZSH_REFUSES : BASH_REFUSES).sort(), zsh ? "zsh" : "bash");
  }
});

test("strictness: bash mode refuses the 5 invalid probes that tolerant parsers accept; zsh mode accepts only what zsh accepts", () => {
  for (const line of ["fi", "done", "while; do :; done", "case x in (a b) :;; esac", "( )"]) assert.ok(read(line, false) instanceof Error, line);
  for (const line of ["fi", "done", "case x in (a b) :;; esac", "( )"]) assert.ok(read(line, true) instanceof Error, line); // zsh -n accepts the last two: stricter, so fail closed
  assert.deepEqual(parseCommands("while; do :; done", { zsh: true }).map((c) => c.words), [[":"]], "zsh -n accepts it too");
});

test("zsh: =(ps) is a command of its own, and a glob qualifier that runs code is refused; bash mode reads neither as zsh", () => {
  assert.deepEqual(parseCommands("cat =(ps)", { zsh: true }).map((c) => c.words.join(" ")), ["ps", "cat $(…)"]);
  assert.match(read("echo *(e:'ps':)", true).message, /zsh glob qualifier that can run code/);
  assert.match(read("echo *(+f)", true).message, /zsh glob qualifier/);
  assert.deepEqual(parseCommands("echo *(N)", { zsh: true }).map((c) => c.words), [["echo", "*(N)"]], "a qualifier that runs no code passes");
  assert.ok(read("cat =(ps)", false) instanceof Error, "bash refuses =( )");
  assert.deepEqual(parseCommands("echo *(e:'ps':)").map((c) => c.words), [["echo", "*(e:'ps':)"]], "in bash, *( ) is an extended glob, which runs nothing");
});

test(`the size cap: a line of ${MAX_LENGTH} characters parses, a longer one and 1 MB are refused unread`, () => {
  assert.equal(parseCommands(`echo ${"x".repeat(MAX_LENGTH - 5)}`).length, 1);
  assert.match(read(`echo ${"x".repeat(MAX_LENGTH - 4)}`).message, /more than 10000 characters/);
  const t = process.cpuUsage();
  assert.match(read("git ".repeat(1 << 18)).message, /more than 10000 characters/);
  const { user, system } = process.cpuUsage(t);
  assert.ok((user + system) / 1000 < 5, "1 MB is refused before it is copied or parsed");
});

/** CPU time of a new Node process to import the loader and parse one line, in ms (CPU, not wall time: a busy Mac waits for a core). */
const coldParse = (line) => {
  const script = `const t = process.cpuUsage(); const { parseCommands } = await import(${JSON.stringify(LOADER)}); parseCommands(${JSON.stringify(line)}); const { user, system } = process.cpuUsage(t); console.log((user + system) / 1000);`;
  return Number(execFileSync(process.execPath, ["--input-type=module", "-e", script], { encoding: "utf8" }));
};

test("speed: a new process loads the parser and parses a typical line in well under 50 ms of CPU time", () => {
  const typical = "cd /x && git -C /x push origin t125-parser 2>&1 | tail -5";
  const ms = Math.min(coldParse(typical), coldParse(typical), coldParse(typical));
  console.log(`load and parse: ${ms.toFixed(1)} ms of CPU (fastest of 3)`);
  assert.ok(ms < 40, `${ms.toFixed(1)} ms of CPU`);
  const big = `echo ${"git ".repeat((MAX_LENGTH - 5) / 4)}`;
  const t = process.cpuUsage();
  parseCommands(big);
  const { user, system } = process.cpuUsage(t);
  console.log(`a line of ${big.length} characters, warm: ${((user + system) / 1000).toFixed(1)} ms of CPU`);
  assert.ok((user + system) / 1000 < 500, "the longest line that the cap lets in parses well inside the hook's 10 s");
});
