import { spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const templateRoot = resolve(
  process.env.EMDASH_MIKA_TEMPLATE_ROOT ?? join(root, "../emdash-mika-template"),
);
const docsRoot = resolve(process.env.EMDASH_MIKA_DOCS_ROOT ?? join(root, "../emdash-mika-docs"));
const tempRoot = mkdtempSync(join(tmpdir(), "emdash-mika-release-"));
const packageJson = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const packageName = packageJson.name;
const npmExecPath = process.env.npm_execpath;
const npmCommand = npmExecPath ? process.execPath : "npm";
const npmPrefix = npmExecPath ? [npmExecPath] : [];

try {
  assertSiblingProject(templateRoot, "emdash-mika-template");
  assertSiblingProject(docsRoot, "emdash-mika-docs");

  const artifact = packRelease();
  verifyCleanConsumer(artifact);
  verifyTemplate(artifact);
  verifyDocs();
  console.log("Release artifact, clean consumer, demo, and docs checks passed.");
} finally {
  rmSync(tempRoot, { force: true, recursive: true });
}

function packRelease() {
  const artifactDir = join(tempRoot, "artifact");
  mkdirSync(artifactDir);
  const output = runNpm(root, ["pack", "--silent", "--json", "--pack-destination", artifactDir], {
    capture: true,
  });
  const manifestStart = output.lastIndexOf("\n[\n  {");
  const result = JSON.parse(output.slice(manifestStart < 0 ? 0 : manifestStart + 1));
  const packed = result[0];
  if (!packed?.filename || !Array.isArray(packed.files)) {
    throw new Error("npm pack did not return the expected artifact manifest.");
  }

  const artifact = join(artifactDir, packed.filename);
  if (!existsSync(artifact)) throw new Error(`Packed artifact is missing: ${artifact}`);

  const forbiddenPaths = [root, templateRoot, docsRoot];
  for (const file of packed.files) {
    if (!file?.path || file.size === 0 || file.size > 2_000_000) continue;
    const packedPath = join(root, file.path);
    if (!existsSync(packedPath)) continue;
    const source = readFileSync(packedPath, "utf8");
    for (const forbiddenPath of forbiddenPaths) {
      if (source.includes(forbiddenPath)) {
        throw new Error(`Packed file leaks a local source path: ${file.path}`);
      }
    }
    if (/\b(?:file|link):\.\.\/emdash-mika\b/u.test(source)) {
      throw new Error(`Packed file leaks the local Mika dependency: ${file.path}`);
    }
  }

  return artifact;
}

function verifyCleanConsumer(artifact) {
  const consumerRoot = join(tempRoot, "consumer");
  cpSync(join(root, "test/fixtures/release-consumer"), consumerRoot, { recursive: true });
  runNpm(consumerRoot, ["ci", "--ignore-scripts", "--no-audit", "--no-fund"]);
  runNpm(consumerRoot, [
    "install",
    "--ignore-scripts",
    "--no-audit",
    "--no-fund",
    "--no-save",
    "--package-lock=false",
    artifact,
  ]);

  const exportSpecifiers = Object.keys(packageJson.exports)
    .filter((subpath) => !subpath.includes("*"))
    .map((subpath) => (subpath === "." ? packageName : `${packageName}/${subpath.slice(2)}`));
  const typeImports = exportSpecifiers
    .map(
      (specifier, index) =>
        `import * as entry${index} from ${JSON.stringify(specifier)};\nvoid entry${index};`,
    )
    .join("\n");
  writeFileSync(join(consumerRoot, "imports.ts"), `${typeImports}\n`, "utf8");
  writeJson(join(consumerRoot, "tsconfig.json"), {
    compilerOptions: {
      lib: ["ES2023", "DOM", "DOM.Iterable"],
      module: "NodeNext",
      moduleResolution: "NodeNext",
      noEmit: true,
      skipLibCheck: true,
      strict: true,
      types: ["astro/client"],
    },
    include: ["imports.ts"],
  });

  const runtimeSpecifiers = exportSpecifiers.filter(
    (specifier) => specifier !== `${packageName}/astro-actions`,
  );
  writeFileSync(
    join(consumerRoot, "smoke.mjs"),
    [
      'import assert from "node:assert/strict";',
      'import { createRequire } from "node:module";',
      `const specifiers = ${JSON.stringify(runtimeSpecifiers)};`,
      "for (const specifier of specifiers) await import(specifier);",
      `const types = await import(${JSON.stringify(`${packageName}/types`)});`,
      'assert.equal(types.createMikaId(" release-smoke "), "release-smoke");',
      "const require = createRequire(import.meta.url);",
      'for (const templatePath of ["README.md", "pages/.well-known/mika-agent.json.ts"]) {',
      `  const template = require.resolve(${JSON.stringify(`${packageName}/templates/astro/`)} + templatePath).replaceAll("\\\\", "/");`,
      "  assert.ok(template.endsWith(`/node_modules/@bnomei/emdash-mika/src/templates/astro/${templatePath}`));",
      "}",
      "console.log(`Imported ${specifiers.length} runtime entry points from the packed package.`);",
      "",
    ].join("\n"),
    "utf8",
  );

  run(resolveBin(consumerRoot, "tsc"), ["--project", "tsconfig.json"], consumerRoot);
  run(process.execPath, ["smoke.mjs"], consumerRoot);
  assertInstalledArtifact(consumerRoot);
}

function verifyTemplate(artifact) {
  const candidateRoot = copyProject(templateRoot, "template");
  const manifestPath = join(candidateRoot, "package.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  manifest.dependencies[packageName] = `file:${artifact}`;
  writeJson(manifestPath, manifest);
  runNpm(candidateRoot, [
    "install",
    "--package-lock-only",
    "--ignore-scripts",
    "--no-audit",
    "--no-fund",
  ]);
  runNpm(candidateRoot, ["ci", "--no-audit", "--no-fund"]);
  assertInstalledArtifact(candidateRoot);
  runNpm(candidateRoot, ["rebuild", "better-sqlite3", "--foreground-scripts"]);

  const env = { EMDASH_MIKA_TEMPLATE_SKIP_LOCAL_BUILD: "1" };
  runNpm(candidateRoot, ["run", "typecheck"], { env });
  runNpm(candidateRoot, ["test"], { env });
  runNpm(candidateRoot, ["run", "build"], { env });
}

function verifyDocs() {
  const candidateRoot = copyProject(docsRoot, "docs");
  runNpm(candidateRoot, ["ci", "--no-audit", "--no-fund"]);
  runNpm(candidateRoot, ["run", "build"]);
}

function copyProject(sourceRoot, name) {
  const candidateRoot = join(tempRoot, name);
  const excluded = new Set([".astro", ".emdash", ".git", "dist", "node_modules"]);
  cpSync(sourceRoot, candidateRoot, {
    recursive: true,
    filter(source) {
      const path = relative(sourceRoot, source);
      if (!path) return true;
      return !excluded.has(path.split(sep)[0]);
    },
  });
  return candidateRoot;
}

function assertInstalledArtifact(projectRoot) {
  const installedRoot = realpathSync(join(projectRoot, "node_modules", "@bnomei", "emdash-mika"));
  const expectedRoot = realpathSync(join(projectRoot, "node_modules")) + sep;
  if (!installedRoot.startsWith(expectedRoot)) {
    throw new Error(`Mika resolved outside the consumer node_modules: ${installedRoot}`);
  }

  const installedPackage = JSON.parse(readFileSync(join(installedRoot, "package.json"), "utf8"));
  for (const field of [
    "dependencies",
    "devDependencies",
    "optionalDependencies",
    "peerDependencies",
  ]) {
    for (const value of Object.values(installedPackage[field] ?? {})) {
      if (typeof value === "string" && /^(?:file|link):/u.test(value)) {
        throw new Error(
          `Installed Mika package contains a local-path ${field} dependency: ${value}`,
        );
      }
    }
  }

  console.log(`Resolved ${packageName} from ${relative(projectRoot, installedRoot)}.`);
}

function assertSiblingProject(projectRoot, name) {
  if (!existsSync(join(projectRoot, "package.json"))) {
    throw new Error(
      `${name} is required at ${projectRoot}. Override its location with the matching EMDASH_MIKA_*_ROOT environment variable.`,
    );
  }
}

function runNpm(cwd, args, options = {}) {
  return run(npmCommand, [...npmPrefix, ...args], cwd, options);
}

function run(command, args, cwd, options = {}) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    env: { ...process.env, ...options.env },
    stdio: options.capture ? "pipe" : "inherit",
  });
  if (result.status !== 0) {
    throw new Error(
      [
        `${command} ${args.join(" ")} failed in ${cwd}.`,
        result.stdout?.trim(),
        result.stderr?.trim(),
      ]
        .filter(Boolean)
        .join("\n"),
    );
  }
  return result.stdout ?? "";
}

function resolveBin(projectRoot, name) {
  return process.platform === "win32"
    ? join(projectRoot, "node_modules", ".bin", `${name}.cmd`)
    : join(projectRoot, "node_modules", ".bin", name);
}

function writeJson(path, value) {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}
