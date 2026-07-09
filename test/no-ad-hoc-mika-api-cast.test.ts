/**
 * Guardrail test: dynamic API casts stay localized to operation-define.ts.
 * Roadmap-followup F2.3.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vite-plus/test";

const SRC_ROOT = join(import.meta.dirname, "../src");
const ALLOWLIST = new Set(["api/operation-define.ts"]);

const FORBIDDEN = [
  /as\s+unknown\s+as\s+MikaApi\b/,
  /as\s+any\s+as\s+MikaApi\b/,
  /as\s+unknown\s+as\s+Record<string,\s*Record<string,\s*unknown>>/,
  /as\s+any\s+as\s+Record<string,\s*Record<string,\s*unknown>>/,
];

function walkTsFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    const st = statSync(path);
    if (st.isDirectory()) walkTsFiles(path, out);
    else if (name.endsWith(".ts") || name.endsWith(".tsx")) out.push(path);
  }
  return out;
}

describe("F2.3 no ad-hoc MikaApi casts", () => {
  it("forbids dynamic API double-casts outside operation-define.ts", () => {
    const offenders: string[] = [];
    for (const file of walkTsFiles(SRC_ROOT)) {
      const rel = relative(SRC_ROOT, file).replaceAll("\\", "/");
      if (ALLOWLIST.has(rel)) continue;
      const source = readFileSync(file, "utf8");
      for (const pattern of FORBIDDEN) {
        if (pattern.test(source)) offenders.push(`${rel} matches ${pattern}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
