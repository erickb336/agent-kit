import { realpathSync } from "node:fs";
import { modeSignals, activateAdmission, changeAdmissionMode, readAdmission } from "sage-core";
import { nativeOwnerPrompt } from "./owner.mjs";
import { readSessionIdentity } from "./identity.mjs";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const sessionKey = session => {
  if (typeof session !== "string" || !UUID.test(session)) throw Error("Invalid native session");
  return `codex:${session}`;
};

/** Read policy state only; the tool boundary must independently verify its native actor. */
export function readMode(directory, project, session) {
  const key = sessionKey(session);
  const snapshot = readAdmission(directory);
  if (!snapshot.config.projects.some(row => row.project === project)) throw Error("Project is not configured");
  const owner = snapshot.sessions.find(row => row.project === project && row.session === key);
  const modes = owner ? snapshot.modes.filter(row => row.project === project && row.session === key && row.epoch === owner.epoch) : [];
  return { owner, modes, sage: modes.at(-1)?.sage ?? false };
}

/** Options come from the configured project, never from the prompt or model arguments. */
export function updateOwnerMode(input, context, { directory, project, projectDirectory, sessionsDir }) {
  if (realpathSync(projectDirectory) !== projectDirectory || input?.cwd !== projectDirectory) return null;
  const metadata = readSessionIdentity(input.transcript_path, { sessionsDir });
  const prompt = nativeOwnerPrompt(input, context, metadata);
  if (!prompt) return null;
  const signals = modeSignals({ owner: true, text: prompt.text, outside: prompt.text, all: prompt.text });
  const before = readMode(directory, project, prompt.session);
  if (!before.owner) {
    if (signals.sageOn || signals.sageOff) {
      activateAdmission(directory, { project, session: sessionKey(prompt.session), activation: prompt.turn }, { sage: !signals.sageOff });
    }
  } else if (signals.sageOn || signals.sageOff) {
    const sage = !signals.sageOff;
    const earlier = before.modes.find(row => row.turn === prompt.turn);
    if (earlier?.after === null) {
      if (earlier.sage !== sage) throw Error("Activation turn has a different mode request");
    } else {
      changeAdmissionMode(directory, { project, session: before.owner.session, epoch: before.owner.epoch,
        after: earlier?.after ?? before.modes.at(-1).turn, turn: prompt.turn, sage });
    }
  }
  const current = readMode(directory, project, prompt.session);
  return { kind: "owner-mode", project, session: prompt.session, turn: prompt.turn,
    sage: current.sage, autopilot: false, signals };
}
