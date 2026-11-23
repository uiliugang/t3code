import { mepAccountFromConfig } from "@t3tools/source-control-meituan/shared/definition";
import {
  MeituanToolError,
  SourceControlToolError,
  isMeituanServiceEnabled,
  isRequirementCli,
  type MeituanToolId,
  type MeituanTool,
  type SourceControlTool,
  type SourceControlToolId,
} from "@t3tools/contracts";
import { npmGlobalPrefixFromCommandPath } from "@t3tools/provider-core/server/maintenanceResolver";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { resolveNodeExecutable } from "@t3tools/shared/nodeRuntime";
import { compareSemverVersions, parseSemver } from "@t3tools/shared/semver";
import { resolveCommandPath, resolveCommandPaths } from "@t3tools/shared/shell";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import * as VcsProcess from "../vcs/VcsProcess.ts";
import * as Settings from "../serverSettings.ts";
import { makeSkillInstallerNode } from "../skills/skillInstallerNode.ts";
import { findModernNpm, nodeMajor } from "./meituanNpm.ts";

const MCODE_PACKAGE = "@ee/code-cli";
const MCODE_REGISTRY = "--registry=http://r.npm.sankuai.com";
const decodeNpmVersion = Schema.decodeEffect(Schema.fromJsonString(Schema.String));
const DEFINITIONS = {
  git: { label: "Git", executable: "git" },
  github: { label: "GitHub CLI", executable: "gh" },
  meituan: { label: "Meituan Code", executable: "code-cli" },
} as const;
const MEITUAN_DEFINITIONS = {
  ones2: { label: "ONES CLI", executable: "ones2", packageName: "@ee/mep-ones-cli" },
  mcm: { label: "MCM CLI", executable: "mcm", packageName: "@dp/mcm-cli" },
  mtskills: { label: "Meituan Skills CLI", executable: "mtskills", packageName: "@mtfe/mtskills" },
  "dumbo-web": {
    label: "Dumbo Web CLI",
    executable: "dumbo-web",
    packageName: "@sailor/dumbo-cdp",
  },
} as const;

const isMeituanMaintenanceTool = (id: SourceControlToolId) =>
  isRequirementCli(id) || id === "dumbo-web";
const definitionFor = (id: SourceControlToolId) =>
  isMeituanMaintenanceTool(id) ? MEITUAN_DEFINITIONS[id] : DEFINITIONS[id];
export const sourceControlToolLabel = (id: SourceControlToolId) => definitionFor(id).label;
export const meituanToolLabel = (id: MeituanToolId) => MEITUAN_DEFINITIONS[id].label;

export function isSourceControlToolEnabled(
  id: SourceControlToolId,
  settings: Parameters<typeof isMeituanToolEnabled>[1],
) {
  if (isMeituanMaintenanceTool(id)) return isMeituanToolEnabled(id, settings);
  return id !== "meituan" || isMeituanServiceEnabled(settings, "sourceControl");
}

export function isMeituanToolEnabled(
  id: MeituanToolId,
  settings:
    | (Parameters<typeof isMeituanServiceEnabled>[0] & {
        readonly daxiang?: { readonly approvalMonitor?: { readonly enabled?: boolean } };
      })
    | null
    | undefined,
) {
  if (id === "mtskills") return settings?.meituanIntegrationEnabled === true;
  if (id === "dumbo-web")
    return (
      settings?.meituanIntegrationEnabled === true &&
      settings.daxiang?.approvalMonitor?.enabled === true
    );
  return isMeituanServiceEnabled(settings, "requirements");
}

export interface ToolInstallationPlan {
  readonly tool: SourceControlTool;
  readonly executable: string | null;
  readonly args: ReadonlyArray<string>;
  readonly env?: NodeJS.ProcessEnv;
  readonly npm?: {
    readonly packageName: string;
    readonly executable: string;
    readonly args: ReadonlyArray<string>;
  };
}

export class SourceControlToolInstaller extends Context.Service<
  SourceControlToolInstaller,
  {
    readonly inspect: (
      id: SourceControlToolId,
    ) => Effect.Effect<ToolInstallationPlan, SourceControlToolError>;
    readonly verifyRequirementCli: (
      id: "ones2" | "mcm",
    ) => Effect.Effect<MeituanTool, MeituanToolError>;
    readonly inspectMeituan: (
      id: MeituanToolId,
      executable?: string,
    ) => Effect.Effect<MeituanTool, MeituanToolError>;
    readonly install: (
      plan: ToolInstallationPlan,
    ) => Effect.Effect<"installed" | "current", SourceControlToolError>;
  }
>()("t3/sourceControl/SourceControlToolInstaller") {}

const quote = (value: string) =>
  /^[\w./:@=+-]+$/u.test(value) ? value : `'${value.replaceAll("'", "'\\''")}'`;
const commandText = (executable: string, args: ReadonlyArray<string>) =>
  [executable, ...args].map(quote).join(" ");

const make = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const process = yield* VcsProcess.VcsProcess;
  const platform = yield* HostProcess.Platform;
  const uid = yield* HostProcess.UserId;
  const home = yield* HostProcess.HomeDirectory;
  const env = yield* HostProcess.Environment;
  const settings = yield* Settings.ServerSettingsService;
  const skillInstallerNode = yield* makeSkillInstallerNode;
  // Bypass command-result caching: verification must see a binary installed moments ago.
  const find = Effect.fn("SourceControlToolInstaller.find")(function* (
    name: string,
    environment = env,
  ) {
    const matches = yield* resolveCommandPaths(name, { env: environment, until: () => true });
    return matches[0] ?? null;
  });
  const probe = Effect.fn("SourceControlToolInstaller.probe")(function* (
    command: string,
    args: ReadonlyArray<string>,
    extraEnv?: NodeJS.ProcessEnv,
  ) {
    return yield* process
      .run({
        operation: "source-control.tools.inspect",
        command,
        args,
        cwd: home,
        env: { ...env, ...extraEnv, LC_ALL: "C" },
        timeoutMs: 10_000,
        maxOutputBytes: 16_000,
      })
      .pipe(Effect.map((result) => result.stdout.trim()));
  });
  const probeMeituanCli = Effect.fn("SourceControlToolInstaller.probeMeituanCli")(function* (
    executable: string,
    args: ReadonlyArray<string>,
  ) {
    const invocation = yield* skillInstallerNode(executable, args, env);
    return yield* probe(
      invocation?.command ?? executable,
      invocation?.args ?? args,
      invocation?.env,
    );
  }, Effect.scoped);

  const nodeVersion = Effect.fn("SourceControlToolInstaller.nodeVersion")((node: string) =>
    probe(node, ["--version"]).pipe(Effect.orElseSucceed(() => "")),
  );

  const readPlan = Effect.fn("SourceControlToolInstaller.readPlan")(
    function* (id: SourceControlToolId) {
      const definition = definitionFor(id);
      const npmPackage = isMeituanMaintenanceTool(id)
        ? MEITUAN_DEFINITIONS[id].packageName
        : id === "meituan"
          ? MCODE_PACKAGE
          : undefined;
      const npmCommand = npmPackage
        ? `npm install -g ${npmPackage}@latest ${MCODE_REGISTRY}`
        : null;
      const npm = npmPackage ? yield* findModernNpm(env, nodeVersion) : null;
      const node =
        npm?.node ??
        (npmPackage
          ? yield* resolveNodeExecutable("Meituan Code", env).pipe(Effect.orElseSucceed(() => null))
          : null);
      let executablePath = yield* find(definition.executable, { ...env, ...npm?.env });
      let realPath = executablePath ? yield* fs.realPath(executablePath) : null;
      let existingPrefix =
        realPath && npmPackage ? npmGlobalPrefixFromCommandPath(realPath, npmPackage) : null;
      if (npm && existingPrefix && existingPrefix !== path.dirname(path.dirname(npm.node))) {
        const existingNode = yield* find("node", {
          ...env,
          PATH: path.join(existingPrefix, "bin"),
        });
        const major = existingNode ? nodeMajor(yield* nodeVersion(existingNode)) : 0;
        if (major > 0 && major < 20) {
          executablePath = null;
          realPath = null;
          existingPrefix = null;
        }
      }
      const versionOutput = !executablePath
        ? null
        : npm && realPath && /\.[cm]?js$/u.test(realPath)
          ? yield* probe(npm.node, [realPath, "--version"], npm.env).pipe(
              Effect.orElseSucceed(() => null),
            )
          : isMeituanMaintenanceTool(id)
            ? yield* probeMeituanCli(executablePath, ["--version"]).pipe(
                Effect.orElseSucceed(() => null),
              )
            : yield* probe(
                node && realPath?.endsWith(".js") ? node : executablePath,
                node && realPath?.endsWith(".js") ? [realPath, "--version"] : ["--version"],
                node ? { ELECTRON_RUN_AS_NODE: "1" } : undefined,
              );
      const version = versionOutput?.match(/\b\d+\.\d+\.\d+(?:-[\w.-]+)?/u)?.[0] ?? null;
      const tool: SourceControlTool = {
        id,
        label: definition.label,
        status: executablePath ? "installed" : "missing",
        version,
        executablePath,
        command: null,
        manualCommand: null,
        reason: null,
        phase: "idle",
        message: null,
      };
      const manual = (
        reason: string,
        manualCommand: string | null = isMeituanMaintenanceTool(id) ? npmCommand : null,
      ): ToolInstallationPlan => ({
        tool: { ...tool, reason, manualCommand },
        executable: null,
        args: [],
      });
      const automatic = (
        executable: string,
        args: ReadonlyArray<string>,
        extra?: Pick<ToolInstallationPlan, "env" | "npm">,
      ): ToolInstallationPlan => ({
        tool: {
          ...tool,
          command: extra?.npm
            ? `PATH=${quote(path.dirname(executable))}:"$PATH" ${commandText(executable, args)}`
            : commandText(executable, args),
          manualCommand: null,
        },
        executable,
        args,
        ...extra,
      });
      if (executablePath && version === null)
        return manual("Could not read the installed version. Check the executable on the server.");
      if (platform !== "darwin" && platform !== "linux")
        return manual("Automatic installation is not supported on this server platform.");

      if (npmPackage) {
        const manualCommand = npmCommand;
        if (!npm)
          return manual("Install Node.js 20 or newer and npm on the server first.", manualCommand);
        const { node, script: npmScript, env: npmEnv } = npm;
        const prefix = realPath
          ? existingPrefix
          : yield* probe(node, [npmScript, "prefix", "--global"], npmEnv);
        if (!prefix || !path.isAbsolute(prefix) || prefix.includes("\n"))
          return manual(
            "This installation must be updated with the tool that installed it.",
            manualCommand,
          );
        if (!executablePath && !npmEnv.PATH.split(":").includes(path.join(prefix, "bin")))
          return manual(
            "The package manager's bin directory is not on the server PATH.",
            manualCommand,
          );
        return automatic(
          node,
          [
            npmScript,
            "install",
            "--global",
            "--prefix",
            prefix,
            `${npmPackage}@latest`,
            MCODE_REGISTRY,
            "--no-audit",
            "--no-fund",
          ],
          { env: npmEnv, npm: { packageName: npmPackage, executable: node, args: [npmScript] } },
        );
      }

      const packageName = definition.executable;
      const brew = yield* find("brew");
      if (brew) {
        const prefix = yield* probe(brew, ["--prefix"]);
        const cellar = path.join(yield* probe(brew, ["--cellar"]), packageName);
        const realCellar = yield* fs.realPath(cellar).pipe(Effect.orElseSucceed(() => cellar));
        if (realPath?.startsWith(`${realCellar}${path.sep}`))
          return automatic(brew, ["upgrade", packageName]);
        if (!executablePath && (env.PATH ?? "").split(":").includes(path.join(prefix, "bin")))
          return automatic(brew, ["install", packageName]);
        if (platform === "darwin")
          return manual(
            "This executable is not managed by Homebrew. Update it on the server and check PATH.",
            executablePath
              ? commandText(executablePath, ["--version"])
              : commandText(brew, ["install", packageName]),
          );
      }
      if (platform !== "linux")
        return manual(
          "Install a supported package manager on the server first.",
          `brew install ${packageName}`,
        );

      const apt = yield* find("apt-get");
      const manager = apt ?? (yield* find("dnf")) ?? (yield* find("yum"));
      if (!manager) return manual("Install a supported package manager on the server first.");
      const args = apt
        ? ["install", "--yes", "--no-remove", ...(version ? ["--only-upgrade"] : []), packageName]
        : [version ? "upgrade" : "install", "--assumeyes", packageName];
      const manualCommand = commandText(
        uid === 0 ? manager : "sudo",
        uid === 0 ? args : [manager, ...args],
      );
      if (realPath) {
        const ownerCommand = yield* find(apt ? "dpkg-query" : "rpm");
        const owner = ownerCommand
          ? yield* probe(
              ownerCommand,
              apt ? ["--search", realPath] : ["-qf", "--queryformat", "%{NAME}", realPath],
            ).pipe(Effect.orElseSucceed(() => ""))
          : "";
        const owned = apt
          ? owner.split("\n").some((line) => {
              const [name, file] = line.split(": ");
              return name?.split(":")[0] === packageName && file === realPath;
            })
          : owner === packageName;
        if (!owned)
          return manual(
            "This installation must be updated with the tool that installed it.",
            commandText(realPath, ["--version"]),
          );
      }
      if (uid === 0)
        return automatic(manager, args, { env: { DEBIAN_FRONTEND: "noninteractive" } });
      const sudo = yield* find("sudo");
      if (!sudo) return manual("Administrator access is required on the server.", manualCommand);
      return automatic(sudo, ["-n", manager, ...args], {
        env: { DEBIAN_FRONTEND: "noninteractive" },
      });
    },
    Effect.provideService(FileSystem.FileSystem, fs),
    Effect.provideService(Path.Path, path),
    Effect.provideService(HostProcess.Platform, platform),
    Effect.provideService(HostProcess.HomeDirectory, home),
  );

  const inspect = Effect.fn("SourceControlToolInstaller.inspect")(
    function* (id: SourceControlToolId) {
      if (
        (id === "meituan" || isMeituanMaintenanceTool(id)) &&
        !isSourceControlToolEnabled(id, yield* settings.getSettings)
      )
        return yield* new SourceControlToolError({ id, reason: "unsupported" });
      return yield* readPlan(id);
    },
    (effect, id) =>
      effect.pipe(
        Effect.mapError((cause) => new SourceControlToolError({ id, reason: "inspection", cause })),
      ),
  );

  const readRequirementTool = Effect.fn("SourceControlToolInstaller.readRequirementTool")(
    function* (id: "ones2" | "mcm") {
      const { tool } = yield* readPlan(id);
      if (id !== "ones2" || !tool.executablePath) return { ...tool, id };
      const account = yield* probeMeituanCli(tool.executablePath, ["config"]).pipe(
        Effect.map(mepAccountFromConfig),
        Effect.orElseSucceed(() => undefined),
      );
      return { ...tool, id, ...(account === undefined ? {} : { account }) };
    },
    (effect, id) =>
      effect.pipe(
        Effect.provideService(FileSystem.FileSystem, fs),
        Effect.provideService(Path.Path, path),
        Effect.provideService(HostProcess.Platform, platform),
        Effect.mapError((cause) => new MeituanToolError({ id, reason: "inspection", cause })),
      ),
  );

  const inspectMeituan = Effect.fn("SourceControlToolInstaller.inspectMeituan")(
    function* (id: MeituanToolId, executable?: string) {
      if (!isMeituanToolEnabled(id, yield* settings.getSettings))
        return yield* new MeituanToolError({ id, reason: "unsupported" });
      const definition = MEITUAN_DEFINITIONS[id];
      const binary = executable || definition.executable;
      if (isRequirementCli(id) && binary === definition.executable)
        return yield* readRequirementTool(id);
      if (id === "dumbo-web" && binary === definition.executable)
        return { ...(yield* readPlan(id)).tool, id };
      const executablePath = yield* binary.includes("/") || binary.includes("\\")
        ? resolveCommandPath(binary, { env })
        : find(binary);
      const versionOutput = executablePath
        ? yield* probeMeituanCli(executablePath, ["--version"]).pipe(
            Effect.orElseSucceed(() => null),
          )
        : null;
      const version = versionOutput?.match(/\b\d+\.\d+\.\d+(?:-[\w.-]+)?/u)?.[0] ?? null;
      return {
        id,
        label: definition.label,
        status: executablePath ? ("installed" as const) : ("missing" as const),
        version,
        executablePath,
        command: null,
        manualCommand:
          binary === definition.executable
            ? `npm install -g ${definition.packageName}@latest ${MCODE_REGISTRY}`
            : null,
        reason:
          executablePath && version === null
            ? "Could not read the installed version. Check the executable on the server."
            : null,
        phase: "idle" as const,
        message: null,
      };
    },
    (effect, id) =>
      effect.pipe(
        Effect.mapError((cause) => new MeituanToolError({ id, reason: "inspection", cause })),
        Effect.provideService(HostProcess.Platform, platform),
        Effect.provideService(FileSystem.FileSystem, fs),
        Effect.provideService(Path.Path, path),
      ),
  );

  const install = Effect.fn("SourceControlToolInstaller.install")(function* (
    plan: ToolInstallationPlan,
  ) {
    const id = plan.tool.id;
    if (
      !isSourceControlToolEnabled(
        id,
        yield* settings.getSettings.pipe(Effect.orElseSucceed(() => null)),
      )
    )
      return yield* new SourceControlToolError({ id, reason: "unsupported" });
    if (!plan.executable) return yield* new SourceControlToolError({ id, reason: "unsupported" });
    let args = plan.args;
    if (plan.npm) {
      const packageName = plan.npm.packageName;
      const output = yield* probe(
        plan.npm.executable,
        [
          ...plan.npm.args,
          "view",
          `${packageName}@latest`,
          "version",
          "--json",
          MCODE_REGISTRY,
          "--fetch-retries=0",
          "--fetch-timeout=10000",
        ],
        plan.env,
      ).pipe(
        Effect.mapError(
          (cause) => new SourceControlToolError({ id, reason: "installation", cause }),
        ),
      );
      const latest = yield* decodeNpmVersion(output).pipe(
        Effect.mapError(
          (cause) => new SourceControlToolError({ id, reason: "installation", cause }),
        ),
      );
      if (!parseSemver(latest))
        return yield* new SourceControlToolError({ id, reason: "installation" });
      if (plan.tool.version && compareSemverVersions(plan.tool.version, latest) >= 0)
        return "current" as const;
      args = args.map((arg) =>
        arg === `${packageName}@latest` ? `${packageName}@${latest}` : arg,
      );
    }
    const result = yield* process
      .run({
        operation: "source-control.tools.install",
        command: plan.executable,
        args,
        cwd: home,
        env: { ...env, ...plan.env, LC_ALL: "C", CI: "1", GIT_TERMINAL_PROMPT: "0" },
        allowNonZeroExit: true,
        timeoutMs: 600_000,
        maxOutputBytes: 16_000,
      })
      .pipe(
        Effect.mapError(
          (cause) => new SourceControlToolError({ id, reason: "installation", cause }),
        ),
      );
    if (result.exitCode !== 0)
      return yield* new SourceControlToolError({
        id,
        reason: "installation",
        exitCode: result.exitCode,
      });
    return "installed" as const;
  });
  return SourceControlToolInstaller.of({
    inspect,
    inspectMeituan,
    verifyRequirementCli: readRequirementTool,
    install,
  });
});

export const layer = Layer.effect(SourceControlToolInstaller, make);
