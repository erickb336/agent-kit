import { buildSync } from "esbuild";
import { readdirSync } from "node:fs";
import { join, resolve, relative, sep } from "node:path";

const names = ["sage-core", "sage-claude", "sage-codex"];
const files = directory => readdirSync(directory, { withFileTypes: true }).flatMap(entry =>
  entry.isDirectory() ? files(join(directory, entry.name)) : entry.name.endsWith(".mjs") && !entry.name.endsWith(".test.mjs") ? [join(directory, entry.name)] : []);

/** Check the resolved static import graph; do not execute package code. */
export function packageBoundaryProblems(root) {
  const entryPoints = names.flatMap(name => files(join(root, "packages", name)));
  const { metafile } = buildSync({ absWorkingDir: root, entryPoints, outdir: join(root, ".package-boundary-check"),
    bundle: true, write: false, platform: "node", format: "esm", packages: "external", metafile: true, logLevel: "silent" });
  const owner = file => {
    const parts = relative(join(root, "packages"), resolve(root, file)).split(sep);
    return names.includes(parts[0]) ? parts[0] : undefined;
  };
  const problems = [];
  for (const [file, details] of Object.entries(metafile.inputs)) {
    const from = owner(file);
    if (!from) continue;
    for (const edge of details.imports) {
      const to = edge.external ? names.find(name => edge.path === name || edge.path.startsWith(`${name}/`)) : owner(edge.path);
      const moduleUrl = edge.external && !edge.path.startsWith("node:") && /^[a-z][a-z0-9+.-]*:/i.test(edge.path);
      if (edge.external && !to && !moduleUrl) continue; // Node builtins and third-party dependencies have separate version checks.
      if (edge.external && edge.path === "sage-core" && from !== "sage-core" && edge.kind !== "require-call") continue;
      if (!edge.external && to === from) continue;
      problems.push(`${file}: ${edge.original ?? edge.path} crosses a package boundary; providers use only the sage-core public entry point`);
    }
  }
  return problems;
}
