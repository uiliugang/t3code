// @effect-diagnostics nodeBuiltinImport:off - Exercises the bootstrap without a system Node or network.
import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { expect, it as test } from "vite-plus/test";

const it = test.runIf(HostProcess.Platform.defaultValue() !== "win32");

const repository = NodePath.resolve(import.meta.dirname, "..");

async function fixture(
  options: { node?: string; missingVp?: boolean; failInstall?: boolean } = {},
) {
  const root = await NodeFSP.realpath(
    await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3 project runtime ")),
  );
  const bin = NodePath.join(root, "system bin");
  const project = NodePath.join(root, "project space");
  const home = NodePath.join(root, "home");
  const localBin = NodePath.join(project, "node_modules", ".bin");
  await NodeFSP.mkdir(bin);
  await NodeFSP.mkdir(project);
  await NodeFSP.mkdir(home);
  await NodeFSP.mkdir(localBin, { recursive: true });
  await NodeFSP.writeFile(NodePath.join(localBin, "vp"), "#!/bin/sh\nexit 88\n", { mode: 0o755 });
  await NodeFSP.writeFile(
    NodePath.join(project, "pnpm-workspace.yaml"),
    "catalog:\n  vite-plus: 1.4.0\n",
  );
  await NodeFSP.copyFile(NodePath.join(repository, "vp"), NodePath.join(project, "vp"));
  await NodeFSP.writeFile(
    NodePath.join(project, "package.json"),
    JSON.stringify({ engines: { node: "26.13.1" } }),
  );
  for (const name of ["sed", "tr", "grep", "mktemp", "dirname", "rm", "bash"]) {
    const command = NodeChildProcess.execFileSync("/bin/sh", ["-c", `command -v ${name}`], {
      encoding: "utf8",
    }).trim();
    await NodeFSP.symlink(command, NodePath.join(bin, name));
  }
  if (options.node) {
    await NodeFSP.writeFile(
      NodePath.join(bin, "node"),
      `#!/bin/sh\necho ${options.node}\nexit 99\n`,
      { mode: 0o755 },
    );
  }
  const vp = `#!/bin/sh
printf '%s\\n' "$*" >> "$TEST_LOG"
if [ "$1 $2" = 'env current' ]; then
  exit 0
elif [ "$1 $2" = 'env install' ]; then
  [ "$3" = node@26.13.1 ] || exit 91
  [ "$TEST_FAIL_INSTALL" != 1 ] || exit 42
  printf ready > "$TEST_CACHE"
elif [ "$1 $2" = 'env exec' ]; then
  [ -f "$TEST_CACHE" ] || exit 92
  [ "$3 $4" = '--node 26.13.1' ] || exit 93
  shift 4
  exec "$@"
elif [ "$1 $2" = 'exec node' ]; then
  shift 2
  exec "$TEST_NODE" "$@"
else
  exit 94
fi
`;
  const vpSource = NodePath.join(root, "vp-source");
  await NodeFSP.writeFile(vpSource, vp, { mode: 0o755 });
  if (!options.missingVp) await NodeFSP.copyFile(vpSource, NodePath.join(bin, "vp"));
  await NodeFSP.chmod(NodePath.join(project, "vp"), 0o755);
  await NodeFSP.writeFile(
    NodePath.join(bin, "curl"),
    `#!/bin/sh
while [ "$#" -gt 0 ]; do
  if [ "$1" = -o ]; then shift; /bin/cp "$TEST_INSTALLER" "$1"; fi
  shift
done
`,
    { mode: 0o755 },
  );
  const installer = NodePath.join(root, "installer");
  await NodeFSP.writeFile(
    installer,
    `#!/bin/sh
[ "$VP_SELF_SETUP_NO_MODIFY_PATH" = 1 ] || exit 95
[ "$VP_NODE_MANAGER" = no ] || exit 96
[ "$VP_SETUP_NODE_VERSION" = 26.13.1 ] || exit 97
/bin/mkdir -p "$VP_HOME/bin"
/bin/cp "$TEST_VP_SOURCE" "$VP_HOME/bin/vp"
printf installed > "$TEST_BOOTSTRAPPED"
`,
  );
  const env = {
    PATH: `${project}:${localBin}:${bin}`,
    HOME: home,
    TEST_LOG: NodePath.join(root, "calls"),
    TEST_CACHE: NodePath.join(root, "node-cache"),
    TEST_NODE: process.execPath,
    TEST_FAIL_INSTALL: options.failInstall ? "1" : "0",
    TEST_INSTALLER: installer,
    TEST_VP_SOURCE: vpSource,
    TEST_BOOTSTRAPPED: NodePath.join(root, "bootstrapped"),
  };
  return {
    root,
    project,
    env,
    run: (...args: string[]) =>
      NodeChildProcess.spawnSync("/bin/sh", [NodePath.join(project, "vp"), ...args], {
        cwd: root,
        env,
        encoding: "utf8",
      }),
    [Symbol.asyncDispose]: () => NodeFSP.rm(root, { recursive: true, force: true }),
  };
}

it.each([undefined, "14.21.3", "27.0.0"])(
  "prepares the exact project runtime with system Node %s and preserves arguments, cwd and exit code",
  async (node) => {
    await using setup = await fixture(node ? { node } : {});
    const result = setup.run(
      "exec",
      "node",
      "-e",
      "console.log(JSON.stringify({cwd:process.cwd(),args:process.argv.slice(1)}));process.exitCode=23",
      "space ' quote $value",
    );
    expect(result.status, result.stderr).toBe(23);
    expect(JSON.parse(result.stdout)).toEqual({ cwd: setup.root, args: ["space ' quote $value"] });
    expect(await NodeFSP.readFile(setup.env.TEST_LOG, "utf8")).toContain(
      "env install node@26.13.1",
    );
  },
);

it("bootstraps Vite+ without Node and reuses it without changing shell configuration", async () => {
  await using setup = await fixture({ missingVp: true });
  for (const _ of [0, 1]) {
    const result = setup.run(
      "exec",
      "node",
      "-e",
      "const r=require('node:child_process').spawnSync('vp',['exec','node','--version'],{encoding:'utf8'});if(r.error)throw r.error;process.stdout.write(r.stdout);process.exitCode=r.status",
    );
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout.trim()).toBe(process.version);
  }
  expect(await NodeFSP.readFile(setup.env.TEST_BOOTSTRAPPED, "utf8")).toBe("installed");
  expect(await NodeFSP.readdir(setup.env.HOME)).toEqual([".local"]);
});

it("stops before starting a task when the runtime cannot be installed", async () => {
  await using setup = await fixture({ failInstall: true });
  const result = setup.run("exec", "node", "--version");
  expect(result.status).toBe(42);
  expect(await NodeFSP.readFile(setup.env.TEST_LOG, "utf8")).toBe(
    "env current --json\nenv install node@26.13.1\n",
  );
});

it("rejects a non-exact project version before invoking the installer", async () => {
  await using setup = await fixture();
  await NodeFSP.writeFile(
    NodePath.join(setup.project, "package.json"),
    JSON.stringify({ engines: { node: ">=26.13.1" } }),
  );
  const result = setup.run("exec", "node", "--version");
  expect(result.status).not.toBe(0);
  expect(result.stderr).toContain("engines.node");
  await expect(NodeFSP.stat(setup.env.TEST_LOG)).rejects.toMatchObject({ code: "ENOENT" });
});

const powerShell = HostProcess.Platform.defaultValue() === "win32" ? "powershell.exe" : "pwsh";
const hasPowerShell =
  NodeChildProcess.spawnSync(powerShell, ["-NoProfile", "-Command", "exit 0"]).status === 0;

test.runIf(hasPowerShell)(
  "preserves native arguments and exit status in Windows PowerShell's legacy argument mode",
  () => {
    const script = NodePath.join(repository, "vp.ps1").replaceAll("'", "''");
    const result = NodeChildProcess.spawnSync(
      powerShell,
      [
        "-NoProfile",
        "-Command",
        `$PSNativeCommandArgumentPassing = 'Legacy'; $originalPath = $env:PATH; & '${script}' exec node -e 'console.log(JSON.stringify(process.argv.slice(1)));process.exitCode=23' 'a"b' '' 'space & $value' 'C:\\path with space\\'; $resultCode = $LASTEXITCODE; if ($env:PATH -ne $originalPath) { throw 'Shell PATH changed' }; exit $resultCode`,
      ],
      { encoding: "utf8" },
    );
    expect(result.status, result.stderr).toBe(23);
    expect(JSON.parse(result.stdout)).toEqual([
      'a"b',
      "",
      "space & $value",
      "C:\\path with space\\",
    ]);
  },
);

test.runIf(HostProcess.Platform.defaultValue() === "win32")(
  "runs the T3 project launcher through Command Prompt",
  () => {
    const result = NodeChildProcess.spawnSync(
      "cmd.exe",
      ["/d", "/s", "/c", "./vp exec node --version"],
      { cwd: repository, encoding: "utf8" },
    );
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout.trim()).toBe(process.version);
  },
);
