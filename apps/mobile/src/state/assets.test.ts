import {
  AssetWorkspaceAssetNotFoundError,
  AuthFilesystemReadScope,
  AuthOrchestrationReadScope,
  EnvironmentAuthorizationError,
  EnvironmentId,
  ThreadId,
  type AuthSessionState,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import { Atom, AsyncResult } from "effect/reactivity";
import { beforeEach, expect, it, vi } from "vite-plus/test";
import { EMPTY_ASSET_URL_ATOM } from "@t3tools/client-runtime/state/assets";
import { appAtomRegistry } from "./atom-registry";

type AssetAtom = Atom.Atom<AsyncResult.AsyncResult<unknown, unknown>>;

const state = vi.hoisted(() => ({
  session: null as Pick<AuthSessionState, "authenticated" | "scopes"> | null,
  phase: "connected" as "connected" | "offline",
  assetAtom: {},
  mint: vi.fn(),
  noise: false,
  mediaOrigin: null as string | null,
  materialize: vi.fn(),
  observe: undefined as
    | undefined
    | ((atom: AssetAtom) => AsyncResult.AsyncResult<unknown, unknown>),
  openTransfer: vi.fn(),
  assetQuery: vi.fn(),
  executeQuery: vi.fn(),
  preparedConnectionAtom: null as unknown,
}));

vi.mock("react", () => ({
  useEffect: (create: () => unknown) => {
    create();
  },
  useRef: <A>(current: A) => ({ current }),
  useCallback: <A>(callback: A) => callback,
}));
vi.mock("@effect/atom-react", () => ({
  useAtomMount: () => undefined,
  useAtomSubscribe: () => undefined,
  useAtomValue: (atom: unknown) =>
    atom === state.assetAtom
      ? AsyncResult.success({ relativeUrl: "/api/assets/image.png", expiresAt: 1 })
      : (state.observe?.(atom as AssetAtom) ?? AsyncResult.initial(false)),
}));
vi.mock("./session", () => ({
  environmentSession: {
    sessionStateAtom: () => Atom.make(AsyncResult.initial()),
    preparedConnectionValueAtom: () => state.preparedConnectionAtom,
  },
  usePreparedConnection: () => ({
    _tag: "Some",
    value: {
      httpBaseUrl: "https://host.test",
      ...(state.noise ? { transport: "noise" } : {}),
      ...(state.mediaOrigin ? { mediaOrigins: { asset: state.mediaOrigin } } : {}),
    },
  }),
}));
vi.mock("./presentation", () => ({
  useEnvironmentPresentation: () => ({
    isReady: true,
    presentation: { connection: { phase: state.phase, error: null } },
  }),
}));
vi.mock("../lib/attachmentDownload", () => ({ downloadNoiseFile: state.materialize }));
vi.mock("./attachments", () => ({
  attachmentEnvironment: { openNoiseTransfer: { run: state.openTransfer } },
}));
vi.mock("./query", () => ({
  useEnvironmentQuery: () => ({ data: state.session, error: null }),
}));
vi.mock("./projectClones", () => ({ environmentProjectCloneListAtom: () => null }));
vi.mock("../connection/runtime", () => ({ connectionAtomRuntime: {} }));
vi.mock("../connection/catalog", () => ({
  environmentCatalog: { sessionGenerationAtom: () => Atom.make(1) },
}));
vi.mock("@t3tools/client-runtime/state/assets", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@t3tools/client-runtime/state/assets")>()),
  createAssetEnvironmentAtoms: () => ({ createUrl: state.assetQuery }),
}));
vi.mock("@t3tools/client-runtime/state/runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@t3tools/client-runtime/state/runtime")>()),
  executeAtomQuery: state.executeQuery,
}));
vi.mock("./use-atom-query-runner", () => ({ useAtomQueryRunner: () => state.mint }));
vi.mock("gt-react-native", async (importOriginal) => {
  const gt = await importOriginal<typeof import("gt-react-native")>();
  return { ...gt, useMessages: () => gt.mFallback };
});

import { refreshAssetUrl, useRefreshAssetUrl, useAssetUrlState } from "./assets";

const environmentId = EnvironmentId.make("asset-environment");
const threadId = ThreadId.make("asset-thread");
const resource = { _tag: "media-file", threadId, path: "/repo/image.png" } as const;

beforeEach(() => {
  state.observe = undefined;
  state.session = null;
  state.noise = false;
  state.mediaOrigin = null;
  state.phase = "connected";
  state.preparedConnectionAtom = Atom.make({
    _tag: "Some",
    value: { httpBaseUrl: "https://host.test" },
  });
  state.executeQuery
    .mockReset()
    .mockResolvedValue(AsyncResult.success({ relativeUrl: "/api/assets/image.png", expiresAt: 1 }));
  state.assetQuery.mockReset().mockReturnValue(state.assetAtom);
  state.mint
    .mockReset()
    .mockResolvedValue(AsyncResult.success({ relativeUrl: "/api/assets/image.png", expiresAt: 1 }));
});

it.each(["workspace-file", "media-file"] as const)(
  "keeps %s loading until its file grant resolves",
  (_tag) => {
    expect(useAssetUrlState(environmentId, { ...resource, _tag })).toEqual({ _tag: "Loading" });
    expect(state.assetQuery).not.toHaveBeenCalled();

    state.session = { authenticated: true, scopes: [AuthFilesystemReadScope] };
    expect(useAssetUrlState(environmentId, { ...resource, _tag })).toEqual({
      _tag: "Success",
      expiresAt: 1,
      url: "https://host.test/api/assets/image.png",
    });
  },
);

it("hides host assets with a denied grant while preserving attachments", () => {
  state.session = { authenticated: true, scopes: [] };
  expect(useAssetUrlState(environmentId, resource)).toEqual({
    _tag: "Failure",
    reason: "missing-file-access",
  });
  expect(state.assetQuery).not.toHaveBeenCalled();
  expect(useAssetUrlState(environmentId, { _tag: "attachment", attachmentId: "upload" })).toEqual({
    _tag: "Success",
    expiresAt: 1,
    url: "https://host.test/api/assets/image.png",
  });
});

it("lets the server authorize an explicit refresh before the client grant loads", async () => {
  await expect(useRefreshAssetUrl(environmentId, resource)()).resolves.toBe(
    "https://host.test/api/assets/image.png",
  );
  expect(state.assetQuery).toHaveBeenCalledWith({ environmentId, input: { resource } });

  const denied = new EnvironmentAuthorizationError({
    message: "This connection cannot read host files.",
    requiredScope: AuthFilesystemReadScope,
  });
  state.executeQuery.mockResolvedValue(AsyncResult.failure(Cause.fail(denied)));
  await expect(useRefreshAssetUrl(environmentId, resource)()).resolves.toBeNull();
});

it("rejects a missing host file and discards a signed URL when the route changes to Noise", async () => {
  const missing = new AssetWorkspaceAssetNotFoundError({
    resource,
    checkedPath: "/repo/missing.png",
  });
  state.executeQuery.mockResolvedValue(AsyncResult.failure(Cause.fail(missing)));
  state.preparedConnectionAtom = Atom.make({
    _tag: "Some",
    value: { httpBaseUrl: "https://host.test" },
  });
  await expect(refreshAssetUrl(environmentId, resource)).rejects.toBe(missing);

  const route = Atom.make({
    _tag: "Some",
    value: { httpBaseUrl: "https://host.test", transport: "websocket" },
  });
  state.preparedConnectionAtom = route;
  const response =
    Promise.withResolvers<AsyncResult.AsyncResult<{ relativeUrl: string; expiresAt: number }>>();
  state.executeQuery.mockReturnValue(response.promise);
  const opening = refreshAssetUrl(environmentId, resource);
  appAtomRegistry.set(route, {
    _tag: "Some",
    value: { httpBaseUrl: "https://host.test", transport: "noise" },
  });
  response.resolve(
    AsyncResult.success({ relativeUrl: "/api/assets/old-signed-link", expiresAt: 1 }),
  );
  await expect(opening).resolves.toBeNull();

  state.preparedConnectionAtom = Atom.make({ _tag: "None" });
  await expect(refreshAssetUrl(environmentId, resource)).resolves.toBeNull();
});

it("shares one decrypted file across noise readers and refuses cached bytes when reauthorization fails", async () => {
  const { executeAtomQuery } = await vi.importActual<
    typeof import("@t3tools/client-runtime/state/runtime")
  >("@t3tools/client-runtime/state/runtime");
  state.noise = true;
  state.preparedConnectionAtom = Atom.make({
    _tag: "Some",
    value: { httpBaseUrl: "t3noise://environment", transport: "noise" },
  });
  state.executeQuery.mockImplementation(executeAtomQuery);
  const readChunk = vi
    .fn()
    .mockReturnValue(Effect.succeed({ data: new Uint8Array(), totalBytes: 4 }));
  state.openTransfer.mockReturnValue(Effect.succeed({ readChunk }));
  state.materialize.mockReturnValue(
    Effect.succeed({ uri: "file:///cache/approved", exists: () => true }),
  );
  const resource = { _tag: "attachment", attachmentId: "stored" } as const;
  const leases: Array<() => void> = [];
  try {
    const open = () =>
      refreshAssetUrl(environmentId, resource, undefined, (release) => leases.push(release));
    await expect(Promise.all([open(), open()])).resolves.toEqual([
      "file:///cache/approved",
      "file:///cache/approved",
    ]);
    expect(state.materialize).toHaveBeenCalledOnce();
    readChunk.mockReturnValue(
      Effect.fail(
        new EnvironmentAuthorizationError({
          message: "revoked",
          requiredScope: AuthOrchestrationReadScope,
        }),
      ),
    );
    await expect(open()).rejects.toThrow("revoked");
    expect(readChunk).toHaveBeenCalledWith({ attachmentId: "stored", offset: 0, length: 0 });
    expect(state.assetQuery).not.toHaveBeenCalled();
  } finally {
    for (const release of leases) release();
  }
});

it("leases a workspace revision across readers and validates permission before reusing its bytes", async () => {
  const realRuntime = await vi.importActual<typeof import("@t3tools/client-runtime/state/runtime")>(
    "@t3tools/client-runtime/state/runtime",
  );
  state.executeQuery.mockImplementation(realRuntime.executeAtomQuery);
  state.preparedConnectionAtom = Atom.make({
    _tag: "Some",
    value: { httpBaseUrl: "t3noise://environment", transport: "noise" },
  });
  let revision = "image-1";
  const chunk = { data: new Uint8Array(), totalBytes: 0 };
  const readWorkspaceChunk = vi.fn(() => Effect.succeed({ ...chunk, revision }));
  state.openTransfer.mockReturnValue(Effect.succeed({ readWorkspaceChunk }));
  state.materialize
    .mockReset()
    .mockImplementation(
      (
        name: string,
        read: (offset: number) => Effect.Effect<typeof chunk>,
        expectedRevision: string,
      ) =>
        Effect.as(read(0), {
          uri: `file:///private/${expectedRevision}/${name.split("/").at(-1)}`,
          exists: () => true,
        }),
    );
  const releases: Array<() => void> = [];
  const get = (file: typeof resource = resource) =>
    refreshAssetUrl(environmentId, file, undefined, (release) => releases.push(release));
  state.noise = true;
  state.session = { authenticated: true, scopes: [AuthFilesystemReadScope] };
  const observed = new Set<AssetAtom>();
  state.observe = (atom) => {
    if (atom !== EMPTY_ASSET_URL_ATOM && !observed.has(atom)) {
      observed.add(atom);
      releases.push(appAtomRegistry.mount(atom));
    }
    return appAtomRegistry.get(atom);
  };
  const preview = async () => {
    useAssetUrlState(environmentId, resource, "editor-hint");
    await Promise.all(
      [...observed].map((atom) => realRuntime.executeAtomQuery(appAtomRegistry, atom)),
    );
    return useAssetUrlState(environmentId, resource, "editor-hint");
  };
  try {
    await expect(preview()).resolves.toMatchObject({
      _tag: "Success",
      fileRevision: "image-1",
      url: "file:///private/image-1/image.png",
    });
    await expect(Promise.all([get(), get()])).resolves.toEqual([
      "file:///private/image-1/image.png",
      "file:///private/image-1/image.png",
    ]);
    expect(state.materialize).toHaveBeenCalledOnce();
    await expect(get()).resolves.toBe("file:///private/image-1/image.png");
    expect(state.materialize).toHaveBeenCalledOnce();
    revision = "image-2";
    await expect(get()).resolves.toBe("file:///private/image-2/image.png");
    await expect(preview()).resolves.toMatchObject({
      fileRevision: "image-2",
      url: "file:///private/image-2/image.png",
    });
    expect(readWorkspaceChunk).toHaveBeenCalledWith({ resource, offset: 0, revision });
    expect(state.materialize).toHaveBeenCalledTimes(2);
    const other = { ...resource, threadId: ThreadId.make("different-worktree") };
    await get(other);
    expect(state.materialize).toHaveBeenCalledTimes(3);
    readWorkspaceChunk.mockImplementation(() => {
      throw new Error("access revoked");
    });
    await expect(get()).rejects.toThrow("access revoked");
    expect(state.assetQuery).not.toHaveBeenCalled();
  } finally {
    for (const release of releases) release();
  }
});

it("renders active documents and private media only through the approved local media listener", () => {
  state.noise = true;
  state.mediaOrigin = "http://127.0.0.1:41234/capability";
  const displayed = {
    _tag: "Success",
    expiresAt: 1,
    url: state.mediaOrigin + "/api/assets/image.png",
  };
  expect(
    useAssetUrlState(environmentId, {
      _tag: "attachment",
      attachmentId: "render",
      mimeType: "text/html",
      renderIntent: "mcp-app",
    }),
  ).toEqual(displayed);
  expect(
    useAssetUrlState(environmentId, {
      _tag: "github-media",
      cwd: "/repo",
      url: "https://github.com/user-attachments/assets/id",
    }),
  ).toEqual(displayed);
});
