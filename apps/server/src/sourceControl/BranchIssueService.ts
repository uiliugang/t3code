import {
  BranchIssue,
  BranchIssueError,
  parseBranchIssueUrl,
  type BranchIssuesInput,
  type BranchIssuesUpdateInput,
  type BranchIssueDetail,
  type BranchIssuesResult,
  SourceControlProviderError,
} from "@t3tools/contracts";
import { normalizeGitRemoteUrl } from "@t3tools/shared/git";
import * as Context from "effect/Context";
import * as Digest from "effect/crypto/Digest";
import * as Hex from "effect/encoding/Hex";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as Providers from "./SourceControlProviderRegistry.ts";

export class BranchIssueService extends Context.Service<
  BranchIssueService,
  {
    readonly list: (
      input: BranchIssuesInput,
    ) => Effect.Effect<typeof BranchIssuesResult.Type, BranchIssueError>;
    readonly read: (
      input: BranchIssuesInput & { readonly url: string },
    ) => Effect.Effect<BranchIssueDetail, BranchIssueError>;
    readonly update: (input: BranchIssuesUpdateInput) => Effect.Effect<void, BranchIssueError>;
  }
>()("t3/sourceControl/BranchIssueService") {}

const isBranchIssueError = Schema.is(BranchIssueError);
const isProviderError = Schema.is(SourceControlProviderError);
const encodeIdentity = Schema.encodeEffect(Schema.fromJsonString(Schema.Array(Schema.String)));
const StoredIssues = Schema.fromJsonString(Schema.Array(BranchIssue));
const decodeStored = Schema.decodeEffect(StoredIssues);
const encodeStored = Schema.encodeEffect(StoredIssues);

const make = Effect.gen(function* () {
  const digester = yield* Digest.Digest;
  const git = yield* GitVcsDriver.GitVcsDriver;
  const providers = yield* Providers.SourceControlProviderRegistry;
  const lock = yield* Semaphore.make(1);
  const resolve = Effect.fn("BranchIssueService.resolve")(function* (input: BranchIssuesInput) {
    const handle = yield* providers.resolveHandle({ cwd: input.cwd });
    if (!handle.context || !handle.provider.issues)
      return yield* new BranchIssueError({ operation: "resolve", reason: "unsupported" });
    const identity = yield* encodeIdentity([
      normalizeGitRemoteUrl(handle.context.remoteUrl),
      input.branch,
    ]);
    const hash = yield* digester.digest(Digest.sha256, new TextEncoder().encode(identity));
    const key = `t3issues.${Hex.encode(hash)}.links`;
    return { ...handle, context: handle.context, capability: handle.provider.issues, key };
  });
  const stored = Effect.fn("BranchIssueService.stored")(function* (cwd: string, key: string) {
    const value = yield* git.readConfigValue(cwd, key);
    return value === null ? [] : yield* decodeStored(value);
  });
  const isPublished = Effect.fn("BranchIssueService.isPublished")(function* (
    input: BranchIssuesInput,
    remoteName: string,
  ) {
    if (yield* git.remoteBranchExists({ cwd: input.cwd, remoteName, refName: input.branch }))
      return true;
    // Narrow fetch refspecs can omit tracking refs even after a successful push.
    const result = yield* git.execute({
      cwd: input.cwd,
      operation: "BranchIssueService.isPublished",
      args: ["ls-remote", "--heads", "--", remoteName, `refs/heads/${input.branch}`],
    });
    return result.stdout.trim().length > 0;
  });
  const list = Effect.fn("BranchIssueService.list")(
    function* (input: BranchIssuesInput) {
      const handle = yield* resolve(input);
      const published = yield* isPublished(input, handle.context.remoteName);
      if (!published) return { provider: handle.provider.kind, published, issues: [] };
      const local = yield* stored(input.cwd, handle.key);
      const remote = handle.capability.list
        ? yield* handle.capability.list({ ...input, context: handle.context })
        : [];
      return {
        provider: handle.provider.kind,
        published,
        issues: handle.capability.list ? remote : local,
      };
    },
    Effect.mapError((cause) =>
      isBranchIssueError(cause)
        ? cause
        : new BranchIssueError({ operation: "list", reason: "unavailable", cause }),
    ),
  );
  const read = Effect.fn("BranchIssueService.read")(
    function* (input: BranchIssuesInput & { readonly url: string }) {
      const handle = yield* resolve(input);
      const issue = parseBranchIssueUrl(input.url);
      if (!issue || issue.provider !== handle.provider.kind)
        return yield* new BranchIssueError({ operation: "read", reason: "invalid-link" });
      return yield* handle.capability.read({ cwd: input.cwd, issue });
    },
    Effect.mapError((cause) =>
      isBranchIssueError(cause)
        ? cause
        : new BranchIssueError({ operation: "read", reason: "unavailable", cause }),
    ),
  );
  const update = Effect.fn("BranchIssueService.update")(
    function* (input: BranchIssuesUpdateInput) {
      const handle = yield* resolve(input);
      if (input.action === "associate" && !(yield* isPublished(input, handle.context.remoteName)))
        return yield* new BranchIssueError({ operation: "update", reason: "unpublished" });
      const refs = input.urls.map(parseBranchIssueUrl);
      if (refs.some((issue) => !issue || issue.provider !== handle.provider.kind))
        return yield* new BranchIssueError({ operation: "update", reason: "invalid-link" });
      const unique = new Map(refs.flatMap((issue) => (issue ? [[issue.url, issue] as const] : [])));
      yield* lock.withPermit(
        Effect.gen(function* () {
          const current = new Map(
            (yield* stored(input.cwd, handle.key)).map((issue) => [issue.url, issue]),
          );
          const remote = handle.capability.list
            ? yield* handle.capability.list({ ...input, context: handle.context })
            : [];
          const existingIssues = handle.capability.list ? remote : [...current.values()];
          if (
            input.action === "associate" &&
            new Set([...existingIssues.map((issue) => issue.url), ...unique.keys()]).size > 1
          )
            return yield* new BranchIssueError({ operation: "update", reason: "issue-limit" });
          for (const issue of unique.values()) {
            const existing = current.get(issue.url);
            if (input.action === "associate") {
              if (
                (existing && !handle.capability.list) ||
                remote.some((item) => item.url === issue.url)
              )
                continue;
              const detail = yield* handle.capability.read({ cwd: input.cwd, issue });
              if (handle.capability.update)
                yield* handle.capability.update({ ...input, context: handle.context, issue });
              current.set(issue.url, {
                ...issue,
                title: detail.title,
                state: detail.state,
                association: handle.capability.update ? ("remote" as const) : ("local" as const),
              });
            } else {
              if (handle.capability.update)
                yield* handle.capability.update({ ...input, context: handle.context, issue });
              current.delete(issue.url);
            }
            const value = yield* encodeStored([...current.values()]);
            yield* git.writeConfigValue({ cwd: input.cwd, key: handle.key, value });
          }
        }),
      );
    },
    (effect, input) =>
      effect.pipe(
        Effect.mapError((cause) =>
          isBranchIssueError(cause)
            ? cause
            : new BranchIssueError({
                operation: "update",
                reason:
                  input.action === "disassociate" &&
                  isProviderError(cause) &&
                  cause.provider === "meituan"
                    ? "unlink-failed"
                    : "failed",
                cause,
              }),
        ),
      ),
  );
  return BranchIssueService.of({ list, read, update });
});

export const layer = Layer.effect(BranchIssueService, make);
