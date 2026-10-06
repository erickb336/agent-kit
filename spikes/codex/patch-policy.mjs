import { handle } from '../../plugins/sage/hooks/sage-hook.mjs';

// Strict path decoder, not a replacement for Codex's full patch parser.
// Unsupported syntax is refused. Native syntax acceptance still needs live tests.
export function patchPaths(patch) {
  if (typeof patch !== 'string' || patch.includes('\0')) throw new Error('Invalid patch');
  const lines = patch.replace(/\r\n/g, '\n').trim().split('\n');
  if (lines.shift() !== '*** Begin Patch' || lines.pop() !== '*** End Patch') throw new Error('Unsupported patch envelope');
  const paths = [];
  let action = null, body = false, moved = false;
  for (const line of lines) {
    const header = /^\*\*\* (Add|Update|Delete) File: (.+)$/.exec(line);
    if (header) {
      action = header[1]; body = false; moved = false;
      paths.push(header[2]);
    } else if (line.startsWith('*** Move to: ')) {
      const path = line.slice('*** Move to: '.length);
      if (action !== 'Update' || body || moved || !path) throw new Error('Unsupported move');
      paths.push(path); moved = true;
    } else if (action === 'Add' && line.startsWith('+')) {
      body = true;
    } else if (action === 'Update' && (line === '*** End of File' || line.startsWith('@@') || /^[ +\-]/.test(line))) {
      body = true;
    } else {
      throw new Error('Unsupported patch body');
    }
  }
  if (!paths.length) throw new Error('Empty patch');
  return [...new Set(paths)];
}

export function patchDecision(input, actor, state) {
  if (!actor || !['chief', 'child'].includes(actor.kind) || (actor.kind === 'child' && (!actor.id || !actor.role))) throw new Error('Unverified actor');
  const paths = patchPaths(input.tool_input?.command);
  // File checks have no state writes. Return one decision for the entire patch.
  for (const file_path of paths) {
    const event = { ...input, hook_event_name: 'PreToolUse', tool_name: 'Edit', tool_input: { file_path } };
    if (actor.kind === 'child') Object.assign(event, { agent_id: actor.id, agent_type: `sage:${actor.role}` });
    else { delete event.agent_id; delete event.agent_type; }
    const decision = handle(event, state, { touch() {} });
    if (decision?.hookSpecificOutput?.permissionDecision === 'deny') return decision;
  }
}
