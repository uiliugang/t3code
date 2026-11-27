import { useSyncExternalStore } from "react";

import { isElectron } from "~/env";

import { isMacPlatform } from "./utils";

const WCO_CLASS_NAME = "wco";
const ELECTRON_CLASS_NAME = "electron";
// macOS has no overlay API; traffic lights stay inside this topbar at every zoom level.
const MACOS_TITLEBAR_HEIGHT = 52;

interface WindowControlsOverlayLike {
  readonly visible: boolean;
  getTitlebarAreaRect(): DOMRect;
  addEventListener(type: "geometrychange", listener: EventListener): void;
  removeEventListener(type: "geometrychange", listener: EventListener): void;
}

interface NavigatorWithWindowControlsOverlay extends Navigator {
  readonly windowControlsOverlay?: WindowControlsOverlayLike;
}

function getWindowControlsOverlay(): WindowControlsOverlayLike | null {
  if (typeof navigator === "undefined") {
    return null;
  }

  return (navigator as NavigatorWithWindowControlsOverlay).windowControlsOverlay ?? null;
}

/** Height of the native caption strip drawn over the page, or 0 when the window has none. */
export function windowControlsOverlayHeight(): number {
  const overlay = getWindowControlsOverlay();
  return overlay?.visible ? overlay.getTitlebarAreaRect().height : 0;
}

export function onWindowControlsOverlayGeometryChange(listener: () => void): () => void {
  const overlay = getWindowControlsOverlay();
  if (!overlay) {
    return () => {};
  }

  overlay.addEventListener("geometrychange", listener);
  return () => {
    overlay.removeEventListener("geometrychange", listener);
  };
}

export function syncDocumentWindowControlsOverlayClass(): () => void {
  if (typeof document === "undefined") {
    return () => {};
  }

  const overlay = getWindowControlsOverlay();
  const update = () => {
    document.documentElement.classList.toggle(WCO_CLASS_NAME, overlay !== null && overlay.visible);
  };

  update();
  return onWindowControlsOverlayGeometryChange(update);
}

function subscribeTitlebarArea(listener: () => void): () => void {
  const overlay = getWindowControlsOverlay();
  overlay?.addEventListener("geometrychange", listener);
  return () => overlay?.removeEventListener("geometrychange", listener);
}

function getNativeTitlebarHeight(): number {
  if (isElectron && isMacPlatform(navigator.platform)) return MACOS_TITLEBAR_HEIGHT;
  const overlay = getWindowControlsOverlay();
  return overlay?.visible ? overlay.getTitlebarAreaRect().bottom : 0;
}

export function useNativeTitlebarHeight(): number {
  return useSyncExternalStore(subscribeTitlebarArea, getNativeTitlebarHeight, () => 0);
}

export function syncDocumentElectronPlatformClasses(): () => void {
  if (typeof document === "undefined") {
    return () => {};
  }

  document.documentElement.classList.add(ELECTRON_CLASS_NAME);
  return () => {
    document.documentElement.classList.remove(ELECTRON_CLASS_NAME);
  };
}
