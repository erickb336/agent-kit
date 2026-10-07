# Bind a native child to an assignment

`bindNativeChild(configuration, identity)` joins a verified child start to one
role reservation in the configured project and current session epoch. Its input
must come from `nativeChildStart` on the current trusted connection. Calling this
function with arbitrary JSON does not authenticate an agent.

The configured `observationsDirectory` must contain authenticated native request,
successful result, and child-start records. Their exact join must name the admitted
call, parent turn, parent actor, child, and path. A held name alone is insufficient:
a failed spawn can leave that name available for an unadmitted call. Missing,
conflicting, or reused paths refuse binding. The launcher must record these events
through trusted hooks, including spawns while mode is off. A capture gap requires
reconciliation. Arbitrary files are not native authority. A second same-name
request is ambiguous even before its result arrives. The adapter does
not wait for a missing result, and cannot yet resolve delivery before result
publication. A saved receipt is retained, but conflicting native observations still
prevent this adapter from supplying it as current role authority.

The adapter derives each parent's path and role from saved bindings and admitted
assignments. The root is the chief. A nested child requires a bound parent. The
child path must extend that exact parent path by the reserved name. Exactly one
reservation must match. Its recorded issuer role must match the bound parent.
The shared journal atomically binds the assignment to the child, so conflicting
initial identities cannot both win.

The result contains the saved assignment, binding, and role. It is not permission
to run tools or proof of instruction delivery. The trusted start policy must load
the matching durable brief, and tool policy must check current mode, task scope,
and role. Those policies and durable brief storage remain integration work.
The adapter does not start agents or clear reservations.
