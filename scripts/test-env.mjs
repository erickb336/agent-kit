// Imported first by every test file. It removes the variables of the developer's shell that change what sage, git, gh or
// the fakes do, so that a test gives the same result on every machine: in a sage session (SAGE_PROJECT, SAGE_HOOKS), in a
// git hook (GIT_DIR, GIT_WORK_TREE), with a GitHub token or host (GITHUB_TOKEN, GH_HOST), or with another Claude config.
// Two stay, SAGE_HOME and GH_CONFIG_DIR: a test that forgot its own must not fall back to the real ~/.claude or gh login.
const LEAKS = /^(?:SAGE_(?!HOME$)|GIT_|GH_(?!CONFIG_DIR$)|GITHUB_|CLAUDE_|AGENT_KIT_|FAKE_GH_|PSTACK_)/;
for (const name of Object.keys(process.env)) if (LEAKS.test(name)) delete process.env[name];
// Git reads the developer's global config (~/.gitconfig or $XDG_CONFIG_HOME/git/config) and the system one: a
// commit.gpgsign or core.hooksPath there fails every commit a test makes (R679). /dev/null replaces both global files.
process.env.GIT_CONFIG_GLOBAL = "/dev/null";
process.env.GIT_CONFIG_NOSYSTEM = "1";
