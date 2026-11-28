import { describe, expect, it } from "@effect/vitest";
import { findNativeWindowsRegressions } from "./check-no-native-windows.ts";

describe("native Windows retirement gate", () => {
  it.each([
    'if (hostPlatform === "win32") { startNativeGit(); }',
    'function* launch() { if ("win32" == (yield* HostProcess.Platform)) startNativeGit(); }',
    'const launcher = process["platform"] === "win32" ? native : portable;',
    'switch (os.platform()) { case "win32": startNativeGit(); }',
    "if (yield* HostProcess.isWindows) { startNativeGit(); }",
    'spawn("wsl.exe", ["--distribution", selected]);',
  ])("rejects the restored native path %s", (source) => {
    const path = "apps/server/src/vcs/VcsProcess.ts";
    expect(findNativeWindowsRegressions(path, "\n" + source)).toEqual([
      { path, line: 2, rule: "native-runtime" },
    ]);
  });

  it("rejects the retired installer files even when their contents are empty", () => {
    for (const path of [
      "apps/desktop/resources/installer.nsh",
      "apps/desktop/src/electron/WindowsForegroundFocusWorker.ts",
      "apps/desktop/src/ipc/methods/wsl.ts",
      "apps/desktop/src/wsl/DesktopWslBackend.ts",
      "scripts/install.ps1",
      "vp.cmd",
      ".github/workflows/windows-tests.yml",
      "scripts/t3.admx",
    ]) {
      expect(findNativeWindowsRegressions(path, "")).toEqual([
        { path, line: 1, rule: "native-file" },
      ]);
    }
  });

  it("rejects hosted Windows runners and release targets", () => {
    const workflow = ".github/workflows/release.yml";
    expect(
      findNativeWindowsRegressions(
        workflow,
        "# examples: windows-latest\nruns-on: [ubuntu-24.04, windows-2025]\nrun: vp exec electron-builder --win\nrun: vp run dist:desktop:artifact --target nsis\n  os: [linux, windows]",
      ),
    ).toEqual([
      { path: workflow, line: 2, rule: "windows-runner" },
      { path: workflow, line: 3, rule: "native-release" },
      { path: workflow, line: 4, rule: "native-release" },
      { path: workflow, line: 5, rule: "windows-runner" },
    ]);
    const manifest = "apps/desktop/package.json";
    expect(findNativeWindowsRegressions(manifest, '{\n  "nsis": { "oneClick": true }\n}')).toEqual([
      { path: manifest, line: 2, rule: "native-release" },
    ]);
  });

  it("preserves previous platform data, foreign path parsing, and removed-file packaging exclusions", () => {
    expect(
      findNativeWindowsRegressions(
        "packages/shared/src/compatibility.ts",
        [
          '// if (process.platform === "win32") used to launch a helper.',
          'type PreviousPlatform = "win32" | "darwin";',
          'const known = remote.os === "win32";',
          "const drive = Path.win32.parse(foreignPath);",
          'const platformNames = ["linux", "darwin", "win32"];',
        ].join("\n"),
      ),
    ).toEqual([]);
    expect(
      findNativeWindowsRegressions(
        "apps/server/src/process/externalLauncher.ts",
        'if (process.platform === "linux" && isStandaloneWsl()) return "powershell.exe";',
      ),
    ).toEqual([]);
    expect(
      findNativeWindowsRegressions(
        "scripts/build-desktop-artifact.ts",
        'const exclude = "!**/node_modules/node-pty/prebuilds/win32-*/**/*";',
      ),
    ).toEqual([]);
    expect(
      findNativeWindowsRegressions(
        "apps/desktop/src/desktop.test.ts",
        'expect(install("win32")).toThrow();',
      ),
    ).toEqual([]);
  });

  it("allows only the existing portable-test host-introspection predicate", () => {
    const path = "packages/shared/src/HostProcess.ts";
    const predicate =
      'export const isWindows = Effect.map(Platform, (platform) => platform === "win32");';
    expect(findNativeWindowsRegressions(path, predicate)).toEqual([]);
    expect(
      findNativeWindowsRegressions(
        path,
        predicate + '\nif (process.platform === "win32") launchNativeServer();',
      ),
    ).toEqual([{ path, line: 2, rule: "native-runtime" }]);
  });
});
