import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vite-plus/test";

import { tryOpenExternalUrl } from "../../lib/openExternalUrl";
import { SettingsLegalRouteScreen } from "./SettingsLegalRouteScreen";
import { SECURITY_POLICY_URL, TERMS_OF_SERVICE_URL } from "./lib/legal-document-url";

vi.mock("@react-navigation/native", () => ({ useNavigation: () => ({}) }));
vi.mock("gt-react-native", () => ({ useGT: () => (text: string) => text }));
vi.mock("../../lib/useUiTranslation", () => ({ useUiTranslation: () => (text: string) => text }));
vi.mock("../../lib/openExternalUrl", () => ({ tryOpenExternalUrl: vi.fn() }));
vi.mock("react-native", () => ({
  Platform: { OS: "android" },
  View: ({ children }: { children: ReactNode }) => children,
  Pressable: () => null,
}));
vi.mock("../../components/ui/AppText", () => ({
  AppText: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("../../components/ui/AppSymbol", () => ({ SymbolView: () => null }));
vi.mock("../../components/ui/AppActivityIndicator", () => ({ AppActivityIndicator: () => null }));
vi.mock("../../components/ui/Button", () => ({ Button: () => null }));
vi.mock("../../components/ui/LoadingStrip", () => ({ LoadingStrip: () => null }));
vi.mock("../../components/ui/ListRow", () => ({ ListRow: () => null }));
vi.mock("../../components/ui/ScreenScrollView", () => ({ ScreenScrollView: () => null }));
vi.mock("./components/SettingsSection", () => ({ SettingsSection: () => null }));
vi.mock("../../components/ui/SheetHeader", () => ({
  SheetHeader: ({ actions }: { actions: { onPress: () => void }[] }) => (
    <button onClick={actions[0]?.onPress}>Open externally</button>
  ),
}));
vi.mock("react-native-webview", () => ({
  WebView: ({
    source,
    onError,
  }: {
    source: { uri: string };
    onError: (event: { nativeEvent: { description: string } }) => void;
  }) => (
    <button
      data-uri={source.uri}
      onClick={() => onError({ nativeEvent: { description: "Offline" } })}
    >
      Fail request
    </button>
  ),
}));

it("opens the next deep-linked document after the previous document failed", () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const container = document.createElement("div");
  const root = createRoot(container);
  const navigate = (document: "terms" | "security") =>
    act(() => root.render(<SettingsLegalRouteScreen route={{ params: { document } }} />));
  try {
    navigate("terms");
    act(() =>
      container.querySelector<HTMLButtonElement>(`[data-uri="${TERMS_OF_SERVICE_URL}"]`)!.click(),
    );
    expect(container.textContent).toContain("Offline");

    navigate("security");
    expect(container.querySelector("[data-uri]")?.getAttribute("data-uri")).toBe(
      SECURITY_POLICY_URL,
    );
    act(() => container.querySelector("button")!.click());
    expect(tryOpenExternalUrl).toHaveBeenCalledWith(SECURITY_POLICY_URL);
  } finally {
    act(() => root.unmount());
    vi.unstubAllGlobals();
  }
});
