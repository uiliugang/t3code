import { Alert } from "react-native";
import { translateUi } from "@t3tools/shared/uiLocale";
import { AsyncResult } from "effect/reactivity";
import { appAtomRegistry } from "../../state/atom-registry";
import { mobilePreferencesAtom } from "../../state/preferences";
import type { ConfirmDialogRequest, TextInputDialogRequest } from "./Dialog.types";

export type { ConfirmDialogRequest, TextInputDialogRequest } from "./Dialog.types";

function defaultButtonText(message: "Cancel" | "OK") {
  const preferences = appAtomRegistry.get(mobilePreferencesAtom);
  const language = AsyncResult.isSuccess(preferences)
    ? (preferences.value.uiLanguage ?? "en")
    : "en";
  return translateUi(language, message);
}

export function alert(...[title, message, buttons, options]: Parameters<typeof Alert.alert>): void {
  Alert.alert(
    title,
    message,
    buttons?.length ? buttons : [{ text: defaultButtonText("OK") }],
    options,
  );
}

export function confirm(request: ConfirmDialogRequest): void {
  Alert.alert(request.title, request.message, [
    {
      text: request.cancelText ?? defaultButtonText("Cancel"),
      style: "cancel",
      onPress: request.onCancel,
    },
    {
      text: request.confirmText,
      style: request.destructive ? "destructive" : "default",
      onPress: request.onConfirm,
    },
  ]);
}

export function prompt(request: TextInputDialogRequest): void {
  Alert.prompt(
    request.title,
    request.message,
    [
      {
        text: request.cancelText ?? defaultButtonText("Cancel"),
        style: "cancel",
        onPress: request.onCancel,
      },
      { text: request.confirmText, onPress: (value) => request.onConfirm(value ?? "") },
    ],
    "plain-text",
    request.initialValue,
  );
}

export function Host() {
  return null;
}
