import { realpathSync, existsSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

export interface ReviewEnvironment {
  source: "host-observed";
  authorization: "none";
  cwd: string;
  installations: Array<{ packageName: string; root: string }>;
  configuredReadRoots: string[];
}
/** Observe installation identity only. Neither these facts nor a project file grant authority. */
export function reviewEnvironment(cwd: string, roots: readonly string[] = []): ReviewEnvironment {
  const installations: ReviewEnvironment["installations"] = [];
  const require = createRequire(import.meta.url);
  for (const [name, entry] of [["@erichll/pi-auto-review", fileURLToPath(import.meta.url)], ["@gotgenes/pi-permission-system", undefined]] as const) {
    try {
      let root = dirname(entry ?? require.resolve(name));
      for (let depth = 0; depth < 6; depth++) {
        const manifest = join(root, "package.json");
        if (existsSync(manifest) && JSON.parse(readFileSync(manifest, "utf8")).name === name) { installations.push({ packageName: name, root: realpathSync(root) }); break; }
        const parent = dirname(root); if (parent === root) break; root = parent;
      }
    } catch { /* Missing installations are unknown, not invented. */ }
  }
  const configuredReadRoots = roots.filter(isAbsolute).flatMap(root => { try { return [realpathSync(root)]; } catch { return []; } });
  return { source: "host-observed", authorization: "none", cwd, installations, configuredReadRoots };
}
