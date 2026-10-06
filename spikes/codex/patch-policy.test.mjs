import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, mkdirSync, symlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { patchPaths, patchDecision } from './patch-policy.mjs';

const patch = body => `*** Begin Patch\n${body}\n*** End Patch`;
test('all add/update/delete paths and move destinations are decoded', () => {
  assert.deepEqual(patchPaths(patch('*** Add File: a.js\n+x\n*** Update File: b.js\n*** Move to: c.js\n@@\n-old\n+new\n*** Delete File: d.js')), ['a.js', 'b.js', 'c.js', 'd.js']);
});
test('header-like text in file contents does not create a path', () => {
  assert.deepEqual(patchPaths(patch('*** Add File: a.js\n+*** Add File: fake.js')), ['a.js']);
});
test('unsupported envelopes, controls, moves and missing paths are refused', () => {
  for (const text of ['echo hello', patch('*** Add File: '), patch('*** Unknown: a'), patch('*** Add File: a\n*** Move to: b'), patch('*** Update File: a\n@@\n+x\n*** Move to: b'), patch('*** Update File: a\n*** Move to: b\n*** Move to: c')]) assert.throws(() => patchPaths(text));
});
test('the shared Sage rule rejects a chief patch and an unknown actor', () => {
  const input = { cwd: tmpdir(), tool_input: { command: patch('*** Add File: a.js\n+x') } };
  assert.equal(patchDecision(input, { kind: 'chief' }, { sage: true }).hookSpecificOutput.permissionDecision, 'deny');
  assert.throws(() => patchDecision(input, null, { sage: true }), /Unverified/);
});
test('one protected path denies a whole worker patch, including move and symlink targets', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sage-codex-patch-'));
  const previous = process.env.SAGE_HOME;
  try {
    process.env.SAGE_HOME = join(dir, 'logbook'); mkdirSync(process.env.SAGE_HOME);
    symlinkSync(process.env.SAGE_HOME, join(dir, 'alias'));
    const actor = { kind: 'child', id: 'worker', role: 'implementer' };
    const decision = body => patchDecision({ cwd: dir, tool_input: { command: patch(body) } }, actor, { sage: true });
    assert.equal(decision('*** Add File: normal.js\n+x'), undefined);
    for (const path of ['logbook/tasks.tsv', 'alias/tasks.tsv', 'src/../logbook/tasks.tsv']) {
      assert.equal(decision(`*** Add File: normal.js\n+x\n*** Add File: ${path}\n+y`).hookSpecificOutput.permissionDecision, 'deny');
      assert.equal(decision(`*** Update File: normal.js\n*** Move to: ${path}\n@@\n-x\n+y`).hookSpecificOutput.permissionDecision, 'deny');
    }
  } finally {
    if (previous === undefined) delete process.env.SAGE_HOME; else process.env.SAGE_HOME = previous;
    rmSync(dir, { recursive: true, force: true });
  }
});
