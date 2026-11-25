import { builtInSourceControlDefinitions } from "@t3tools/source-control-definitions/registry";
import {
  HostCredentialSettings,
  readSourceControlHostSettings,
  type SourceControlAppSignIn,
  type SourceControlDefinition,
} from "@t3tools/source-control-core/shared/definition";
import {
  isConfiguredSourceControlToken,
  sourceControlTokenHost,
  type ServerSettings,
  type SettingsSecretValue,
  type SourceControlAppAccessInput,
} from "@t3tools/contracts";
import { parseGitRemoteRepository } from "@t3tools/shared/git";

export {
  isMonochromeSourceControlIcon,
  UNKNOWN_SOURCE_CONTROL_CLIENT,
  type ChangeRequestLink,
  type ChangeRequestTerminology,
  type HostAccountChoice,
  type HostCredentialSettings,
  type ParsedChangeRequestUrl,
  type ReferenceAutolink,
  type SourceControlAppSignIn,
  type SourceControlDefinition,
  type SourceControlHostCredentials,
  type SourceControlIcon,
} from "@t3tools/source-control-core/shared/definition";

export { readMeituanCodeMis } from "@t3tools/source-control-definitions/registry";

export const sourceControlClients = builtInSourceControlDefinitions;

/** The saved per-hostname accounts and tokens of a host whose definition has `credentials`. */
export function readHostCredentialSettings(
  settings: Pick<ServerSettings, "sourceControlHosts">,
  kind: string,
): HostCredentialSettings {
  return readSourceControlHostSettings(HostCredentialSettings, settings.sourceControlHosts[kind]);
}

export function withSourceControlHostToken(
  kind: string,
  tokens: HostCredentialSettings["tokens"],
  host: string,
  token: SettingsSecretValue,
): HostCredentialSettings["tokens"] {
  const target = sourceControlTokenHost(kind, host);
  const next = { ...tokens };
  if (kind === "github") {
    for (const key of Object.keys(tokens)) {
      if (sourceControlTokenHost(kind, key) === target) next[key] = "";
    }
  }
  return { ...next, [target]: token };
}

export function configuredSourceControlTokenHosts(
  kind: string,
  tokens: HostCredentialSettings["tokens"],
): string[] {
  return [
    ...new Set(
      Object.entries(tokens)
        .filter(([, value]) => isConfiguredSourceControlToken(value))
        .map(([host]) => sourceControlTokenHost(kind, host)),
    ),
  ];
}

/** A host's change request term where it opens a sentence: "Merge request merged". */
export function capitalizeTerm(term: string): string {
  return term.charAt(0).toUpperCase() + term.slice(1);
}

/** The repository a remote names, when its host has an app sign-in that could reach it. */
export function appSignInTargetForRemote(remoteUrl: string): {
  readonly definition: SourceControlDefinition;
  readonly appSignIn: SourceControlAppSignIn;
  readonly input: SourceControlAppAccessInput;
} | null {
  const parsed = parseGitRemoteRepository(remoteUrl);
  const provider = sourceControlClients.recognizeRemote(remoteUrl);
  const definition = provider ? sourceControlClients.find(provider.kind) : undefined;
  const appSignIn = definition?.credentials?.appSignIn;
  if (parsed === null || definition === undefined || appSignIn === undefined) return null;
  if (!appSignIn.hosts.includes(parsed.host)) return null;
  // The parser lowercases; keep the remote's own casing for display when it names the same path.
  const asWritten = remoteUrl
    .trim()
    .replace(/\.git\/?$/i, "")
    .split(/[/:]/)
    .slice(-2)
    .join("/");
  const repository = asWritten.toLowerCase() === parsed.path ? asWritten : parsed.path;
  return {
    definition,
    appSignIn,
    input: { provider: definition.kind, host: parsed.host, repository },
  };
}
