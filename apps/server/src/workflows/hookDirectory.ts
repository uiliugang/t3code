import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import * as SqlClient from "effect/sql/SqlClient";
import { ServerSecretStore } from "../auth/ServerSecretStore.ts";
import { encryptedWebhookAddress } from "../scheduledTasks/encryptedWebhook.ts";
import type { WebhookOrigin } from "../scheduledTasks/webhookOrigin.ts";
import { hookId, OFF, WorkflowInputError } from "./Workflows.ts";

const HookName = Schema.Struct({ workflow: Schema.String, name: Schema.String });
const Directory = Schema.Struct({ ownerId: Schema.String, hooks: Schema.Array(HookName) });
const file = "workflow-active-hooks-v1";
const encode = Schema.encodeSync(Schema.fromJsonString(Directory));
const encodeIds = Schema.encodeSync(Schema.fromJsonString(Schema.Array(Schema.String)));
const decode = Schema.decodeUnknownEffect(Schema.fromJsonString(Directory));
type HookName = typeof HookName.Type;

export const PublishWorkflowHooks = Context.Reference<
  (names: ReadonlyArray<HookName>) => Effect.Effect<void, never, Scope.Scope>
>("t3/workflows/PublishWorkflowHooks", { defaultValue: () => () => Effect.void });

export const layer = (ownerId: string) =>
  Layer.effect(
    PublishWorkflowHooks,
    Effect.gen(function* () {
      const secrets = yield* ServerSecretStore;
      return (names) =>
        Effect.acquireRelease(
          secrets.set(file, new TextEncoder().encode(encode({ ownerId, hooks: names }))),
          () => secrets.remove(file).pipe(Effect.ignore({ log: true })),
        ).pipe(Effect.orDie);
    }),
  );

export const listHookAddresses = Effect.fn("Workflows.listHookAddresses")(function* (
  hooks: ReadonlyArray<HookName & { readonly hookId: string; readonly token: string }>,
  origin: WebhookOrigin,
) {
  if (
    hooks.length &&
    origin.encrypted &&
    !(origin.relayHookBaseUrl && origin.webhookEncryptionPin)
  ) {
    return yield* new WorkflowInputError({
      problem: "Link this host to an HTTPS T3 Connect relay to issue encrypted webhook addresses.",
    });
  }
  return hooks.map(({ workflow, name, hookId, token }) =>
    origin.relayHookBaseUrl && origin.webhookEncryptionPin
      ? {
          workflow,
          name,
          url: encryptedWebhookAddress(
            origin.relayHookBaseUrl,
            hookId,
            token,
            origin.webhookEncryptionPin,
          ),
        }
      : { workflow, name, path: `/api/hooks/${encodeURIComponent(hookId)}/${token}` },
  );
});

export const readLocalHooks = Effect.fn("Workflows.readLocalHooks")(function* (
  ownerId: string,
  origin: WebhookOrigin,
) {
  const secrets = yield* ServerSecretStore;
  const saved = yield* secrets.get(file);
  if (Option.isNone(saved)) return yield* new WorkflowInputError({ problem: OFF });
  const directory = yield* decode(new TextDecoder().decode(saved.value));
  if (directory.ownerId !== ownerId) return yield* new WorkflowInputError({ problem: OFF });
  if (directory.hooks.length === 0) return [];

  const sql = yield* SqlClient.SqlClient;
  const ids = directory.hooks.map((hook) => hookId(hook.workflow, hook.name));
  const rows = yield* sql<{ hook_id: string; token: string }>`
    SELECT hook_id, token FROM workflow_hooks WHERE hook_id IN (SELECT value FROM json_each(${encodeIds(ids)}))
  `;
  const tokens = new Map(rows.map((row) => [row.hook_id, row.token]));
  const hooks = directory.hooks.flatMap((hook, index) => {
    const id = ids[index]!;
    const token = tokens.get(id);
    return token ? [{ ...hook, hookId: id, token }] : [];
  });
  return yield* listHookAddresses(hooks, { ...origin, encrypted: true });
});
