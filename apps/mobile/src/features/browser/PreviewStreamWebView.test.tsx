import { EnvironmentId } from "@t3tools/contracts";
import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vite-plus/test";

vi.mock("../../lib/useUiTranslation", () => ({ useUiTranslation: () => (text: string) => text }));
vi.mock("../../components/ui/Button", () => ({
  Button: ({ label, onPress }: { label: string; onPress: () => void }) => (
    <button onClick={onPress}>{label}</button>
  ),
}));
vi.mock("../../components/ui/AppActivityIndicator", () => ({ AppActivityIndicator: () => null }));
vi.mock("../../components/ui/AppText", () => ({
  AppText: ({ children }: { children: ReactNode }) => <span>{children}</span>,
}));
vi.mock("../../components/ui/Dialog", () => ({}));
vi.mock("@t3tools/mobile-preview-stream", () => ({ default: "" }));
vi.mock("react-native", () => ({
  Platform: { OS: "android" },
  View: ({ children }: { children: ReactNode }) => children,
  TextInput: () => null,
  Pressable: () => null,
}));
vi.mock("react-native-webview", () => ({
  WebView: ({ onMessage }: { onMessage: (event: { nativeEvent: { data: string } }) => void }) => (
    <div>
      {["connecting", "streaming"].map((status) => (
        <button
          key={status}
          data-status={status}
          onClick={() =>
            onMessage({ nativeEvent: { data: JSON.stringify({ type: "status", status }) } })
          }
        >
          {status}
        </button>
      ))}
    </div>
  ),
}));
vi.mock("expo-clipboard", () => ({}));
vi.mock("../../components/PdfPreview", () => ({ PdfPreview: () => null }));
vi.mock("../../lib/attachmentDownload", () => ({ downloadAndShareAttachment: vi.fn() }));
vi.mock("../../lib/foreground-handoff", () => ({ beginForegroundHandoff: vi.fn() }));
vi.mock("../../state/preview", () => {
  const access = {
    httpBase: "http://preview.test/api/preview-stream",
    wsBase: "ws://preview.test/api/preview-stream",
    credentials: true,
    query: {},
  };
  return { usePreviewStreamAccess: () => ({ access, refresh() {}, retryAfter() {}, error: null }) };
});

import { PreviewStreamWebView } from "./PreviewStreamWebView";

it.each([false, true])(
  "keeps the startup deadline until a frame is painted (streaming: %s)",
  async (streaming) => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    vi.useFakeTimers();
    const container = document.createElement("div");
    const root = createRoot(container);
    try {
      await act(async () =>
        root.render(
          <PreviewStreamWebView
            environmentId={EnvironmentId.make("preview-test")}
            threadId="thread"
            tabId="tab"
            interactive
            background="black"
          />,
        ),
      );
      act(() => container.querySelector<HTMLButtonElement>("[data-status=connecting]")!.click());
      await act(async () => vi.advanceTimersByTimeAsync(10_000));
      if (streaming)
        act(() => container.querySelector<HTMLButtonElement>("[data-status=streaming]")!.click());
      await act(async () => vi.advanceTimersByTimeAsync(5_000));
      expect(container.textContent?.includes("Browser viewer could not start.")).toBe(!streaming);
      expect(
        [...container.querySelectorAll("button")].some(
          (button) => button.textContent === "Reconnect",
        ),
      ).toBe(!streaming);
    } finally {
      await act(async () => root.unmount());
      vi.useRealTimers();
      vi.unstubAllGlobals();
    }
  },
);
