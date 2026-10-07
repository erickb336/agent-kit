# Native policy composition

`createNativePolicy(options, evaluateTool)` joins the prepared native adapters.
The launcher supplies validated configuration and a complete tool policy.
There is no default tool policy. This module is not an installed entry point.

The MCP boundary authenticates each tool actor, dispatch result, and child
start before calling this interface. Tool evaluation records recognized
identity events even when Sage is off or the tool policy denies the request.
It then calls the supplied tool policy with a private input copy and the native
actor, version, and current Sage mode. Only an exact pass or denial is accepted.
A mode change during evaluation refuses the operation. This check does not
revoke native permission after it returns. A successful spawn in
Sage mode must also consume a prepared assignment exactly once. Retries do not
issue another permission. The callback cannot change the reserved input by
mutating its copy.

Dispatch results are recorded independently of mode. Child starts are recorded
before instruction assembly. When Sage is on, assembly requires the complete
binding evidence and saved brief. When Sage is off, the start passes without
Sage instructions. Missing evidence causes an error and retains capacity; this
module does not wait for a late dispatch result. A child-start error cannot stop
a native child, so delivery is not enforcement.

The supplied tool policy must enforce command, path, role, and workflow rules,
including follow-up and message permissions. This composition does not invent
those rules or authorize operations the callback rejects. It does not detect
missing callbacks, accept reports, release slots, restore compacted context,
or provide lifecycle recovery. Those remain required before activation.
