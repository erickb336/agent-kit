# Bound child instructions

`boundChildInstructions(options, identity)` first verifies the native child
binding. It then renders that assignment's saved role, shared operating
instructions, report format, and complete task brief. The header gives the
assignment ID, task, and run. The caller must obtain identity from the current
verified child-start boundary; model arguments cannot supply it.

Provider setup text comes from the packaged `role-bindings.json`. Task text
cannot replace those bindings or select a different role. Missing instructions
or an absent saved brief cause an error. A legacy reservation receives no
invented task instructions. An error does not release its occupied capacity.

The function returns the existing child-start delivery contract. That hook does
not stop a native child, and a delivery error is not a rollback of its verified
binding. Full tool policies and lifecycle handling remain required. Set the
native context limit high enough for the entire assembled text before installing
this adapter. The brief alone can reach 32 KiB.

An isolated native check verifies the complete assembled text in the lead's and
nested QA agent's first model requests. It uses local mock responses and a test
policy. Chief instructions, required skill preloads, compaction restoration,
report acceptance, and enforcement of the full workflow remain separate work.
