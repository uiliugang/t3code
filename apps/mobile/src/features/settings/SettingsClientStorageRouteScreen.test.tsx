import { EnvironmentId } from "@t3tools/contracts";
import type { SettingsFile } from "@t3tools/client-runtime/settings-transfer";
import { AsyncResult } from "effect/reactivity";
import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vite-plus/test";

import type { SettingsTarget } from "./settings-environment-filter";

const { Children, Action, mocks } = vi.hoisted(() => ({
  Children: ({ children }: { children?: ReactNode }) => children,
  Action: ({
    label,
    disabled,
    onPress,
  }: {
    label: string;
    disabled?: boolean;
    onPress?: () => void;
  }) => (
    <button disabled={disabled} onClick={onPress}>
      {label}
    </button>
  ),
  mocks: {
    environments: [] as SettingsTarget[],
    pickSettingsFile: vi.fn(),
    confirm: vi.fn(),
  },
}));

vi.mock("react-native", () => ({ View: Children }));
vi.mock("react-native-safe-area-context", () => ({ useSafeAreaInsets: () => ({ bottom: 0 }) }));
vi.mock("@effect/atom-react", () => ({
  useAtomValue: (atom: unknown) =>
    atom === "cache-summary"
      ? AsyncResult.success({ environments: [], payloadBytes: 0, recordCount: 0 })
      : atom === "cache-clear"
        ? AsyncResult.success(undefined)
        : true,
  useAtomSet: () => vi.fn(),
}));
vi.mock("../../components/ui/AppText", () => ({ AppText: Children, AppTextInput: () => null }));
vi.mock("../../components/ui/AppActivityIndicator", () => ({ AppActivityIndicator: () => null }));
vi.mock("../../components/ui/AppSymbol", () => ({ SymbolView: () => null }));
vi.mock("../../components/EnvironmentMachineSymbol", () => ({ ENVIRONMENT_MACHINE_SYMBOLS: {} }));
vi.mock("../../components/ui/ScreenScrollView", () => ({ ScreenScrollView: Children }));
vi.mock("../../components/ui/Button", () => ({ Button: Action }));
vi.mock("../../components/ui/ListActionRow", () => ({ ListActionRow: Action }));
vi.mock("../../components/ui/Dialog", () => ({ alert: vi.fn(), confirm: mocks.confirm }));
vi.mock("../../lib/useUiTranslation", () => ({
  useUiTranslation: () => (message: string) => message,
}));
vi.mock("../../lib/uuid", () => ({ uuidv4: () => "import-id" }));
vi.mock("../../state/atom-registry", () => ({ appAtomRegistry: { get: vi.fn() } }));
vi.mock("../../state/preferences", () => ({
  mobilePreferencesAtom: {},
  updateMobilePreferencesAtom: {},
}));
vi.mock("../../state/client-cache-state", () => ({
  clearClientCacheAtom: "cache-clear",
  clientCacheSummaryAtom: "cache-summary",
}));
vi.mock("../../state/entities", () => ({
  useServerConfigs: () => new Map(),
  useProjects: () => [],
}));
vi.mock("../../state/environments", () => ({
  useEnvironments: () => ({ environments: mocks.environments }),
}));
vi.mock("../../state/project-grouping", () => ({
  useMobileProjectGroupingSettings: () => ({ sidebarProjectGroupingMode: "repository" }),
}));
vi.mock("../../state/use-remote-environment-registry", () => ({
  useSavedRemoteConnections: () => ({ savedConnectionsById: {} }),
}));
vi.mock("../../state/server", () => ({
  serverEnvironment: {
    updateSettings: { permissionAtom: () => null },
    upsertKeybinding: { permissionAtom: () => null },
  },
}));
vi.mock("../../state/sourceControl", () => ({
  sourceControlEnvironment: {
    importProjectConfigurations: { permissionAtom: () => null },
    exportProjectConfigurations: {},
  },
}));
vi.mock("../../state/use-atom-command", () => ({ useAtomCommand: () => vi.fn() }));
vi.mock("./components/SettingsScreen", () => ({ SettingsScreen: Children }));
vi.mock("./components/SettingsSection", () => ({ SettingsSection: Children }));
vi.mock("./components/SettingsSwitchRow", () => ({ SettingsSwitchRow: () => null }));
vi.mock("./components/SettingsEnvironmentFilterHeader", () => ({
  useSettingsEnvironmentMenu: () => ({}),
}));
vi.mock("./ProjectImportHistory", () => ({ ProjectImportHistory: () => null }));
vi.mock("./mobileSettingsTransfer", () => ({
  pickSettingsFile: mocks.pickSettingsFile,
  shareSettingsFile: vi.fn(),
}));

import { SettingsClientStorageRouteScreen } from "./SettingsClientStorageRouteScreen";
import { SettingsEnvironmentFilterProvider } from "./settings-environment-filter";

it("keeps a selected settings file through reconnects and blocks transfers until connected", async () => {
  const actEnvironment = Object.getOwnPropertyDescriptor(globalThis, "IS_REACT_ACT_ENVIRONMENT");
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const environment = {
    environmentId: EnvironmentId.make("remote"),
    label: "Remote",
    connection: { phase: "connected" },
    serverConfig: { environment: { capabilities: { projectConfigurationImport: false } } },
  } as SettingsTarget;
  const offline = {
    ...environment,
    environmentId: EnvironmentId.make("offline"),
    label: "Offline",
    connection: { ...environment.connection, phase: "offline" as const },
  };
  mocks.environments = [environment, offline];
  mocks.confirm.mockReset();
  mocks.pickSettingsFile.mockReset();
  const picked = Promise.withResolvers<SettingsFile>();
  mocks.pickSettingsFile.mockReturnValueOnce(picked.promise);
  const container = document.createElement("div");
  const root = createRoot(container);
  const render = () =>
    root.render(
      <SettingsEnvironmentFilterProvider open>
        <SettingsClientStorageRouteScreen />
      </SettingsEnvironmentFilterProvider>,
    );
  const button = (label: string) =>
    [...container.querySelectorAll("button")].find((entry) => entry.textContent === label);

  try {
    act(render);
    expect(button("Import configuration")?.disabled).toBe(false);
    act(() => button("Import configuration")!.click());
    mocks.environments = [
      { ...environment, connection: { ...environment.connection, phase: "reconnecting" } },
      offline,
    ];
    act(render);
    await act(async () => {
      picked.resolve({
        format: "t3-code-settings",
        version: 1,
        scope: "application",
        clientSettings: { uiLanguage: "zh-CN" },
        server: {},
        providers: {},
        keybindings: [],
      });
      await picked.promise;
    });
    mocks.environments = [environment, offline];
    act(render);
    expect(button("Import settings")?.disabled).toBe(false);

    mocks.environments = [
      { ...environment, connection: { ...environment.connection, phase: "reconnecting" } },
      offline,
    ];
    act(render);
    for (const label of ["Export configuration", "Import configuration", "Import settings"])
      expect(button(label)?.disabled).toBe(true);
    act(() => button("Import settings")!.click());
    expect(mocks.confirm).not.toHaveBeenCalled();

    mocks.environments = [environment, offline];
    act(render);
    act(() => button("Import settings")!.click());
    expect(mocks.confirm).toHaveBeenCalledOnce();
    expect(mocks.pickSettingsFile).toHaveBeenCalledOnce();
  } finally {
    act(() => root.unmount());
    if (actEnvironment)
      Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", actEnvironment);
    else Reflect.deleteProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT");
  }
});
