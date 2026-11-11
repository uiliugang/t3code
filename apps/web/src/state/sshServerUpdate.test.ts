import { describe, expect, it } from "@effect/vitest";
import { vi, afterEach } from "vite-plus/test";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { Atom, AsyncResult } from "effect/reactivity";
import { EnvironmentId, type ServerConfig } from "@t3tools/contracts";

const state = vi.hoisted(() => ({
  sessionAtom: null as unknown,
  catalogAtom: null as unknown,
  configAtom: null as unknown,
}));
vi.mock(
  import("../connection/catalog"),
  () =>
    ({
      environmentCatalog: {
        get catalogValueAtom() {
          return state.catalogAtom;
        },
      },
    }) as never,
);
vi.mock(
  import("./session"),
  () =>
    ({
      environmentSession: {
        sessionStateAtom: () => state.sessionAtom,
        initialConfigValueAtom: () => state.configAtom,
      },
    }) as never,
);

import { updateServerOverSsh } from "./sshServerUpdate";

afterEach(() => vi.unstubAllGlobals());

describe("updateServerOverSsh", () => {
  it.effect.each([
    { version: "1.2.4-nightly.20261111.1", allowNightly: false, allowed: false },
    { version: "1.2.4-preview.20261111.1", allowNightly: false, allowed: false },
    { version: "1.2.4", allowNightly: false, allowed: true },
    { version: "1.2.4-nightly.20261111.1", allowNightly: true, allowed: true },
  ])(
    "enforces policy for $version with allowNightly=$allowNightly",
    ({ version, allowNightly, allowed }) =>
      Effect.gen(function* () {
        const environmentId = EnvironmentId.make("ssh-policy");
        const target = { alias: "test", hostname: "test", username: null, port: null };
        state.sessionAtom = Atom.make(
          AsyncResult.success({ authenticated: true, permissions: ["environment:maintain"] }),
        );
        state.catalogAtom = Atom.make({
          entries: new Map([
            [
              environmentId,
              {
                target: { _tag: "SshConnectionTarget", environmentId },
                enabled: true,
                profile: Option.some({ _tag: "SshConnectionProfile", target }),
              },
            ],
          ]),
        });
        const ensure = vi.fn().mockResolvedValue({ httpBaseUrl: "http://127.0.0.1:1234/" });
        vi.stubGlobal("window", {
          desktopBridge: {
            ensureSshEnvironment: ensure,
            fetchSshEnvironmentDescriptor: async () => ({ environmentId }),
          },
        });
        const config = {
          managedPolicy: {
            organization: "Test",
            lockedSettings: [],
            limits: { updates: { mode: "auto", allowNightly } },
          },
        } as unknown as ServerConfig;
        state.configAtom = Atom.make(config);
        const result = yield* Effect.result(
          updateServerOverSsh({ environmentId, input: { targetVersion: version } }, config),
        );
        expect(result._tag).toBe(allowed ? "Success" : "Failure");
        expect(ensure).toHaveBeenCalledTimes(allowed ? 2 : 0);
      }),
  );

  it.effect.each([
    {
      scenario: "external server",
      kind: "external",
      descriptorId: "ssh-policy",
      permissions: ["environment:maintain"],
      calls: 1,
    },
    {
      scenario: "different environment",
      kind: "managed",
      descriptorId: "another-host",
      permissions: ["environment:maintain"],
      calls: 1,
    },
    {
      scenario: "revoked permissions",
      kind: "managed",
      descriptorId: "ssh-policy",
      permissions: [],
      calls: 0,
    },
  ])("does not replace an $scenario", ({ kind, descriptorId, permissions, calls }) =>
    Effect.gen(function* () {
      const environmentId = EnvironmentId.make("ssh-policy");
      const target = { alias: "test", hostname: "test", username: null, port: null };
      state.sessionAtom = Atom.make(AsyncResult.success({ authenticated: true, permissions }));
      state.catalogAtom = Atom.make({
        entries: new Map([
          [
            environmentId,
            {
              target: { _tag: "SshConnectionTarget", environmentId },
              enabled: true,
              profile: Option.some({ _tag: "SshConnectionProfile", target }),
            },
          ],
        ]),
      });
      const ensure = vi
        .fn()
        .mockResolvedValue({ httpBaseUrl: "http://127.0.0.1:1234/", remoteServerKind: kind });
      vi.stubGlobal("window", {
        desktopBridge: {
          ensureSshEnvironment: ensure,
          fetchSshEnvironmentDescriptor: async () => ({ environmentId: descriptorId }),
        },
      });
      const result = yield* Effect.result(
        updateServerOverSsh({ environmentId, input: { targetVersion: "1.2.4" } }, null),
      );
      expect(result._tag).toBe("Failure");
      expect(ensure).toHaveBeenCalledTimes(calls);
    }),
  );
});
