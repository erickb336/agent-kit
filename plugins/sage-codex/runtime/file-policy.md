# Direct file edits

`directEditDecision` applies the shared chief rule to the verified native `apply_patch` tool name. The caller must establish active Sage mode and chief identity. A root actor alone is not proof that Sage mode is active.

An active chief cannot make a direct file change. A child, an inactive session or another tool passes this one check and must still pass the remaining Sage and native checks. This module does not validate patch paths, protect the logbook or control shell writes. It is not a complete tool policy.

The native policy adapter converts invalid context or loading failures into explicit denial. No installed hook calls this policy yet. Native V2 task messages are encrypted, so brief validation must use a separately verified readable source; do not apply the existing brief matcher to that message field.

Native checks use a required, hidden-hook-only MCP server with connection startup readiness. A visible tool in its cached catalog can defer child startup, so the first patch can miss the hook. With the hidden-only catalog, the child's first patch reaches the policy. Keep model-visible tools on a separate server. The tested mode and chief flags are fixture inputs; production ownership still needs integration.
