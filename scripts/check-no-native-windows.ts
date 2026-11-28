#!/usr/bin/env node

import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { Command } from "effect/cli";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import ts from "typescript-legacy";

type Rule = "native-file" | "native-runtime" | "native-release" | "windows-runner";
type Violation = { readonly path: string; readonly line: number; readonly rule: Rule };

const isWorkflow = /^\.github\/(?:workflows|actions)\/.*\.ya?ml$/i;
const isProductCode =
  /^(?:apps\/(?:desktop|server|web|mobile|marketing)\/(?:src|scripts)\/|packages\/[^/]+\/src\/).+\.[cm]?[jt]sx?$/;
const isPackaging =
  /^(?:package\.json|apps\/(?:desktop|server)\/(?:package\.json|(?:electron-builder|forge\.config)[^/]*|scripts\/[^/]+\.[cm]?[jt]s)|scripts\/(?:build-(?:cli|desktop)|install|npm-launcher)[^/]*(?:\/.*)?\.(?:[cm]?[jt]s|sh))$/i;
const isTestOrGenerated =
  /(?:^|\/)(?:tests?|fixtures|__tests__|__fixtures__|Vendor|_generated|translations|Migrations)(?:\/|$)|\.(?:test|spec|bench)\.[^.]+$|\.d\.[cm]?ts$|\.gen\.[^.]+$/;
// Scope the path rule to retired native inputs, not generic Windows data fixtures.
const retiredPath =
  /^(?:vp\.(?:cmd|ps1)$|\.github\/workflows\/(?:windows|win32)(?:[-_.]|$)|apps\/desktop\/src\/(?:electron\/WindowsForeground|ipc\/methods\/wsl\.|snapShot\/WindowsCaptureFeedback|wsl\/)|apps\/server\/src\/process\/windowsVerbatimSpawn\.|packages\/shared\/src\/windowsSystem\.|scripts\/(?:install\.ps1|project-vp\.ps1|lib\/windows-(?:jsign|tar)\.|verify-windows-desktop-artifact\.)|(?:apps\/(?:desktop|server)|scripts)\/.*\.(?:nsh|admx|adml)$)/i;

const windowsRunner =
  /\bwindows-(?:latest|[0-9]{4})(?:-arm)?\b|^\s*(?:runs-on|os):[^#]*[\s,["']windows(?=$|[\s,\]"'#])/i;
const windowsArtifact =
  /(?:^\s*["']?(?:win|nsis|nsisWeb|msi|appx|squirrelWindows)["']?\s*:|(?:^|[\s"'=])--(?:win(?:dows|32)?|platform(?:[= ]+)(?:win32|windows|win)|target(?:[= ]+)(?:nsis|msi|appx))(?:[\s"',;]|$)|\b(?:latest-win(?:-arm64)?\.ya?ml|T3Code[^\s"']*\.(?:exe|msi|msix|appx))\b)/i;
const nativeHelper = /^(?:wsl\.exe|taskkill(?:\.exe)?|conpty\.dll|winpty(?:-agent\.exe|\.dll))$/i;

function shouldScan(file: string) {
  return (
    retiredPath.test(file) ||
    (!isTestOrGenerated.test(file) &&
      (isWorkflow.test(file) || isProductCode.test(file) || isPackaging.test(file)))
  );
}

function unwrap(expression: ts.Expression): ts.Expression {
  return ts.isParenthesizedExpression(expression) ? unwrap(expression.expression) : expression;
}

function isWindowsLiteral(expression: ts.Expression): boolean {
  const value = unwrap(expression);
  return ts.isStringLiteralLike(value) && value.text === "win32";
}

function isPlatformSelector(expression: ts.Expression): boolean {
  const value = unwrap(expression);
  if (ts.isIdentifier(value)) return value.text === "platform" || value.text.endsWith("Platform");
  if (ts.isPropertyAccessExpression(value)) return /^(?:platform|Platform)$/.test(value.name.text);
  if (ts.isElementAccessExpression(value)) {
    return (
      ts.isStringLiteralLike(value.argumentExpression) &&
      /^(?:platform|Platform)$/.test(value.argumentExpression.text)
    );
  }
  if (ts.isCallExpression(value)) return isPlatformSelector(value.expression);
  if (ts.isYieldExpression(value) && value.expression) return isPlatformSelector(value.expression);
  return false;
}

export function findNativeWindowsRegressions(file: string, contents: string): Violation[] {
  if (retiredPath.test(file)) return [{ path: file, line: 1, rule: "native-file" }];
  if (isTestOrGenerated.test(file)) return [];
  const findings: Violation[] = [];
  const add = (line: number, rule: Rule) => {
    if (!findings.some((found) => found.line === line && found.rule === rule)) {
      findings.push({ path: file, line, rule });
    }
  };
  if (isWorkflow.test(file) || isPackaging.test(file)) {
    for (const [index, line] of contents.split("\n").entries()) {
      if (/^\s*(?:#|\/\/|\*)/.test(line)) continue;
      if (isWorkflow.test(file) && windowsRunner.test(line)) add(index + 1, "windows-runner");
      if (windowsArtifact.test(line)) add(index + 1, "native-release");
    }
  }
  if (
    !isProductCode.test(file) ||
    !/win32|HostProcess\.isWindows|wsl\.exe|taskkill|conpty|winpty/i.test(contents)
  ) {
    return findings;
  }
  const parsed = ts.createSourceFile(file, contents, ts.ScriptTarget.Latest, true);
  const visit = (node: ts.Node) => {
    const comparison =
      ts.isBinaryExpression(node) &&
      (node.operatorToken.kind === ts.SyntaxKind.EqualsEqualsEqualsToken ||
        node.operatorToken.kind === ts.SyntaxKind.EqualsEqualsToken) &&
      ((isPlatformSelector(node.left) && isWindowsLiteral(node.right)) ||
        (isPlatformSelector(node.right) && isWindowsLiteral(node.left)));
    // This exported host-introspection value is still used by portable test fixtures.
    // Allow just the existing predicate, not the file or downstream runtime use.
    const hostIntrospection =
      file === "packages/shared/src/HostProcess.ts" &&
      node.getText(parsed) === 'platform === "win32"' &&
      ts.isArrowFunction(node.parent) &&
      ts.isCallExpression(node.parent.parent) &&
      ts.isVariableDeclaration(node.parent.parent.parent) &&
      node.parent.parent.parent.name.getText(parsed) === "isWindows";
    if (
      (comparison && !hostIntrospection) ||
      (ts.isCaseClause(node) && isWindowsLiteral(node.expression)) ||
      (ts.isPropertyAccessExpression(node) &&
        node.expression.getText(parsed) === "HostProcess" &&
        node.name.text === "isWindows") ||
      (ts.isStringLiteralLike(node) && nativeHelper.test(node.text))
    ) {
      add(parsed.getLineAndCharacterOfPosition(node.getStart(parsed)).line + 1, "native-runtime");
    }
    ts.forEachChild(node, visit);
  };
  visit(parsed);
  return findings;
}

const check = Effect.gen(function* () {
  const path = yield* Path.Path;
  const fs = yield* FileSystem.FileSystem;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const root = yield* path.fromFileUrl(new URL("..", import.meta.url));
  const tracked = yield* spawner.string(
    ChildProcess.make(
      "git",
      [
        "ls-files",
        "-z",
        "--",
        "package.json",
        "vp.cmd",
        "vp.ps1",
        ".github",
        "apps",
        "packages",
        "scripts",
      ],
      {
        cwd: root,
      },
    ),
  );
  const files = Array.from(new Set(tracked.split("\0").filter(shouldScan)));
  if (files.length === 0) return yield* Effect.fail("No tracked native platform inputs found.");
  const results = yield* Effect.forEach(
    files,
    (file) =>
      retiredPath.test(file)
        ? Effect.succeed(findNativeWindowsRegressions(file, ""))
        : fs
            .readFileString(path.join(root, file))
            .pipe(Effect.map((contents) => findNativeWindowsRegressions(file, contents))),
    { concurrency: 8 },
  );
  const findings = results.flat();
  if (findings.length === 0) {
    yield* Console.log(`Native Windows retirement check passed (${files.length} tracked files).`);
    return;
  }
  yield* Console.error(
    findings
      .map(({ path, line, rule }) => `${path}:${line}: retired native Windows support (${rule})`)
      .join("\n"),
  );
  return yield* Effect.fail("Native Windows support was reintroduced.");
});

if (import.meta.main) {
  Command.run(
    Command.make("check-no-native-windows", {}, () => check),
    { version: "1.0.0" },
  ).pipe(Effect.provide(NodeServices.layer), NodeRuntime.runMain);
}
