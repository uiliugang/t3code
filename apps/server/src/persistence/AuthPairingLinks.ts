import * as DateTime from "effect/DateTime";
import * as Context from "effect/Context";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as SqlSchema from "effect/sql/SqlSchema";

import { AuthClientMetadata, AuthEnvironmentScopes } from "@t3tools/contracts";

import {
  type AuthPairingLinkRepositoryError,
  PersistenceDecodeError,
  type PersistenceErrorCorrelation,
  PersistenceSqlError,
} from "./Errors.ts";

/**
 * These subjects are reserved for one kind and level of MCP authorization.
 * Keep peer-link subjects under the same prefix so older servers refuse them too.
 */
export const MCP_APPROVAL_SUBJECT_PREFIX = "mcp-approval:";
export const PEER_LINK_PAIRING_SUBJECT_PREFIX = `${MCP_APPROVAL_SUBJECT_PREFIX}peer-link:`;

export const NOISE_APPROVAL_SUBJECT = `${MCP_APPROVAL_SUBJECT_PREFIX}connect-noise-v1`;
export const CLOUD_CONNECT_SUBJECT = "cloud-connect";

const SqliteFlag = Schema.Literals([0, 1]);

const NoiseExchange = Schema.Struct({
  id: Schema.String,
  approved: SqliteFlag,
  scopes: Schema.fromJsonString(AuthEnvironmentScopes),
});
const decodeNoiseExchange = Schema.decodeUnknownEffect(Schema.Array(NoiseExchange));

export const AuthPairingLinkRecord = Schema.Struct({
  id: Schema.String,
  credential: Schema.String,
  method: Schema.Literals(["desktop-bootstrap", "one-time-token"]),
  scopes: Schema.fromJsonString(AuthEnvironmentScopes),
  subject: Schema.String,
  label: Schema.NullOr(Schema.String),
  proofKeyThumbprint: Schema.NullOr(Schema.String),
  createdAt: Schema.DateTimeUtcFromString,
  expiresAt: Schema.DateTimeUtcFromString,
  consumedAt: Schema.NullOr(Schema.DateTimeUtcFromString),
  revokedAt: Schema.NullOr(Schema.DateTimeUtcFromString),
  /** Spendable only once `proofKeyThumbprint` is a trusted T3 Connect device. */
  requiresConnectApproval: SqliteFlag,
  connectApproved: SqliteFlag,
  requestedClient: Schema.NullOr(Schema.fromJsonString(AuthClientMetadata)),
});
export type AuthPairingLinkRecord = typeof AuthPairingLinkRecord.Type;

export const CreateAuthPairingLinkInput = Schema.Struct({
  id: Schema.String,
  credential: Schema.String,
  method: Schema.Literals(["desktop-bootstrap", "one-time-token"]),
  scopes: AuthEnvironmentScopes,
  subject: Schema.String,
  label: Schema.NullOr(Schema.String),
  proofKeyThumbprint: Schema.NullOr(Schema.String),
  requiresConnectApproval: Schema.optionalKey(Schema.Boolean),
  createdAt: Schema.DateTimeUtcFromString,
  expiresAt: Schema.DateTimeUtcFromString,
});
export type CreateAuthPairingLinkInput = typeof CreateAuthPairingLinkInput.Type;

export const ConsumeAuthPairingLinkInput = Schema.Struct({
  credential: Schema.String,
  proofKeyThumbprint: Schema.NullOr(Schema.String),
  requestedScopes: Schema.optionalKey(AuthEnvironmentScopes),
  requiredScopes: Schema.optionalKey(AuthEnvironmentScopes),
  /** Allow a purpose-bound code only when its subject matches the request. */
  allowedSubject: Schema.optionalKey(Schema.String),
  consumedAt: Schema.DateTimeUtcFromString,
  now: Schema.DateTimeUtcFromString,
});
export type ConsumeAuthPairingLinkInput = typeof ConsumeAuthPairingLinkInput.Type;

export const ListActiveAuthPairingLinksInput = Schema.Struct({
  now: Schema.DateTimeUtcFromString,
});
export type ListActiveAuthPairingLinksInput = typeof ListActiveAuthPairingLinksInput.Type;

export const RevokeAuthPairingLinkInput = Schema.Struct({
  id: Schema.String,
  revokedAt: Schema.DateTimeUtcFromString,
});
export type RevokeAuthPairingLinkInput = typeof RevokeAuthPairingLinkInput.Type;

export const GetAuthPairingLinkByCredentialInput = Schema.Struct({
  credential: Schema.String,
});
export type GetAuthPairingLinkByCredentialInput = typeof GetAuthPairingLinkByCredentialInput.Type;

export const GetActiveAuthPairingLinkByIdInput = Schema.Struct({
  id: Schema.String,
  now: Schema.DateTimeUtcFromString,
});
export type GetActiveAuthPairingLinkByIdInput = typeof GetActiveAuthPairingLinkByIdInput.Type;

export const FindPendingConnectPairingLinkInput = Schema.Struct({
  noiseOnly: Schema.optionalKey(Schema.Boolean),
  proofKeyThumbprint: Schema.String,
  now: Schema.DateTimeUtcFromString,
});
export type FindPendingConnectPairingLinkInput = typeof FindPendingConnectPairingLinkInput.Type;

/**
 * Unspent links bound to `proofKeyThumbprint`, or with `keepProofKeyThumbprint` every other bound
 * one. `includeUnbound` adds the links no key is bound to: pairing and approval codes.
 */
export const RevokeUnspentByProofKeyInput = Schema.Struct({
  proofKeyThumbprint: Schema.NullOr(Schema.String),
  keepProofKeyThumbprint: Schema.NullOr(Schema.String),
  includeUnbound: Schema.Boolean,
  revokedAt: Schema.DateTimeUtcFromString,
});
export type RevokeUnspentByProofKeyInput = typeof RevokeUnspentByProofKeyInput.Type;

export const RecordConnectRequestClientInput = Schema.Struct({
  id: Schema.String,
  client: Schema.fromJsonString(AuthClientMetadata),
});
export type RecordConnectRequestClientInput = typeof RecordConnectRequestClientInput.Type;

const AuthPairingLinkRawDbRow = Schema.Struct({
  id: Schema.String,
  credential: Schema.Unknown,
  method: Schema.Unknown,
  scopes: Schema.Unknown,
  subject: Schema.Unknown,
  label: Schema.Unknown,
  proofKeyThumbprint: Schema.Unknown,
  createdAt: Schema.Unknown,
  expiresAt: Schema.Unknown,
  consumedAt: Schema.Unknown,
  revokedAt: Schema.Unknown,
  requiresConnectApproval: Schema.Unknown,
  connectApproved: Schema.Unknown,
  requestedClient: Schema.Unknown,
});

const decodeAuthPairingLinkDbRow = Schema.decodeUnknownEffect(AuthPairingLinkRecord);

export class AuthPairingLinkRepository extends Context.Service<
  AuthPairingLinkRepository,
  {
    readonly exchangeNoise: (
      credential: string,
      thumbprint: string,
      now: DateTime.Utc,
    ) => Effect.Effect<Option.Option<typeof NoiseExchange.Type>, AuthPairingLinkRepositoryError>;
    readonly approveConnectRequest: (
      id: string,
      subject: typeof CLOUD_CONNECT_SUBJECT | typeof NOISE_APPROVAL_SUBJECT,
      now: DateTime.Utc,
    ) => Effect.Effect<boolean, AuthPairingLinkRepositoryError>;
    readonly create: (
      input: CreateAuthPairingLinkInput,
    ) => Effect.Effect<void, AuthPairingLinkRepositoryError>;
    readonly consumeAvailable: (
      input: ConsumeAuthPairingLinkInput,
    ) => Effect.Effect<Option.Option<AuthPairingLinkRecord>, AuthPairingLinkRepositoryError>;
    readonly listActive: (
      input: ListActiveAuthPairingLinksInput,
    ) => Effect.Effect<ReadonlyArray<AuthPairingLinkRecord>, AuthPairingLinkRepositoryError>;
    readonly revoke: (
      input: RevokeAuthPairingLinkInput,
    ) => Effect.Effect<boolean, AuthPairingLinkRepositoryError>;
    readonly getByCredential: (
      input: GetAuthPairingLinkByCredentialInput,
    ) => Effect.Effect<Option.Option<AuthPairingLinkRecord>, AuthPairingLinkRepositoryError>;
    readonly getActiveById: (
      input: GetActiveAuthPairingLinkByIdInput,
    ) => Effect.Effect<Option.Option<AuthPairingLinkRecord>, AuthPairingLinkRepositoryError>;
    /** The device's open or denied request, so its retries do not stack up or re-prompt. */
    readonly findPendingConnect: (
      input: FindPendingConnectPairingLinkInput,
    ) => Effect.Effect<Option.Option<AuthPairingLinkRecord>, AuthPairingLinkRepositoryError>;
    /** Keeps the first description a device gave, so it cannot be swapped while someone decides. */
    readonly recordConnectRequestClient: (
      input: RecordConnectRequestClientInput,
    ) => Effect.Effect<boolean, AuthPairingLinkRepositoryError>;
    readonly revokeUnspentByProofKey: (
      input: RevokeUnspentByProofKeyInput,
    ) => Effect.Effect<ReadonlyArray<string>, AuthPairingLinkRepositoryError>;
  }
>()("t3/persistence/AuthPairingLinks/AuthPairingLinkRepository") {}

function toPersistenceSqlOrDecodeError(
  sqlOperation: string,
  decodeOperation: string,
  correlation?: PersistenceErrorCorrelation,
) {
  return (cause: unknown): AuthPairingLinkRepositoryError =>
    Schema.isSchemaError(cause)
      ? PersistenceDecodeError.fromSchemaError(decodeOperation, cause, correlation)
      : new PersistenceSqlError({
          operation: sqlOperation,
          ...(correlation === undefined ? {} : { correlation }),
          cause,
        });
}

/** @public */
export const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const exchangeNoise: AuthPairingLinkRepository["Service"]["exchangeNoise"] = (
    credential,
    thumbprint,
    now,
  ) => {
    const time = DateTime.formatIso(now);
    return sql`
      UPDATE auth_pairing_links SET subject = ${NOISE_APPROVAL_SUBJECT}, requires_connect_approval = 1,
        consumed_at = CASE WHEN EXISTS (
          SELECT 1 FROM auth_connect_devices WHERE proof_key_thumbprint = ${thumbprint} AND noise_approved_at IS NOT NULL
        ) THEN ${time} ELSE NULL END
      WHERE credential = ${credential} AND proof_key_thumbprint = ${thumbprint}
        AND subject IN (${CLOUD_CONNECT_SUBJECT}, ${NOISE_APPROVAL_SUBJECT})
        AND consumed_at IS NULL AND revoked_at IS NULL AND expires_at > ${time}
        AND NOT EXISTS (
          SELECT 1 FROM auth_pairing_links AS prior
          WHERE prior.id <> auth_pairing_links.id AND prior.subject = ${NOISE_APPROVAL_SUBJECT}
            AND prior.proof_key_thumbprint = ${thumbprint} AND prior.requires_connect_approval = 1 AND prior.consumed_at IS NULL
            AND prior.expires_at > ${time} AND (prior.revoked_at IS NULL OR prior.connect_denied = 1)
        )
      RETURNING id, consumed_at IS NOT NULL AS approved, scopes
    `.pipe(
      Effect.flatMap(decodeNoiseExchange),
      Effect.map((rows) => Option.fromNullishOr(rows[0])),
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "AuthPairingLinks.exchangeNoise",
          "AuthPairingLinks.exchangeNoise",
        ),
      ),
    );
  };

  const approveConnectRequest: AuthPairingLinkRepository["Service"]["approveConnectRequest"] = (
    id,
    subject,
    now,
  ) => {
    const time = DateTime.formatIso(now);
    return sql`
      INSERT INTO auth_connect_devices (proof_key_thumbprint, client_json, approved_at, noise_approved_at)
      SELECT proof_key_thumbprint, requested_client_json, ${time}, ${subject === NOISE_APPROVAL_SUBJECT ? time : null} FROM auth_pairing_links
      WHERE id = ${id} AND subject = ${subject} AND requires_connect_approval = 1 AND proof_key_thumbprint IS NOT NULL
        AND consumed_at IS NULL AND revoked_at IS NULL AND expires_at > ${time}
      ON CONFLICT(proof_key_thumbprint) DO UPDATE SET
        noise_approved_at = excluded.noise_approved_at,
        client_json = COALESCE(excluded.client_json, auth_connect_devices.client_json)
      WHERE excluded.noise_approved_at IS NOT NULL AND auth_connect_devices.noise_approved_at IS NULL
      RETURNING proof_key_thumbprint
    `.pipe(
      Effect.map((rows) => rows.length === 1),
      Effect.mapError(
        (cause) =>
          new PersistenceSqlError({ operation: "AuthPairingLinks.approveConnectRequest", cause }),
      ),
    );
  };

  const createPairingLinkRow = SqlSchema.void({
    Request: CreateAuthPairingLinkInput,
    execute: (input) =>
      sql`
        INSERT INTO auth_pairing_links (
          id,
          credential,
          method,
          scopes,
          subject,
          label,
          proof_key_thumbprint,
          requires_connect_approval,
          created_at,
          expires_at,
          consumed_at,
          revoked_at
        )
        VALUES (
          ${input.id},
          ${input.credential},
          ${input.method},
          ${JSON.stringify(input.scopes)},
          ${input.subject},
          ${input.label},
          ${input.proofKeyThumbprint},
          ${input.requiresConnectApproval ? 1 : 0},
          ${input.createdAt},
          ${input.expiresAt},
          NULL,
          NULL
        )
      `,
  });

  const columns = sql`
    id AS "id",
    credential AS "credential",
    method AS "method",
    scopes AS "scopes",
    subject AS "subject",
    label AS "label",
    proof_key_thumbprint AS "proofKeyThumbprint",
    created_at AS "createdAt",
    expires_at AS "expiresAt",
    consumed_at AS "consumedAt",
    revoked_at AS "revokedAt",
    requires_connect_approval AS "requiresConnectApproval",
    EXISTS (
      SELECT 1 FROM auth_connect_devices
      WHERE auth_connect_devices.proof_key_thumbprint = auth_pairing_links.proof_key_thumbprint
      AND (auth_pairing_links.subject <> ${NOISE_APPROVAL_SUBJECT} OR noise_approved_at IS NOT NULL)
    ) AS "connectApproved",
    requested_client_json AS "requestedClient"
  `;
  const selectRow = sql`SELECT ${columns} FROM auth_pairing_links`;

  const consumeAvailablePairingLinkRow = SqlSchema.findOneOption({
    Request: ConsumeAuthPairingLinkInput,
    Result: AuthPairingLinkRawDbRow,
    execute: ({
      credential,
      proofKeyThumbprint,
      requestedScopes,
      requiredScopes,
      allowedSubject,
      consumedAt,
      now,
    }) =>
      sql`
        UPDATE auth_pairing_links
        SET consumed_at = ${consumedAt}
        WHERE credential = ${credential}
          AND revoked_at IS NULL
          AND consumed_at IS NULL
          AND expires_at > ${now}
          AND subject <> ${NOISE_APPROVAL_SUBJECT}
          AND (subject <> ${CLOUD_CONNECT_SUBJECT} OR NOT EXISTS (
            SELECT 1 FROM auth_connect_devices
            WHERE proof_key_thumbprint = auth_pairing_links.proof_key_thumbprint AND noise_approved_at IS NOT NULL
            UNION ALL
            SELECT 1 FROM auth_pairing_links AS pending
            WHERE pending.proof_key_thumbprint = auth_pairing_links.proof_key_thumbprint
              AND pending.subject = ${NOISE_APPROVAL_SUBJECT} AND pending.requires_connect_approval = 1
              AND pending.consumed_at IS NULL AND pending.expires_at > ${now}
              AND (pending.revoked_at IS NULL OR pending.connect_denied = 1)
          ))
          AND (
            subject NOT LIKE ${`${MCP_APPROVAL_SUBJECT_PREFIX}%`}
            OR subject = ${allowedSubject ?? null}
          )
          AND (
            proof_key_thumbprint IS NULL
            OR proof_key_thumbprint = ${proofKeyThumbprint}
          )
          AND (
            requires_connect_approval = 0
            OR proof_key_thumbprint IN (SELECT proof_key_thumbprint FROM auth_connect_devices)
          )
          AND (${requestedScopes === undefined ? 1 : 0} OR EXISTS (
            SELECT 1
            FROM json_each(${JSON.stringify(requestedScopes ?? [])}) AS requested
            WHERE requested.value IN (
              SELECT value FROM json_each(auth_pairing_links.scopes)
            )
          ))
          AND NOT EXISTS (
            SELECT 1
            FROM json_each(${JSON.stringify(requiredScopes ?? [])}) AS required
            WHERE required.value NOT IN (
              SELECT value FROM json_each(auth_pairing_links.scopes)
            )
          )
        RETURNING ${columns}
      `,
  });

  const listActivePairingLinkRows = SqlSchema.findAll({
    Request: ListActiveAuthPairingLinksInput,
    Result: AuthPairingLinkRawDbRow,
    execute: ({ now }) =>
      sql`
        ${selectRow}
        WHERE revoked_at IS NULL
          AND consumed_at IS NULL
          AND expires_at > ${now}
        ORDER BY created_at DESC, id DESC
      `,
  });

  const revokePairingLinkRow = SqlSchema.findAll({
    Request: RevokeAuthPairingLinkInput,
    Result: Schema.Struct({ id: Schema.String }),
    execute: ({ id, revokedAt }) =>
      sql`
        UPDATE auth_pairing_links
        SET revoked_at = ${revokedAt},
          -- Revoking a waiting approval request is a denial; see findPendingConnect.
          connect_denied = requires_connect_approval
        WHERE id = ${id}
          AND revoked_at IS NULL
          AND consumed_at IS NULL
          -- An approved request is answered; denying it now would leave the device trusted.
          AND NOT (
            requires_connect_approval = 1
            AND proof_key_thumbprint IN (
              SELECT proof_key_thumbprint FROM auth_connect_devices
              WHERE auth_pairing_links.subject <> ${NOISE_APPROVAL_SUBJECT} OR noise_approved_at IS NOT NULL
            )
          )
        RETURNING id AS "id"
      `,
  });

  const getPairingLinkRowByCredential = SqlSchema.findOneOption({
    Request: GetAuthPairingLinkByCredentialInput,
    Result: AuthPairingLinkRawDbRow,
    execute: ({ credential }) =>
      sql`
        ${selectRow}
        WHERE credential = ${credential}
      `,
  });

  const getActivePairingLinkRowById = SqlSchema.findOneOption({
    Request: GetActiveAuthPairingLinkByIdInput,
    Result: AuthPairingLinkRawDbRow,
    execute: ({ id, now }) =>
      sql`
        ${selectRow}
        WHERE id = ${id}
          AND revoked_at IS NULL
          AND consumed_at IS NULL
          AND expires_at > ${now}
      `,
  });

  const findPendingConnectPairingLinkRow = SqlSchema.findOneOption({
    Request: FindPendingConnectPairingLinkInput,
    Result: AuthPairingLinkRawDbRow,
    execute: ({ proofKeyThumbprint, now, noiseOnly }) =>
      sql`
        ${selectRow}
        WHERE proof_key_thumbprint = ${proofKeyThumbprint}
          AND (${noiseOnly ? 1 : 0} = 0 OR subject = ${NOISE_APPROVAL_SUBJECT})
          AND requires_connect_approval = 1
          -- A denied request stays the device's answer until it expires, so retries get a
          -- dead credential back instead of prompting the approver again.
          AND (revoked_at IS NULL OR connect_denied = 1)
          AND consumed_at IS NULL
          AND expires_at > ${now}
        ORDER BY (subject = ${NOISE_APPROVAL_SUBJECT}) DESC, created_at DESC, id DESC
        LIMIT 1
      `,
  });

  const recordConnectRequestClientRow = SqlSchema.findAll({
    Request: RecordConnectRequestClientInput,
    Result: Schema.Struct({ id: Schema.String }),
    execute: ({ id, client }) =>
      sql`
        UPDATE auth_pairing_links
        SET requested_client_json = ${client}
        WHERE id = ${id}
          AND requires_connect_approval = 1
          AND subject = ${CLOUD_CONNECT_SUBJECT}
          AND requested_client_json IS NULL
        RETURNING id AS "id"
      `,
  });

  const decodeOptionalRow =
    (operation: string) => (rowOption: Option.Option<typeof AuthPairingLinkRawDbRow.Type>) =>
      Option.match(rowOption, {
        onNone: () => Effect.succeedNone,
        onSome: (row) =>
          decodeAuthPairingLinkDbRow(row).pipe(
            Effect.mapError((cause) =>
              PersistenceDecodeError.fromSchemaError(operation, cause, { pairingLinkId: row.id }),
            ),
            Effect.asSome,
          ),
      });

  const getActiveById: AuthPairingLinkRepository["Service"]["getActiveById"] = (input) =>
    getActivePairingLinkRowById(input).pipe(
      NodeSqliteClient.readOnly,
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "AuthPairingLinkRepository.getActiveById:query",
          "AuthPairingLinkRepository.getActiveById:decodeRow",
          { pairingLinkId: input.id },
        ),
      ),
      Effect.flatMap(decodeOptionalRow("AuthPairingLinkRepository.getActiveById:decodeRow")),
    );

  const findPendingConnect: AuthPairingLinkRepository["Service"]["findPendingConnect"] = (input) =>
    findPendingConnectPairingLinkRow(input).pipe(
      NodeSqliteClient.readOnly,
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "AuthPairingLinkRepository.findPendingConnect:query",
          "AuthPairingLinkRepository.findPendingConnect:decodeRow",
        ),
      ),
      Effect.flatMap(decodeOptionalRow("AuthPairingLinkRepository.findPendingConnect:decodeRow")),
    );

  const recordConnectRequestClient: AuthPairingLinkRepository["Service"]["recordConnectRequestClient"] =
    (input) =>
      recordConnectRequestClientRow(input).pipe(
        Effect.mapError(
          toPersistenceSqlOrDecodeError(
            "AuthPairingLinkRepository.recordConnectRequestClient:query",
            "AuthPairingLinkRepository.recordConnectRequestClient:encodeRequest",
            { pairingLinkId: input.id },
          ),
        ),
        Effect.map((rows) => rows.length > 0),
      );

  const revokeUnspentByProofKeyRows = SqlSchema.findAll({
    Request: RevokeUnspentByProofKeyInput,
    Result: Schema.Struct({ id: Schema.String }),
    execute: ({ proofKeyThumbprint, keepProofKeyThumbprint, includeUnbound, revokedAt }) =>
      sql`
        -- Only T3 Connect mints bind a proof key, so bound links are that key's connect credentials.
        UPDATE auth_pairing_links
        SET revoked_at = ${revokedAt}
        WHERE revoked_at IS NULL
          AND consumed_at IS NULL
          AND (
            (
              proof_key_thumbprint IS NOT NULL
              AND (${proofKeyThumbprint} IS NULL OR proof_key_thumbprint = ${proofKeyThumbprint})
              AND proof_key_thumbprint IS NOT ${keepProofKeyThumbprint}
            )
            OR (proof_key_thumbprint IS NULL AND ${includeUnbound ? 1 : 0} = 1)
          )
        RETURNING id AS "id"
      `,
  });

  const revokeUnspentByProofKey: AuthPairingLinkRepository["Service"]["revokeUnspentByProofKey"] = (
    input,
  ) =>
    revokeUnspentByProofKeyRows(input).pipe(
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "AuthPairingLinkRepository.revokeUnspentByProofKey:query",
          "AuthPairingLinkRepository.revokeUnspentByProofKey:decodeRows",
        ),
      ),
      Effect.map((rows) => rows.map((row) => row.id)),
    );

  const create: AuthPairingLinkRepository["Service"]["create"] = (input) =>
    createPairingLinkRow(input).pipe(
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "AuthPairingLinkRepository.create:query",
          "AuthPairingLinkRepository.create:encodeRequest",
          { pairingLinkId: input.id },
        ),
      ),
    );

  const consumeAvailable: AuthPairingLinkRepository["Service"]["consumeAvailable"] = (input) =>
    consumeAvailablePairingLinkRow(input).pipe(
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "AuthPairingLinkRepository.consumeAvailable:query",
          "AuthPairingLinkRepository.consumeAvailable:decodeRow",
        ),
      ),
      Effect.flatMap((rowOption) =>
        Option.match(rowOption, {
          onNone: () => Effect.succeedNone,
          onSome: (row) =>
            decodeAuthPairingLinkDbRow(row).pipe(
              Effect.mapError((cause) =>
                PersistenceDecodeError.fromSchemaError(
                  "AuthPairingLinkRepository.consumeAvailable:decodeRow",
                  cause,
                  { pairingLinkId: row.id },
                ),
              ),
              Effect.asSome,
            ),
        }),
      ),
    );

  const listActive: AuthPairingLinkRepository["Service"]["listActive"] = (input) =>
    listActivePairingLinkRows(input).pipe(
      NodeSqliteClient.readOnly,
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "AuthPairingLinkRepository.listActive:query",
          "AuthPairingLinkRepository.listActive:decodeRows",
        ),
      ),
      Effect.flatMap((rows) =>
        Effect.forEach(rows, (row) =>
          decodeAuthPairingLinkDbRow(row).pipe(
            Effect.mapError((cause) =>
              PersistenceDecodeError.fromSchemaError(
                "AuthPairingLinkRepository.listActive:decodeRows",
                cause,
                { pairingLinkId: row.id },
              ),
            ),
          ),
        ),
      ),
    );

  const revoke: AuthPairingLinkRepository["Service"]["revoke"] = (input) =>
    revokePairingLinkRow(input).pipe(
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "AuthPairingLinkRepository.revoke:query",
          "AuthPairingLinkRepository.revoke:decodeRows",
          { pairingLinkId: input.id },
        ),
      ),
      Effect.map((rows) => rows.length > 0),
    );

  const getByCredential: AuthPairingLinkRepository["Service"]["getByCredential"] = (input) =>
    getPairingLinkRowByCredential(input).pipe(
      NodeSqliteClient.readOnly,
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "AuthPairingLinkRepository.getByCredential:query",
          "AuthPairingLinkRepository.getByCredential:decodeRow",
        ),
      ),
      Effect.flatMap((rowOption) =>
        Option.match(rowOption, {
          onNone: () => Effect.succeedNone,
          onSome: (row) =>
            decodeAuthPairingLinkDbRow(row).pipe(
              Effect.mapError((cause) =>
                PersistenceDecodeError.fromSchemaError(
                  "AuthPairingLinkRepository.getByCredential:decodeRow",
                  cause,
                  { pairingLinkId: row.id },
                ),
              ),
              Effect.asSome,
            ),
        }),
      ),
    );

  return {
    create,
    exchangeNoise,
    approveConnectRequest,
    consumeAvailable,
    listActive,
    revoke,
    getByCredential,
    getActiveById,
    findPendingConnect,
    recordConnectRequestClient,
    revokeUnspentByProofKey,
  } satisfies AuthPairingLinkRepository["Service"];
});

export const layer = Layer.effect(AuthPairingLinkRepository, make);
