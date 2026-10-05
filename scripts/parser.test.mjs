// T125 PR 1: the shell parser (mvdan/sh in plugins/sage/hooks/parser/parser.wasm) reads the hook's attack lists in bash
// and zsh mode, refuses what it cannot read, and loads and parses synchronously and fast enough for the hook.
// Nothing here runs a command line: the parser only reads text.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, cpSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import * as loader from "../plugins/sage/hooks/parser/parser.mjs";
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

// Where zsh has no such form, zsh mode refuses the line (fail closed): the ;;& case terminator. Since mvdan/sh v3.14,
// zsh mode reads a {fd}> redirection too (zsh -n refuses it at the start of a line); its program is still a command.
const ZSH_ONLY_REFUSES = ["case x in a) :;& b) top;;& esac"];

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
// one word (the shell refuses it too). zsh mode also refuses ;;&.
const OPEN = ["git push origin main", "gh pr merge 1 --admin"].flatMap((x) => [`(case x in a) ${x}`, `( ${x}`, `case x in a) ${x}`, `x=$(case x in a) ${x})`, `(case x in a) ${x} )`, `echo '${x}`]);
const PATTERN = ["git push origin main", "gh pr merge 1 --admin"].flatMap((x) => [`case $1 in\n ${x}) echo top;;\n ps|kill) echo other;;\nesac`, `case x in (${x}) :;; esac`, `x=$(case $1 in ${x}) echo t;; esac); echo "$x"`]);
// $'\x67h' spells gh: a $'…' escape other than the 13 that bash and zsh read alike is refused (T125-C2-ANSIC).
const BASH_REFUSES = ["$'\\x67h' pr merge 41 --admin", 'echo "gh pr merge 41 --squash --delete-branch --match-head-commit a1b2c3d4e5f60718293a4b5c6d7e8f9012345678', "git push origin 'feat", ...OPEN, ...PATTERN];
const ZSH_REFUSES = [...BASH_REFUSES, ...["git push origin main", "gh pr merge 1 --admin"].map((x) => `case x in a) :;& b) ${x};;& esac`)];

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
  for (const line of ["fi", "done", "case x in (a b) :;; esac"]) assert.ok(read(line, true) instanceof Error, line); // zsh -n accepts the last one: stricter, so fail closed
  assert.deepEqual(parseCommands("( )", { zsh: true }), [], "zsh -n accepts an empty subshell, and it runs nothing");
  assert.deepEqual(parseCommands("while; do :; done", { zsh: true }).map((c) => c.words), [[":"]], "zsh -n accepts it too");
});

test("zsh: =(ps) is a command of its own, and a glob qualifier that runs code is refused; bash mode reads neither as zsh", () => {
  assert.deepEqual(parseCommands("cat =(ps)", { zsh: true }).map((c) => c.words.join(" ")), ["ps", "cat $(…)"]);
  assert.match(read("echo *(e:'ps':)", true).message, /zsh glob qualifier that can run code/);
  assert.match(read("echo *(+f)", true).message, /zsh glob qualifier/);
  assert.match(read("echo (a|b)(e:ps:)", true).message, /zsh glob qualifier/, "a glob that starts with ( (mvdan/sh v3.14)");
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
  assert.ok(ms < 25, `${ms.toFixed(1)} ms of CPU`); // TinyGo: about 10 ms; standard Go's 4 MB file: 39 to 68 ms
  const big = `echo ${"git ".repeat((MAX_LENGTH - 5) / 4)}`;
  const t = process.cpuUsage();
  parseCommands(big);
  const { user, system } = process.cpuUsage(t);
  console.log(`a line of ${big.length} characters, warm: ${((user + system) / 1000).toFixed(1)} ms of CPU`);
  assert.ok((user + system) / 1000 < 500, "the longest line that the cap lets in parses well inside the hook's 10 s");
});

const words = (src, zsh = false) => parseCommands(src, { zsh }).map((c) => c.words);

test("T125-Q3-EMPTY: a line with no command gives an empty list, in both modes", () => {
  for (const zsh of MODES) for (const line of ["", "   ", "# note", "\n", ">out", "2>/dev/null"]) assert.deepEqual(parseCommands(line, { zsh }), [], `${zsh}: ${JSON.stringify(line)}`);
  assert.deepEqual(words("# note\nps"), [["ps"]], "a comment line before a command");
});

test("T125-Q2-NUL: a NUL byte is refused", () => {
  for (const zsh of MODES) assert.match(read("ps\0;kill 1", zsh).message, /a NUL byte/);
});

test("T125-F3-PARSERAW: parseCommands is the only way to the parser, so no caller can skip the length cap or the NUL check", () => {
  assert.deepEqual(Object.keys(loader).sort(), ["MAX_LENGTH", "RECORD", "RESTORE", "WASM", "parseCommands", "recorded", "verifiedWasm"]);
});

test("T125-F1-EXTGLOB: bash mode refuses an extended glob group with a substitution in it, in each place where bash runs it", () => {
  const CODE = ["shopt -s extglob; echo @(a|$(ps))", "echo ?(a|$(ps))", "echo *(a|$(ps))", "echo +(a|$(ps))", "echo !(a|$(ps))", "echo @(a|`ps`)", "echo @(a|<(ps))", "echo @(a|${x})", "[[ $a == @(x|$(ps)) ]]", "case a in @(x|$(ps))) true;; esac", "x=@(a|$(ps))"];
  for (const line of CODE) assert.match(read(line, false).message, /an extended glob group with a substitution/, line);
  assert.deepEqual(parseCommands("echo ${x/@(a|$(ps))/y}").map((c) => c.words), [["ps"], ["echo", "${x/@(a|$(ps))/y}"]], "mvdan/sh reads a pattern in ${ } itself, so its substitution is a command");
  assert.deepEqual(parseCommands("echo !(*.txt) @(a|b) +(c) ?(d) *(e:'f':)").map((c) => c.words), [["echo", "!(*.txt)", "@(a|b)", "+(c)", "?(d)", "*(e:'f':)"]], "a group of plain text runs nothing");
});

test("T125-F2-QUALPARAM: zsh mode refuses a glob group that holds an expansion where zsh makes file names, and a substitution in a group anywhere", () => {
  for (const line of ["x='e:ps:'; print *(N${x})", "print *($x)", "print *(N$x)", "echo ${z:-*(N$y)}"]) assert.match(read(line, true).message, /a zsh glob group with (an expansion|a substitution)/, line);
  for (const line of ["echo (a|`ps`)", "x=a(b|`ps`)", "x=*(N`ps`)", "echo (a|'$x')"]) assert.match(read(line, true).message, /a zsh glob group with a substitution/, line);
  for (const line of ["echo *(N$(echo e:ps:))", "x=*(N$(ps))", "echo (a|<(ps))"]) assert.match(read(line, true).message, /a command can only contain words/, `${line}: mvdan/sh refuses a ) after a substitution in a group`);
});

test("T125-Q8-QUALFALSE: a zsh qualifier is refused only where zsh makes file names; ( ) text in quotes, assignments, [[ ]] patterns and case patterns parses", () => {
  const TEXT = ['echo "${x:-(none)}"', "x=${x:-(none)}", 'echo "${x:-(see)}"', "[[ $a == (yes|no) ]] && echo y", "local x=${x:-(see)}", "case $a in see|e+) true;; esac", 'echo "(see the docs)"', "echo $((1+(2)))", "[[ $v =~ ^([0-9]+\\.[0-9]+)$ ]]"];
  for (const line of TEXT) assert.ok(Array.isArray(read(line, true)), `${line}: ${read(line, true).message}`);
  const CODE = ["echo *(e:'ps':)", "x=( *(e:ps:) )", "echo hi > *(e:ps:)", "for f in *(e:ps:); do :; done", "echo ${x:-*(e:ps:)}", "[[ -n *(#qe:ps:) ]]", "echo (a|b)(e:ps:)", "echo *(+f)"];
  for (const line of CODE) assert.match(read(line, true).message, /a zsh glob qualifier that can run code/, line);
});

test("T125-Q1-ZSHPARAM: zsh mode refuses each parameter expansion that makes a value into code", () => {
  const CODE = ["echo ${(e):-'$(ps)'}", "x='$(ps)'; echo ${(e)x}", "echo ${(Xe)x}", "echo \"${(e)x}\"", "x='*(e:ps:)'; echo ${~x}", "echo $~x", "echo ${x:-$~y}", "echo ${(%%)x}", "echo ${(%)x}", "echo ${(~j.|.)x}", "echo ${(pj:$sep:)x}", "cat <<EOF\n${(e)x}\nEOF", "echo $(echo ${(e)x})"];
  for (const line of CODE) assert.match(read(line, true).message, /a zsh parameter expansion that can run code/, line);
  assert.deepEqual(words("echo ${(j:,:)x} ${(U)x} ${~~x} ${=x} ${#x}", true), [["echo", "${(j:,:)x}", "${(U)x}", "${~~x}", "${=x}", "${#x}"]], "flags that run no code pass");
  assert.ok(read("echo ${(e)x}", false) instanceof Error, "bash has no flags: mvdan/sh refuses them");
});

test("T125-Q5-DOLLARTILDE: $~x at the end of a line is refused; $=x keeps its name", () => {
  assert.match(read("echo $~x", true).message, /a zsh parameter expansion that can run code/);
  assert.deepEqual(words("echo $=x", true), [["echo", "$=x"]]);
  assert.deepEqual(words("echo $^x", true), [["echo", "$^x"]]);
});

test("T125-Q4-COPROC: zsh mode refuses coproc, also inside a substitution (T125-S4-SUBERR); bash mode unwraps it", () => {
  for (const line of ["coproc ps", "coproc (ps)", "echo $(coproc ps)", "cat <(coproc kill 1)", "x=$(coproc ps)"]) assert.match(read(line, true).message, /zsh's coproc/, line);
  assert.deepEqual(parseCommands("coproc ps").map((c) => [c.words, c.grouped]), [[["ps"], true]]);
});

// zshmisc(1), "Reserved Words": mvdan/sh v3.14.1 reads repeat and foreach as words in zsh mode, so their program would
// look like an argument. The other reserved words are keywords to mvdan/sh (select, time, function, [[, !), a syntax
// error (always), or a word that the hook skips or that is the program itself (nocorrect, end, float, integer).
test("T125-R2-ZSHRESERVED: zsh mode refuses repeat and foreach, also inside a substitution; bash mode reads them as words", () => {
  const LINES = ["repeat 1 kill 1", "foreach x (a) kill 1; end", "echo $(repeat 1 kill 1)", "cat <(foreach x (a) kill 1; end)", "time repeat 1 kill 1", "true && repeat 2 ps"];
  for (const line of LINES) assert.match(read(line, true).message, /zsh's (?:repeat|foreach), which mvdan\/sh reads as a word/, line);
  assert.deepEqual(words("repeat 1 kill 1", false), [["repeat", "1", "kill", "1"]], "bash has no repeat: it is a program");
  assert.deepEqual(words("echo repeat foreach; 'repeat' 1 x", true), [["echo", "repeat", "foreach"], ["repeat", "1", "x"]], "a quoted or later word is a word");
  assert.deepEqual(words("select x in a; do kill 1; done", true), [["kill", "1"]], "select is a keyword");
});

test("T125-R2-PROMPTP: bash mode refuses ${x@P}, which runs the substitutions in the value; zsh mode refuses it as a syntax error", () => {
  for (const line of ["echo ${x@P}", "echo \"${x@P}\"", "echo ${a[@]@P}", "echo ${x@P$y}", "cat <<EOF\n${x@P}\nEOF"]) assert.match(read(line, false).message, /@P/, line);
  assert.ok(read("echo ${x@P}", true) instanceof Error, "zsh");
  assert.deepEqual(words("echo ${x@Q} ${x@E}", false), [["echo", "${x@Q}", "${x@E}"]], "the other operators pass");
});

test("T125-C1-ARITH: the commands in (( )) and $(( )) are commands, and a backtick is a substitution", () => {
  for (const zsh of MODES) {
    assert.deepEqual(parseCommands("(( x = $(kill 1) ))", { zsh }).map((c) => c.words), [["kill", "1"]], `${zsh}`);
    assert.deepEqual(parseCommands("echo $(( $(ps) + 1 ))", { zsh }).map((c) => [c.words, c.host?.index]), [[["ps"], 1], [["echo", "$(( $(ps) + 1 ))"], undefined]], `${zsh}`);
    assert.deepEqual(parseCommands("echo `ps -ax`", { zsh }).map((c) => [c.words, c.host?.index]), [[["ps", "-ax"], 1], [["echo", "$(…)"], undefined]], `${zsh}`);
    assert.deepEqual(parseCommands("(( `kill 1` ))", { zsh }).map((c) => c.words), [["kill", "1"]], `${zsh}`);
    assert.deepEqual(parseCommands("let x=$(ps)", { zsh }).map((c) => c.words), [["ps"], ["let", "x=$(ps)"]], `${zsh}`);
  }
});

test("T125-C2-ANSIC: $'…' gives its decoded text, and an escape that could spell a name is refused, in both modes", () => {
  for (const zsh of MODES) {
    assert.deepEqual(words("git commit -m $'fix\\n\\tbody \\'q\\' \\\\ \\\"x\\\" \\?'", zsh), [["git", "commit", "-m", "fix\n\tbody 'q' \\ \"x\" ?"]]);
    assert.deepEqual(words("printf $'\\a\\b\\e\\E\\f\\r\\v'", zsh), [["printf", "\x07\b\x1b\x1b\f\r\v"]]);
    for (const line of ["$'\\x67it' push", "$'\\147it' push", "g$'\\u0069't push", "$'\\U00000067'it push", "$'\\cG'", "$'\\M-a'", "$'\\q'", "echo $(echo $'\\x70s')"]) assert.match(read(line, zsh).message, /an ANSI-C string with an escape other than/, `${zsh}: ${line}`);
  }
});

test("T125-C3-DEPTH: a 60-step && chain, a 600-command pipe and 300 nested $( ) parse; deeper is refused with the reason, and the next call works", () => {
  assert.equal(parseCommands(Array.from({ length: 60 }, (_, i) => `step${i} --flag`).join(" && ")).length, 60);
  assert.equal(parseCommands(Array(600).fill("a").join(" | ")).length, 600);
  assert.equal(parseCommands(`echo ${"$(".repeat(300)}x${")".repeat(300)}`).length, 301);
  for (const line of [Array(4000).fill("a").join("|"), `echo ${"$(".repeat(3000)}x${")".repeat(3000)}`]) assert.match(read(line).message, /the parser stopped .*1 MiB stack.*about 600 commands in one pipe or && chain/);
  assert.deepEqual(words("ps"), [["ps"]]);
});

/** A copy of the loader beside a given parser.wasm, with a given sha256 record (the right one unless given). */
function loaderWith(wasm, record = `${createHash("sha256").update(wasm).digest("hex")}  parser.wasm\n`) {
  const dir = mkdtempSync(join(tmpdir(), "sage-parser-loader-"));
  cpSync(LOADER, join(dir, "parser.mjs"));
  writeFileSync(join(dir, "parser.wasm"), wasm);
  if (record !== undefined && record !== null) writeFileSync(join(dir, "parser.wasm.sha256"), record);
  return import(join(dir, "parser.mjs"));
}
const REAL = readFileSync(new URL("../plugins/sage/hooks/parser/parser.wasm", import.meta.url));

test("T125-S2-LOADHASH: the loader runs parser.wasm only when its sha256 is the recorded one", async () => {
  const changed = Buffer.from(REAL);
  changed[changed.length - 1] ^= 1;
  const swapped = await loaderWith(changed, `${createHash("sha256").update(REAL).digest("hex")}  parser.wasm\n`);
  assert.throws(() => swapped.parseCommands("ps"), /parser\.wasm differs from its recorded hash.*git checkout HEAD -- plugins\/sage\/hooks\/parser\/parser\.wasm.*TinyGo 0\.42\.0 and Go 1\.26\.8/);
  assert.throws(() => swapped.parseCommands("ps"), /differs from its recorded hash/, "it stays refused");
  const bad = await loaderWith(REAL, "not a hash\n");
  assert.throws(() => bad.parseCommands("ps"), /parser\.wasm\.sha256 is not a valid hash record/);
  const none = await loaderWith(REAL, null);
  assert.throws(() => none.parseCommands("ps"), /parser\.wasm\.sha256 is missing/);
  assert.deepEqual((await loaderWith(REAL)).parseCommands("ps").map((c) => c.words), [["ps"]], "the real file with its record runs");
});

/** A WebAssembly module with the parser's exports whose parse gives json, whatever the line. */
function fakeParser(json) {
  const uleb = (n) => { const b = []; do { let x = n & 0x7f; n >>>= 7; if (n) x |= 0x80; b.push(x); } while (n); return b; };
  const sleb = (n) => { const b = []; for (;;) { const x = Number(n & 0x7fn); n >>= 7n; if ((n === 0n && !(x & 0x40)) || (n === -1n && x & 0x40)) { b.push(x); return b; } b.push(x | 0x80); } };
  const vec = (items) => [...uleb(items.length), ...items.flat()];
  const name = (s) => [...uleb(s.length), ...Buffer.from(s)];
  const section = (id, bytes) => [id, ...uleb(bytes.length), ...bytes];
  const body = (code) => [...uleb(code.length + 1), 0, ...code];
  const data = [...Buffer.from(json)];
  return Buffer.from([0, 0x61, 0x73, 0x6d, 1, 0, 0, 0,
    ...section(1, vec([[0x60, 0, 0], [0x60, 1, 0x7f, 1, 0x7f], [0x60, 2, 0x7f, 0x7f, 1, 0x7e]])),
    ...section(3, vec([[0], [1], [2]])),
    ...section(5, vec([[0, 1]])),
    ...section(7, vec([[...name("memory"), 2, 0], [...name("_initialize"), 0, 0], [...name("alloc"), 0, 1], [...name("parse"), 0, 2]])),
    ...section(10, vec([body([0x0b]), body([0x41, 0, 0x0b]), body([0x42, ...sleb((1024n << 32n) | BigInt(data.length)), 0x0b])])),
    ...section(11, vec([[0, 0x41, 0x80, 0x08, 0x0b, ...uleb(data.length), ...data]]))]);
}

test("T125-S3-SHAPE: the loader refuses a parser result of the wrong shape", async () => {
  const good = { words: ["ps"], bodies: [], host: null, piped: false, pipeTo: null, grouped: false, writes: false };
  const ok = await loaderWith(fakeParser(JSON.stringify({ commands: [good] })));
  assert.deepEqual(ok.parseCommands("x").map((c) => c.words), [["ps"]], "the fake parser works when its result has the right shape");
  for (const result of [{}, { commands: null }, { commands: [{ ...good, words: "ps" }] }, { commands: [{ ...good, words: [1] }] }, { commands: [{ ...good, bodies: undefined }] }, { commands: [{ ...good, host: { cmd: 1, index: 0 } }] }, { commands: [{ ...good, host: { cmd: 0, index: -2 } }] }, { commands: [{ ...good, pipeTo: 5 }] }, { commands: [{ ...good, piped: "no" }] }, { commands: [], extra: 1 }, { error: 1 }]) {
    const m = await loaderWith(fakeParser(JSON.stringify(result)));
    assert.throws(() => m.parseCommands("x"), /the parser gave a result of the wrong shape/, JSON.stringify(result));
  }
});

/** A copy of this repository, where a test can change the parser's files and run a script with a given PATH. */
function repo() {
  const dir = mkdtempSync(join(realpathSync(tmpdir()), "sage-parser-repo-")); // the real path, so that the script sees that it runs as the script
  const ROOT = fileURLToPath(new URL("..", import.meta.url));
  cpSync(ROOT, dir, { recursive: true, filter: (src) => ![".git", ".claude", "node_modules"].includes(relative(ROOT, src)) });
  const bin = join(dir, ".bin");
  mkdirSync(bin);
  const run = (script, env = {}) => spawnSync(process.execPath, [join(dir, "scripts", `${script}.mjs`)], { encoding: "utf8", env: { PATH: `${bin}:${dirname(process.execPath)}:/usr/bin:/bin`, HOME: dir, ...env } });
  const file = (rel) => join(dir, "plugins/sage/hooks/parser", rel);
  /** A fake tinygo on PATH that names a version and builds nothing. */
  const tinygo = (version) => { writeFileSync(join(bin, "tinygo"), `#!/bin/sh\necho "tinygo version ${version} linux/amd64 (using go version go1.26.8 and LLVM version 22.1.4)"\n`); chmodSync(join(bin, "tinygo"), 0o755); };
  return { dir, run, file, tinygo };
}

test("T125-S1-CIREBUILD and T125-U5-SKIPLINE: without the pinned tools, CI fails and a local check names the tools, where to get them and what it found", () => {
  const r = repo();
  const local = r.run("check");
  assert.equal(local.status, 0, local.stderr);
  assert.match(local.stdout, /- parser\.wasm: recorded sha256 checked, not rebuilt: PATH has no tinygo, not tinygo 0\.42\.0 with go1\.26\.8\. To rebuild and compare, install TinyGo 0\.42\.0 \(https:\/\/github\.com\/tinygo-org\/tinygo\/releases\/tag\/v0\.42\.0\) and Go 1\.26\.8 exactly \(https:\/\/go\.dev\/dl\/\)/);
  const ci = r.run("check", { CI: "true" });
  assert.equal(ci.status, 1);
  assert.match(ci.stderr, /✗ plugins\/sage\/hooks\/parser\/parser\.wasm: CI must rebuild it from its sources and compare, but PATH has no tinygo, not tinygo 0\.42\.0 with go1\.26\.8\. Install TinyGo 0\.42\.0/);
  r.tinygo("0.41.0");
  assert.match(r.run("check").stdout, /PATH has tinygo 0\.41\.0 with go1\.26\.8, not tinygo 0\.42\.0 with go1\.26\.8/);
  assert.equal(r.run("check", { CI: "true" }).status, 1, "a wrong TinyGo fails in CI too");
  rmSync(r.dir, { recursive: true, force: true });
});

test("T125-U6-BUILDERR: npm run parser without the tools names scripts/build-parser.mjs, the tools and where to get them", () => {
  const r = repo();
  const out = r.run("build-parser");
  assert.equal(out.status, 1);
  assert.match(out.stderr, /✗ scripts\/build-parser\.mjs \(npm run parser\) builds with tinygo 0\.42\.0 with go1\.26\.8, and PATH has no tinygo\. Install TinyGo 0\.42\.0 \(https:\/\/github\.com\/tinygo-org\/tinygo\/releases\/tag\/v0\.42\.0\) and Go 1\.26\.8 exactly \(https:\/\/go\.dev\/dl\/\)/);
  rmSync(r.dir, { recursive: true, force: true });
});

test("T125-U7-HANDCOMPARE: npm run parser says if the new sha256 is the one that git's HEAD records", () => {
  const r = repo();
  const head = readFileSync(r.file("parser.wasm.sha256"), "utf8").split(" ")[0];
  const git = (...a) => execFileSync("git", ["-C", r.dir, "-c", "user.name=t", "-c", "user.email=t@t", ...a]);
  git("init", "-q");
  git("add", "plugins/sage/hooks/parser");
  git("commit", "-qm", "start");
  // A fake tinygo of the pinned version whose build copies FAKE_WASM to the -o path (argument 7).
  writeFileSync(join(r.dir, ".bin", "tinygo"), '#!/bin/sh\n[ "$1" = version ] && { echo "tinygo version 0.42.0 linux/amd64 (using go version go1.26.8 and LLVM version 22.1.4)"; exit 0; }\ncp "$FAKE_WASM" "$7"\n');
  chmodSync(join(r.dir, ".bin", "tinygo"), 0o755);
  const same = join(r.dir, "same.wasm");
  cpSync(r.file("parser.wasm"), same);
  let out = r.run("build-parser", { FAKE_WASM: same });
  assert.equal(out.status, 0, out.stderr);
  assert.match(out.stdout, new RegExp(`^✓ parser\\.wasm: \\d+ bytes, sha256 ${head}: the same sha256 that git's HEAD records\n$`));
  writeFileSync(join(r.dir, "other.wasm"), "x");
  out = r.run("build-parser", { FAKE_WASM: join(r.dir, "other.wasm") });
  assert.match(out.stdout, new RegExp(`^! parser\\.wasm: 1 bytes, sha256 2d711642b726b04401627ca9fbac32f5c8530fb1903cc4db02258717921a4881: not the sha256 that git's HEAD records \\(${head}\\)\\. After a change to the parser's sources, that is expected`));
  assert.equal(readFileSync(r.file("parser.wasm.sha256"), "utf8"), "2d711642b726b04401627ca9fbac32f5c8530fb1903cc4db02258717921a4881  parser.wasm\n", "the record is the new build's");
  rmSync(r.dir, { recursive: true, force: true });
});

test("T125-S7-GOWORK: npm run parser builds with GOWORK=off, so a go.work in a parent folder cannot replace mvdan/sh", () => {
  const r = repo();
  // A fake tinygo of the pinned version whose build writes its GOWORK to the -o path (argument 7).
  writeFileSync(join(r.dir, ".bin", "tinygo"), '#!/bin/sh\n[ "$1" = version ] && { echo "tinygo version 0.42.0 linux/amd64 (using go version go1.26.8 and LLVM version 22.1.4)"; exit 0; }\nprintf "GOWORK=%s" "$GOWORK" > "$7"\n');
  chmodSync(join(r.dir, ".bin", "tinygo"), 0o755);
  const out = r.run("build-parser", { GOWORK: join(r.dir, "go.work") });
  assert.equal(out.status, 0, out.stderr);
  assert.equal(readFileSync(r.file("parser.wasm"), "utf8"), "GOWORK=off");
  rmSync(r.dir, { recursive: true, force: true });
});

test("T125-U1-HASHMSG, T125-U4-NOSHA and T125-C4-LICTEXT: each broken parser file gives a ✗ line with its fix, and the other checks still run", () => {
  const r = repo();
  const wasm = readFileSync(r.file("parser.wasm"));
  const check = () => r.run("check");
  const changed = Buffer.from(wasm);
  changed[100] ^= 1;
  writeFileSync(r.file("parser.wasm"), changed);
  let out = check();
  assert.equal(out.status, 1);
  assert.match(out.stderr, /✗ plugins\/sage\/hooks\/parser\/parser\.wasm differs from its recorded hash: its sha256 is [0-9a-f]{64}, and parser\.wasm\.sha256 records [0-9a-f]{64}\. The usual fix is to restore both from git: git checkout HEAD -- plugins\/sage\/hooks\/parser\/parser\.wasm plugins\/sage\/hooks\/parser\/parser\.wasm\.sha256\. After a change to parse\.go, rebuild instead with npm run parser, which needs TinyGo 0\.42\.0 and Go 1\.26\.8 on PATH/);
  writeFileSync(r.file("parser.wasm"), wasm);
  writeFileSync(r.file("parser.wasm.sha256"), "f0ee18da  parser.wasm\n");
  out = check();
  assert.match(out.stderr, /✗ plugins\/sage\/hooks\/parser\/parser\.wasm\.sha256 is not a valid hash record/);
  assert.doesNotMatch(out.stderr, /differs from its recorded hash/);
  rmSync(r.file("parser.wasm.sha256"));
  writeFileSync(r.file("LICENSE-go"), readFileSync(r.file("LICENSE-go"), "utf8").replace("Redistribution", "Distribution"));
  rmSync(r.file("COPYRIGHT-musl"));
  out = check();
  assert.equal(out.status, 1);
  assert.match(out.stderr, /✗ plugins\/sage\/hooks\/parser\/parser\.wasm\.sha256 is missing\. Restore it from git: git checkout HEAD --/);
  assert.match(out.stderr, /✗ plugins\/sage\/hooks\/parser\/THIRD-PARTY\.md: LICENSE-go is not the text that was reviewed/);
  assert.match(out.stderr, /✗ plugins\/sage\/hooks\/parser\/THIRD-PARTY\.md: COPYRIGHT-musl does not ship\. Restore it from git: git checkout HEAD -- plugins\/sage\/hooks\/parser\/COPYRIGHT-musl\n/);
  assert.doesNotMatch(out.stderr, /\n\s+at /, "no stack trace");
  rmSync(r.file("THIRD-PARTY.md"));
  assert.match(check().stderr, /✗ plugins\/sage\/hooks\/parser\/THIRD-PARTY\.md: missing; it lists the licences of the code in parser\.wasm\. Restore it from git: git checkout HEAD -- plugins\/sage\/hooks\/parser\/THIRD-PARTY\.md\n/);
  rmSync(r.dir, { recursive: true, force: true });
});
