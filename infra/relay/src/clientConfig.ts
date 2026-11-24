import * as Alchemy from "alchemy";
import * as Config from "effect/Config";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

export interface RelayClientConfig {
  readonly url: string | undefined;
}

export class RelayUrlUnavailableError extends Schema.TaggedError<
  RelayUrlUnavailableError,
  { readonly brand: unique symbol }
>()("RelayUrlUnavailableError", {}) {
  override get message(): string {
    return "The relay worker has no URL yet; deploy again once the worker exists.";
  }
}

export class EnvValueNotSingleLineError extends Schema.TaggedError<
  EnvValueNotSingleLineError,
  { readonly brand: unique symbol }
>()("EnvValueNotSingleLineError", { key: Schema.String }) {
  override get message(): string {
    return `${this.key} contains a line break and cannot be written as one .env assignment.`;
  }
}

/** Remove every duplicate: parseEnv takes the last value, which could otherwise override the update. */
export function reconcileEnvFile(
  contents: string,
  entries: Readonly<Record<string, string>>,
): string {
  const lines = contents === "" ? [] : contents.replace(/\n$/u, "").split("\n");
  const assignment = /^\s*(?:export\s+)?([^#=\s][^=]*?)\s*=\s*(.*)$/u;
  const pending = new Map(Object.entries(entries));
  const out: string[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!;
    const match = assignment.exec(line);
    const name = match?.[1];
    if (match === null || name === undefined) {
      out.push(line);
      continue;
    }
    const start = index;
    // Skip quoted bodies even for unrelated keys: a line in the body can look like an assignment.
    const rawValue = match[2] ?? "";
    const quote = /^(['"`])/u.exec(rawValue)?.[1];
    if (quote !== undefined && !closesQuote(rawValue, quote)) {
      for (let closing = index + 1; closing < lines.length; closing += 1) {
        if (lines[closing]!.includes(quote)) {
          index = closing;
          break;
        }
      }
    }
    if (!Object.hasOwn(entries, name)) {
      for (let at = start; at <= index; at += 1) out.push(lines[at]!);
      continue;
    }
    const value = pending.get(name);
    if (value !== undefined) {
      out.push(`${name}=${value}`);
      pending.delete(name);
    }
  }
  for (const [name, value] of pending) out.push(`${name}=${value}`);
  return out.length === 0 ? "" : `${out.join("\n")}\n`;
}

const closesQuote = (value: string, quote: string): boolean =>
  value.length > 1 && value.slice(1).includes(quote);

export const PublishClientConfig = Alchemy.Action(
  "PublishClientConfig",
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const override = yield* Config.String("T3CODE_RELAY_CLIENT_CONFIG_ENV").pipe(Config.option);
    const repoRootEnv = path.fromFileUrl(new URL("../../../.env", import.meta.url));
    const target = Option.isSome(override) ? override.value : yield* repoRootEnv;
    return Effect.fn(function* (input: RelayClientConfig) {
      const url = input.url;
      if (url === undefined) return yield* new RelayUrlUnavailableError();
      const entries = { T3CODE_RELAY_URL: url };
      // Reject line breaks in provider values to prevent injected assignments.
      for (const [name, value] of Object.entries(entries)) {
        if (/[\r\n]/u.test(value)) return yield* new EnvValueNotSingleLineError({ key: name });
      }
      const existing = (yield* fs.exists(target)) ? yield* fs.readFileString(target) : "";
      yield* fs.writeFileString(target, reconcileEnvFile(existing, entries));
      yield* Console.log(`Wrote relay client configuration to ${target}`);
      return { path: target };
    });
  }),
);
