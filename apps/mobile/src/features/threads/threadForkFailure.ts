import * as Cause from "effect/Cause";
import * as Schema from "effect/Schema";
import { RpcClientError } from "effect/rpc/RpcClientError";
import { translateUi, type UiTranslator } from "@t3tools/shared/uiLocale";

const isRpcClientError = Schema.is(RpcClientError);

export function threadForkFailure(
  cause: Cause.Cause<unknown>,
  t: UiTranslator = translateUi.bind(null, "en"),
) {
  if (Cause.hasInterruptsOnly(cause)) return null;
  const error = Cause.squash(cause);
  if (isRpcClientError(error)) {
    return {
      title: t("Could not confirm fork"),
      message: t("Reconnect and check the thread list before trying again."),
    };
  }
  return {
    title: t("Could not start task"),
    message:
      error instanceof Error && error.message.trim()
        ? t(error.message)
        : t("Something went wrong."),
  };
}
