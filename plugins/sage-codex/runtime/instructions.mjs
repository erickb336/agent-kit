import { readFileSync } from "node:fs";
import { renderRoleInstructions, renderReportInstructions, renderBrief } from "../core/index.mjs";
import { bindNativeChild } from "./child-binding.mjs";

/** Deliver only the role and brief attached to this verified native child. */
export function boundChildInstructions(options, identity) {
  const result = bindNativeChild(options, identity);
  if (!result.brief) throw Error("The native child has no saved task brief");
  const bindings = JSON.parse(readFileSync(new URL("../role-bindings.json", import.meta.url), "utf8"));
  const role = renderRoleInstructions(result.role, { ...bindings.common, ...bindings[result.role] });
  const report = renderReportInstructions(bindings.report);
  const assignment = result.assignment;
  return { decision: "deliver", brief: [
    `Role: ${result.role}\nAssignment: ${assignment.id}\nTask: ${assignment.task}\nRun: ${assignment.run}`,
    role, report, "# Task brief\n\n" + renderBrief(result.brief),
  ].join("\n\n") };
}
