// In-memory policy prototype. No claims about native event delivery or cross-process locking.
export class Lifecycle {
  constructor(limit, snapshot = { calls: {}, children: {} }) {
    if (!Number.isInteger(limit) || limit < 1) throw new Error('Invalid capacity');
    this.limit = limit;
    this.state = structuredClone(snapshot);
  }
  snapshot() { return structuredClone(this.state); }
  occupied() { return Object.values(this.state.calls).filter(x => x.phase !== 'released').length; }
  child(id) {
    if (!id) throw new Error('Missing child identity');
    return this.state.children[id] ??= { call: null, turn: null, finished: [], bound: false, closed: false, repair: false, observed: false };
  }
  reserve(callId, childId = null) {
    if (!callId) throw new Error('Missing call identity');
    const prior = this.state.calls[callId];
    if (prior) {
      if (prior.target !== childId) throw new Error('Conflicting repeated call');
      return prior.phase;
    }
    if (this.occupied() >= this.limit) throw new Error('Capacity occupied');
    const child = childId ? this.state.children[childId] : null;
    if (childId && (!child || child.call || child.turn || child.closed)) throw new Error('Child is not idle');
    this.state.calls[callId] = { target: childId, child: childId, phase: 'reserved' };
    if (child) child.call = callId;
    return 'reserved';
  }
  begin(childId, turnId) {
    if (!turnId) throw new Error('Missing turn identity');
    const child = this.child(childId);
    if (child.closed) throw new Error('Child is closed');
    if (child.finished.includes(turnId)) return; // delayed duplicate of an old turn
    const pendingSpawns = Object.values(this.state.calls).filter(x => !x.target && !x.child && x.phase === 'reserved').length;
    const unboundChildren = Object.values(this.state.children).filter(x => x.observed && !x.bound).length;
    if (!child.call && (child.bound || pendingSpawns < unboundChildren + Number(!child.observed))) throw new Error('Unreserved child work');
    if (child.turn && child.turn !== turnId && !child.repair) throw new Error('Overlapping child turns');
    child.turn = turnId;
    child.observed = true;
    child.repair = false;
    if (child.call) this.state.calls[child.call].phase = 'running';
  }
  bind(callId, childId) {
    const call = this.state.calls[callId];
    if (!call) throw new Error('Unreserved call');
    if (call.child && call.child !== childId) throw new Error('Conflicting child identity');
    if (call.phase === 'released') return;
    const child = this.child(childId);
    if (call.child === childId && child.bound) return;
    if (child.call && child.call !== callId) throw new Error('Child already bound');
    if (!call.target && child.bound) throw new Error('Spawn returned an existing child');
    call.child = childId;
    // A new child's first turn may finish before its spawn result reaches the hook.
    if (child.closed || (!call.target && !child.bound && child.finished.length && !child.turn)) {
      call.phase = 'released';
    } else {
      child.call = callId;
      call.phase = child.turn ? 'running' : 'reserved';
    }
    child.bound = true;
  }
  finish(childId, turnId, acceptedReport) {
    const child = this.child(childId);
    if (child.finished.includes(turnId)) return;
    if (!turnId || child.turn !== turnId) throw new Error('Unverified turn completion');
    if (!acceptedReport) { child.repair = true; return; } // repair keeps the same capacity reservation
    child.finished.push(turnId);
    child.turn = null;
    child.repair = false;
    if (child.call) this.state.calls[child.call].phase = 'released';
    child.call = null;
  }
  confirmFailure(callId, verified) {
    if (!verified) throw new Error('Unverified failure');
    const call = this.state.calls[callId];
    if (!call || call.child) throw new Error('Failure does not prove child closure');
    call.phase = 'released';
  }
  close(childId, verified) {
    if (!verified) throw new Error('Unverified closure');
    const child = this.child(childId);
    if (child.call) this.state.calls[child.call].phase = 'released';
    child.call = null;
    child.turn = null;
    child.closed = true;
  }
  interrupt() { /* Missing outcomes retain capacity; interruption is not proof of closure. */ }
}
