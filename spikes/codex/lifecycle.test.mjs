import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Lifecycle } from './lifecycle.mjs';
import { handle, REPORT_FIELDS } from '../../plugins/sage/hooks/sage-hook.mjs';

function permutations(xs) {
  if (!xs.length) return [[]];
  return xs.flatMap((x, i) => permutations(xs.filter((_, j) => i !== j)).map(rest => [x, ...rest]));
}

test('two spawns bind by exact call across every valid start/result/stop ordering', () => {
  const actions = ['begin-a', 'bind-a', 'finish-a', 'begin-b', 'bind-b', 'finish-b'];
  let checked = 0;
  for (const order of permutations(actions)) {
    if (order.indexOf('begin-a') > order.indexOf('finish-a') || order.indexOf('begin-b') > order.indexOf('finish-b')) continue;
    const s = new Lifecycle(2);
    s.reserve('call-a'); s.reserve('call-b');
    for (const event of order) {
      const [kind, id] = event.split('-');
      if (kind === 'begin') s.begin(id, `turn-${id}`);
      if (kind === 'bind') s.bind(`call-${id}`, id);
      if (kind === 'finish') s.finish(id, `turn-${id}`, true);
      assert.ok(s.occupied() >= 0 && s.occupied() <= 2);
    }
    assert.equal(s.state.calls['call-a'].child, 'a');
    assert.equal(s.state.calls['call-b'].child, 'b');
    assert.equal(s.occupied(), 0);
    checked++;
  }
  assert.equal(checked, 180);
});

test('report rejection retains capacity using the existing Sage policy', () => {
  const s = new Lifecycle(1); s.reserve('call'); s.bind('call', 'child'); s.begin('child', 'turn');
  const accepted = text => handle({ hook_event_name: 'SubagentStop', session_id: 'parent', agent_id: 'child', agent_type: 'sage:implementer', last_assistant_message: text }, { sage: true, given: true }, { touch() {}, release() {} })?.decision !== 'block';
  s.finish('child', 'turn', accepted('incomplete'));
  assert.equal(s.occupied(), 1);
  s.finish('child', 'turn', accepted(REPORT_FIELDS.map(x => `${x} none`).join('\n')));
  assert.equal(s.occupied(), 0);
});

test('later child work reserves again; an old stop cannot release its new turn', () => {
  const s = new Lifecycle(1); s.reserve('first'); s.bind('first', 'child'); s.begin('child', 'one'); s.finish('child', 'one', true);
  s.reserve('second', 'child'); s.bind('second', 'child');
  s.finish('child', 'one', true);
  assert.equal(s.occupied(), 1);
  s.begin('child', 'two'); s.finish('child', 'one', true);
  assert.equal(s.occupied(), 1);
  s.finish('child', 'two', true);
  assert.equal(s.occupied(), 0);
});

test('unknown spawn outcome and interruption preserve the cap across a checkpoint', () => {
  let s = new Lifecycle(1); s.reserve('lost-result'); s.interrupt();
  s = new Lifecycle(1, s.snapshot());
  assert.throws(() => s.reserve('another'), /Capacity/);
  assert.throws(() => s.confirmFailure('lost-result', false), /Unverified/);
  assert.equal(s.occupied(), 1);
  s.confirmFailure('lost-result', true);
  assert.equal(s.occupied(), 0);
});

test('duplicate callbacks and confirmed close do not double-release', () => {
  const s = new Lifecycle(1); s.reserve('call'); s.reserve('call'); s.bind('call', 'child'); s.bind('call', 'child');
  s.begin('child', 'turn'); s.begin('child', 'turn');
  assert.throws(() => s.close('child', false), /Unverified/);
  assert.equal(s.occupied(), 1);
  s.close('child', true); s.close('child', true);
  assert.equal(s.occupied(), 0);
  assert.throws(() => s.reserve('new', 'child'), /not idle/);
});

test('ambiguous identity, overlapping work, and stop without start are refused', () => {
  const s = new Lifecycle(2); s.reserve('a'); s.reserve('b'); s.bind('a', 'child');
  assert.throws(() => s.bind('b', 'child'), /already bound/);
  assert.throws(() => s.finish('child', 'unknown', true), /Unverified/);
  s.begin('child', 'one');
  assert.throws(() => s.begin('child', 'two'), /Overlapping/);
  assert.equal(s.occupied(), 2);
});

test('confirmed close before binding releases only its exact reservation', () => {
  const s = new Lifecycle(2); s.reserve('a'); s.reserve('b');
  s.close('child-a', true); s.bind('a', 'child-a');
  assert.equal(s.occupied(), 1);
  assert.equal(s.state.calls.b.phase, 'reserved');
});

test('idle or unknown children cannot start work without a reservation', () => {
  const s = new Lifecycle(1);
  assert.throws(() => s.begin('unknown', 'turn'), /Unreserved/);
  s.reserve('a'); s.bind('a', 'child'); s.begin('child', 'one'); s.finish('child', 'one', true);
  assert.throws(() => s.begin('child', 'two'), /Unreserved/);
});

test('a report repair can continue into a new turn without another slot', () => {
  const s = new Lifecycle(1); s.reserve('a'); s.bind('a', 'child'); s.begin('child', 'one');
  s.finish('child', 'one', false); s.begin('child', 'repair');
  assert.equal(s.occupied(), 1);
  assert.throws(() => s.finish('child', 'one', true), /Unverified/);
  s.finish('child', 'repair', true);
  assert.equal(s.occupied(), 0);
});

test('one unknown spawn result cannot admit multiple unbound workers', () => {
  const s = new Lifecycle(1); s.reserve('a'); s.begin('child', 'one');
  assert.throws(() => s.begin('extra', 'two'), /Unreserved/);
  s.finish('child', 'one', true);
  assert.throws(() => s.begin('extra', 'three'), /Unreserved/);
  assert.equal(s.occupied(), 1);
});
