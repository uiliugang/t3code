#!/usr/bin/env node
// @effect-diagnostics nodeBuiltinImport:off globalConsole:off - A one-shot CI check; synchronous Node APIs keep it small.
// Fails when a committed GT catalog drifts from the source: `gt generate` would write a different
// en.json, or a locale catalog's keys differ from en.json. Needs no GT credentials or network.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

const TRANSLATED_SOURCES = ["apps/web/src", "apps/mobile/src"];
// Desktop only depends on gt-i18n, so the gt CLI hides `generate` there; its script adds it back.
const GENERATE: Record<string, readonly [string, ...string[]]> = {
  "apps/web": ["node_modules/.bin/gt", "generate"],
  "apps/mobile": ["node_modules/.bin/gt", "generate"],
  "apps/desktop": [process.execPath, "scripts/i18n-generate.mjs"],
};
const APPS = Object.keys(GENERATE);

// JSX entries (`<T>`) are arrays and objects, so values compare by their JSON text.
type Catalog = Record<string, unknown>;
const readJson = (file: string) => JSON.parse(NodeFS.readFileSync(file, "utf8"));
const missingFrom = (from: Catalog, catalog: Catalog) =>
  Object.keys(from).filter((key) => !Object.hasOwn(catalog, key));

const root = NodePath.resolve(import.meta.dirname, "..");
// Computed so the scripts project does not need to list the shared sources in its composite.
const uiLocaleModule = (await import(
  new URL("../packages/shared/src/uiLocale.ts", import.meta.url).href
)) as {
  readonly hasUiTranslation: (message: string) => boolean;
  readonly translateUi: (locale: "zh-CN", message: string) => string;
};
const { hasUiTranslation, translateUi } = uiLocaleModule;
const syncForkChinese = process.argv.includes("--sync-fork-zh");
const problems: string[] = [];

for (const [app, [command, ...args]] of Object.entries(GENERATE)) {
  const appDir = NodePath.join(root, app);
  const config = readJson(NodePath.join(appDir, "gt.config.json"));
  const catalogDir = NodePath.join(appDir, NodePath.dirname(config.files.gt.output));
  const source: Catalog = readJson(NodePath.join(catalogDir, `${config.defaultLocale}.json`));

  // Same scan as `vp run i18n:generate`, but it writes only the source catalog, to a temp dir.
  const tmp = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "i18n-check-"));
  try {
    const tmpConfig = NodePath.join(tmp, "gt.config.json");
    NodeFS.writeFileSync(
      tmpConfig,
      JSON.stringify({ ...config, locales: [], files: { gt: { output: `${tmp}/[locale].json` } } }),
    );
    const gt = NodeChildProcess.spawnSync(command, [...args, "--config", tmpConfig], {
      cwd: appDir,
      encoding: "utf8",
    });
    if (gt.status !== 0) {
      problems.push(`${app}: gt generate failed\n${gt.stdout}${gt.stderr}`);
      continue;
    }
    const generated: Catalog = readJson(NodePath.join(tmp, `${config.defaultLocale}.json`));
    for (const [key, text] of Object.entries(generated)) {
      if (!Object.hasOwn(source, key)) {
        problems.push(`${app}: ${key} ${JSON.stringify(text)} is missing from en.json`);
      } else if (JSON.stringify(source[key]) !== JSON.stringify(text)) {
        problems.push(
          `${app}: en.json has ${key} ${JSON.stringify(source[key])}, source says ${JSON.stringify(text)}`,
        );
      }
    }
    for (const key of missingFrom(source, generated)) {
      problems.push(`${app}: ${key} ${JSON.stringify(source[key])} in en.json is stale`);
    }
  } finally {
    NodeFS.rmSync(tmp, { recursive: true, force: true });
  }

  for (const locale of config.locales) {
    const catalogPath = NodePath.join(catalogDir, `${locale}.json`);
    const catalog: Catalog = readJson(catalogPath);
    if (locale === "zh") {
      let changed = false;
      for (const [key, message] of Object.entries(source)) {
        if (typeof message !== "string" || !hasUiTranslation(message)) continue;
        const forkMessage = translateUi("zh-CN", message);
        if (catalog[key] === forkMessage) continue;
        if (syncForkChinese) {
          catalog[key] = forkMessage;
          changed = true;
        } else {
          problems.push(
            `${app}: ${key} must keep the fork translation of ${JSON.stringify(message)}`,
          );
        }
      }
      if (changed) {
        NodeFS.writeFileSync(catalogPath, `${JSON.stringify(catalog, null, 2)}\n`);
      }
    }
    for (const key of missingFrom(source, catalog)) {
      problems.push(`${app}: ${locale}.json is missing ${key} ${JSON.stringify(source[key])}`);
    }
    for (const key of missingFrom(catalog, source)) {
      problems.push(`${app}: ${locale}.json has ${key}, which en.json lacks`);
    }
  }
}

// The shared dictionary backs `useUiTranslation()` / `translateUi()`. A key that is not in it
// renders English at runtime and never shows up in the GT catalogs, so scan its call sites here.
const sourceFiles = (dir: string): string[] => {
  const absolute = NodePath.join(root, dir);
  return NodeFS.readdirSync(absolute, { recursive: true, encoding: "utf8" })
    .filter((file) => /\.(ts|tsx)$/.test(file))
    .filter((file) => !/\.(test|spec)\.(ts|tsx)$/.test(file) && !/\.browser\.test\./.test(file))
    .filter((file) => !file.includes(`${NodePath.sep}node_modules${NodePath.sep}`))
    .map((file) => NodePath.join(absolute, file));
};
const lineAt = (text: string, index: number) => text.slice(0, index).split("\n").length;
const literalKey = (source: string): string | null => {
  try {
    return JSON.parse(source);
  } catch {
    return null;
  }
};
const dictionaryProblems = new Map<string, string>();
for (const dir of TRANSLATED_SOURCES) {
  for (const file of sourceFiles(dir)) {
    const text = NodeFS.readFileSync(file, "utf8");
    const scans: RegExp[] = [];
    if (text.includes("const t = useUiTranslation()")) scans.push(/\bt\(\s*("(?:[^"\\]|\\.)*")/g);
    if (text.includes("translateUi(")) scans.push(/\btranslateUi\([^,\n]+,\s*("(?:[^"\\]|\\.)*")/g);
    for (const pattern of scans) {
      for (const match of text.matchAll(pattern)) {
        const key = literalKey(match[1]!);
        if (key === null || hasUiTranslation(key)) continue;
        const line = lineAt(text, match.index ?? 0);
        const relative = NodePath.relative(root, file);
        dictionaryProblems.set(
          `${relative}:${line}:${key}`,
          `${relative}:${line}: ${JSON.stringify(key)} has no Simplified Chinese entry in packages/shared/src/uiLocale.ts`,
        );
      }
    }
  }
}
problems.push(...dictionaryProblems.values());

if (problems.length > 0) {
  console.error(problems.join("\n"));
  console.error(
    "\nRun `vp run i18n:generate` in the app, translate any new keys, and run `vp run i18n:check --sync-fork-zh` to keep existing Simplified Chinese translations.",
  );
  process.exitCode = 1;
} else {
  console.log(`i18n catalogs and the shared dictionary match the source in ${APPS.join(", ")}.`);
}
