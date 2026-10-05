// Preloaded (node --import) into every command that sage.test.mjs starts. A process.kill on any pid but the process's
// own is written to $SAGE_TEST_KILLS as "<pid> <signal>" and never sent, so a test sees it and no real process gets it.
import { appendFileSync } from "node:fs";

const kill = process.kill.bind(process);
process.kill = (pid, signal = "SIGTERM") => {
  if (Number(pid) === process.pid) return kill(pid, signal);
  appendFileSync(process.env.SAGE_TEST_KILLS, `${pid} ${signal}\n`);
  return true;
};
