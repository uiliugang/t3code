import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SourceControlHost from "@t3tools/source-control-core/server/SourceControlHost";
import {
  isMissingExecutable,
  providerAuth,
  type SourceControlAuthProbeInput,
  type SourceControlCliDiscoverySpec,
} from "@t3tools/source-control-core/server/discovery";
import { definition } from "../shared/definition.ts";

export class MCodeError extends Schema.TaggedError<MCodeError>()("MCodeError", {
  operation: Schema.String,
  reason: Schema.Literals([
    "missing-tool",
    "unauthenticated",
    "rate-limited",
    "not-found",
    "failed",
    "invalid-response",
    "invalid-repository",
    "unsupported",
    "same-branch",
    "issue-required",
    "self-review",
  ]),
  cause: Schema.optional(Schema.Defect()),
}) {
  override get message(): string {
    switch (this.reason) {
      case "missing-tool":
        return "Meituan Code requires code-cli 0.1.27 or newer on the server PATH.";
      case "unauthenticated":
        return "Meituan Code is not authenticated. Run code-cli auth login on the server.";
      case "rate-limited":
        return "Meituan Code rate limit exceeded.";
      case "not-found":
        return "The Meituan Code repository, branch, or pull request was not found.";
      case "invalid-response":
        return "Meituan Code returned an unreadable response. Check the code-cli version.";
      case "invalid-repository":
        return "Select a Meituan Code repository in project/repository format.";
      case "unsupported":
        return "This operation is not supported by the Meituan Code integration.";
      case "same-branch":
        return "The source and target branches must differ.";
      case "issue-required":
        return "This repository requires an ONES work item linked to the source branch before creating a pull request.";
      case "self-review":
        return "Meituan Code does not allow authors to approve or request changes on their own pull requests.";
      case "failed":
        return "The Meituan Code command failed.";
    }
  }
}

export function parseMCodeAuth(input: SourceControlAuthProbeInput) {
  const match = /Logged in to (https?:\/\/[^\s]+) as ([^\s(]+)/u.exec(input.stdout);
  const host = match ? URL.parse(match[1]!)?.hostname : undefined;
  if (input.exitCode !== 0)
    return providerAuth({
      status: "unauthenticated",
      detail: "Run code-cli auth login on the server.",
    });
  if (!match || host !== "git.sankuai.com")
    return providerAuth({
      status: "unknown",
      detail: "Could not verify the Meituan Code account.",
    });
  return providerAuth({
    status: /\boffline\b/iu.test(input.stdout) ? "unknown" : "authenticated",
    account: match[2],
    host,
    ...(/\boffline\b/iu.test(input.stdout)
      ? { detail: "Cached login found; connect to the Meituan network to verify it." }
      : {}),
  });
}

export const discovery = {
  type: "cli",
  kind: definition.kind,
  label: definition.label,
  executable: "code-cli",
  versionArgs: ["--version"],
  authArgs: ["auth", "status"],
  parseAuth: parseMCodeAuth,
  installHint:
    "Install code-cli 0.1.27 or newer: npm install -g @ee/code-cli@latest --registry=http://r.npm.sankuai.com; then run code-cli auth login.",
} satisfies SourceControlCliDiscoverySpec;

export interface CommandInput {
  readonly cwd: string;
  readonly operation: string;
  readonly args: ReadonlyArray<string>;
  readonly maxOutputBytes?: number;
}

export class MCodeCli extends Context.Service<
  MCodeCli,
  {
    readonly run: (
      input: CommandInput,
    ) => Effect.Effect<SourceControlHost.SourceControlProcessOutput, MCodeError>;
    readonly json: <A>(
      input: CommandInput,
      schema: Schema.Codec<A, unknown, never, never>,
    ) => Effect.Effect<A, MCodeError>;
  }
>()("@t3tools/source-control-meituan/server/MCodeCli") {}

const make = Effect.gen(function* () {
  const host = yield* SourceControlHost.SourceControlHost;
  const run = Effect.fn("MCodeCli.run")(function* (input: CommandInput) {
    return yield* host.process
      .run({
        ...input,
        command: "code-cli",
        timeoutMs: 30_000,
        // Match code-cli's production endpoint; the platform serves this API over HTTP.
        env: { MCODE_HOST: "http://git.sankuai.com" },
        maxOutputBytes: input.maxOutputBytes ?? 2_000_000,
        classifyFailure: (stderr) =>
          /auth login|token.*(?:invalid|expired)|no token|not authenticated/iu.test(stderr)
            ? "authentication"
            : /not found|does not exist/iu.test(stderr)
              ? "not-found"
              : null,
        concurrency: { key: "meituan-code-cli", limit: 4 },
      })
      .pipe(
        Effect.mapError(
          (cause) =>
            new MCodeError({
              operation: input.operation,
              reason: isMissingExecutable(cause)
                ? "missing-tool"
                : cause._tag === "VcsProcessExitError" && cause.failureKind === "authentication"
                  ? "unauthenticated"
                  : cause._tag === "VcsProcessExitError" && cause.failureKind === "not-found"
                    ? "not-found"
                    : cause._tag === "VcsProcessExitError" && cause.failureKind === "rate-limited"
                      ? "rate-limited"
                      : "failed",
              cause,
            }),
        ),
      );
  });
  const json = <A>(input: CommandInput, schema: Schema.Codec<A, unknown, never, never>) =>
    run(input).pipe(
      Effect.flatMap((output) =>
        Schema.decodeEffect(Schema.fromJsonString(schema))(output.stdout).pipe(
          Effect.mapError(
            (cause) =>
              new MCodeError({ operation: input.operation, reason: "invalid-response", cause }),
          ),
        ),
      ),
    );
  return MCodeCli.of({ run, json });
});

export const layer = Layer.effect(MCodeCli, make);
