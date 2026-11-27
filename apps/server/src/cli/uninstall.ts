import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { Command, Flag, GlobalFlag, Prompt } from "effect/cli";

import * as BootService from "../cloud/bootService.ts";
import {
  findPosixLauncher,
  isVersionExecutable,
  pinnedRuntimeVersionsDir,
  readPosixLauncherTarget,
  resolveLauncherPath,
} from "../cloud/pinnedRuntime.ts";
import { projectLocationFlags, resolveCliAuthConfig } from "./config.ts";
import * as CliService from "./service.ts";

export class CliUninstallError extends Schema.TaggedError<
  CliUninstallError,
  { readonly brand: unique symbol }
>()("CliUninstallError", { reason: Schema.String }) {
  override get message(): string {
    return this.reason;
  }
}

export interface UninstallPlan {
  readonly service: boolean;
  readonly otherHomeService: string | undefined;
  readonly versionsDir: string;
  readonly launchers: ReadonlyArray<string>;
  readonly runtimeDir: string | undefined;
  readonly userdataDir: string;
}

/** Delete only launchers targeting this home's runtime/versions. */
export const findOwnedLauncher = Effect.fn("cli.uninstall.find_launcher")(function* (input: {
  readonly launchedAs: string | undefined;
  readonly versionsDir: string;
}) {
  if (input.launchedAs === undefined) return undefined;
  return yield* findPosixLauncher({ launchedAs: input.launchedAs, versionsDir: input.versionsDir });
});

/** Whether a link or unedited POSIX script points into this home's runtime/versions. */
const ownsLauncher = Effect.fn("cli.uninstall.owns_launcher")(function* (
  launcher: string,
  versionsDir: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const realVersionsDir = yield* fs
    .realPath(versionsDir)
    .pipe(Effect.orElseSucceed(() => versionsDir));
  const scriptTarget = yield* readPosixLauncherTarget(launcher);
  // Link or script text keeps a pruned target; the real path sees through a symlinked home.
  const targets = [
    yield* fs.readLink(launcher).pipe(
      Effect.map((link) => path.resolve(path.dirname(launcher), link)),
      Effect.orElseSucceed(() => undefined),
    ),
    yield* fs.realPath(launcher).pipe(Effect.orElseSucceed(() => undefined)),
    scriptTarget,
    scriptTarget !== undefined
      ? yield* fs.realPath(scriptTarget).pipe(Effect.orElseSucceed(() => undefined))
      : undefined,
  ];
  return targets.some(
    (target) =>
      target !== undefined &&
      (isVersionExecutable(path, versionsDir, target) ||
        isVersionExecutable(path, realVersionsDir, target)),
  );
});

/**
 * Launchers recorded in `runtime/launchers` by the install scripts and `t3 install` that still
 * point into this home's runtime/versions. npx can run a different version than the installed
 * one, so the launcher this process started from does not always name them.
 */
export const findRecordedLaunchers = Effect.fn("cli.uninstall.find_recorded_launchers")(function* (
  versionsDir: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const recorded = yield* fs
    .readFileString(path.join(path.dirname(versionsDir), "launchers"))
    .pipe(Effect.orElseSucceed(() => ""));
  const owned: Array<string> = [];
  for (const launcher of recorded.split(/\r?\n/).filter(Boolean)) {
    if (yield* ownsLauncher(launcher, versionsDir)) owned.push(launcher);
  }
  return owned;
});

const planUninstall = Effect.fn("cli.uninstall.plan")(function* (input: {
  readonly baseDir: string;
}) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const service = yield* BootService.BootService;
  const status = yield* service.status;
  const installedBaseDir =
    status.supported && status.installed ? status.installedBaseDir : undefined;
  const servesThisHome = installedBaseDir !== undefined && status.otherBaseDir === undefined;
  const versionsDir = pinnedRuntimeVersionsDir(path, input.baseDir);
  const runtimeDir = path.dirname(versionsDir);
  const launchedAs = (yield* HostProcess.IsExecutable) ? yield* resolveLauncherPath : undefined;
  const launchedFrom = yield* findOwnedLauncher({ launchedAs, versionsDir });
  const plan: UninstallPlan = {
    service: servesThisHome,
    otherHomeService: servesThisHome ? undefined : installedBaseDir,
    versionsDir,
    launchers: [
      ...new Set([
        ...(launchedFrom === undefined ? [] : [launchedFrom]),
        ...(yield* findRecordedLaunchers(versionsDir)),
      ]),
    ],
    runtimeDir: (yield* fs.exists(runtimeDir).pipe(Effect.orElseSucceed(() => false)))
      ? runtimeDir
      : undefined,
    userdataDir: path.join(input.baseDir, "userdata"),
  };
  return plan;
});

export const uninstallCommand = Command.make("uninstall", {
  ...projectLocationFlags,
  yes: Flag.Boolean("yes").pipe(
    Flag.withAlias("y"),
    Flag.withDescription(
      "Remove everything without asking. Required from a script, where there is no prompt.",
    ),
    Flag.withDefault(false),
  ),
}).pipe(
  Command.withDescription(
    "Remove t3 from this machine: the background service, the launcher, and every downloaded version. Your projects and threads are kept.",
  ),
  Command.withHandler((flags) =>
    Effect.gen(function* () {
      const logLevel = yield* GlobalFlag.LogLevel;
      const config = yield* resolveCliAuthConfig(flags, logLevel);
      return yield* runUninstall({ baseDir: config.baseDir, assumeYes: flags.yes }).pipe(
        Effect.provide(CliService.layer(config)),
      );
    }),
  ),
);

const logOtherHomeService = (plan: UninstallPlan) =>
  plan.otherHomeService === undefined
    ? Effect.void
    : Console.log(
        `The T3 Code service serves ${plan.otherHomeService}, so it was not removed. Pass \`${BootService.formatBootServiceBaseDirOption(plan.otherHomeService)}\` to remove it.`,
      );

const runUninstall = Effect.fn("cli.uninstall.run")(function* (input: {
  readonly baseDir: string;
  readonly assumeYes: boolean;
}) {
  const fs = yield* FileSystem.FileSystem;
  const service = yield* BootService.BootService;
  const plan = yield* planUninstall({ baseDir: input.baseDir });

  if (!plan.service && plan.launchers.length === 0 && plan.runtimeDir === undefined) {
    yield* Console.log(`Nothing to remove: t3 is not installed for ${input.baseDir}.`);
    if (!(yield* HostProcess.IsExecutable)) {
      yield* Console.log(
        "  This t3 runs from a Node script, so it was installed by npm or built from source. Remove it the same way (`npm uninstall -g t3`, or delete the checkout).",
      );
    }
    yield* logOtherHomeService(plan);
    return;
  }

  yield* Console.log("This will remove:");
  if (plan.service) yield* Console.log("  the background service (stopping it first)");
  for (const launcher of plan.launchers) yield* Console.log(`  the launcher at ${launcher}`);
  if (plan.runtimeDir !== undefined) {
    yield* Console.log(`  every downloaded version under ${plan.runtimeDir}`);
    yield* fs
      .remove(plan.runtimeDir, { recursive: true, force: true })
      .pipe(
        Effect.mapError(
          () => new CliUninstallError({ reason: `Could not remove ${plan.runtimeDir}.` }),
        ),
      );
    yield* Console.log(`Removed ${plan.runtimeDir}.`);
  }
  yield* Console.log(
    `Your projects, threads, and settings under ${plan.userdataDir} are kept. Delete that directory yourself if you want them gone too.`,
  );

  if (!input.assumeYes) {
    if (!(process.stdin.isTTY && process.stdout.isTTY)) {
      return yield* new CliUninstallError({
        reason:
          "Not a terminal, so nothing was removed. Rerun with --yes to confirm from a script.",
      });
    }
    const confirmed = yield* Prompt.run(
      Prompt.Confirm({ message: "Remove t3 from this machine?", initial: false }),
    ).pipe(Effect.catchTags({ QuitError: () => Effect.succeed(false) }));
    if (!confirmed) {
      yield* Console.log("Left as is.");
      return;
    }
  }

  // The prompt can wait a long time; keep a service or launcher that changed hands meanwhile.
  if (plan.service && (yield* service.status).otherBaseDir !== undefined) {
    yield* Console.log("Left the background service: it now serves another T3 home.");
  } else if (plan.service) {
    yield* service.uninstall;
    yield* Console.log("Removed the background service.");
  }
  for (const launcher of plan.launchers) {
    if (!(yield* ownsLauncher(launcher, plan.versionsDir))) {
      yield* Console.log(`Left ${launcher}: it no longer runs this t3.`);
      continue;
    }
    yield* fs
      .remove(launcher, { force: true })
      .pipe(
        Effect.mapError(
          () => new CliUninstallError({ reason: `Could not remove the launcher at ${launcher}.` }),
        ),
      );
    yield* Console.log(`Removed ${launcher}.`);
  }
  if (plan.runtimeDir !== undefined) {
  }
  yield* Console.log("");
  yield* Console.log("t3 is uninstalled. Thanks for trying T3 Code.");
  yield* logOtherHomeService(plan);
});
