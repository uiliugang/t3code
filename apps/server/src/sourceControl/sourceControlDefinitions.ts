import { builtInSourceControlDefinitions } from "@t3tools/source-control-definitions/registry";
import * as GitHubDriver from "@t3tools/source-control-github/server/driver";
import * as GitLabDriver from "@t3tools/source-control-gitlab/server/driver";
import * as MeituanDriver from "@t3tools/source-control-meituan/server/driver";
import * as TanStackSourceDriver from "@t3tools/source-control-tanstack-source/server/driver";

/**
 * In the shared registry's order, which is the order hosts are listed and probed in. Feature
 * flags leave some out; see `builtInDrivers.ts`.
 */
export const BUILT_IN_SOURCE_CONTROL_DRIVER_LIST = [
  GitHubDriver.driver,
  GitLabDriver.driver,
  MeituanDriver.driver,
  TanStackSourceDriver.driver,
] as const;

export const sourceControlDefinitions = builtInSourceControlDefinitions;

export function isLocalRemoteUrl(url: string): boolean {
  if (/^file:/i.test(url)) return true;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(url)) return false;
  if (/^[a-z]:[\\/]/i.test(url)) return true;
  const colonIndex = url.indexOf(":");
  const slashIndex = url.search(/[\\/]/);
  return colonIndex === -1 || (slashIndex !== -1 && slashIndex < colonIndex);
}

export function selectRequirementRemote(
  remotes: ReadonlyArray<{ readonly name: string; readonly url: string }>,
) {
  const origin = remotes.find((remote) => remote.name === "origin");
  const targets = remotes.filter(
    (remote) => remote.name !== "gb-local" || !/^\.[\\/]?$/u.test(remote.url),
  );
  const candidates =
    targets.length > 1 ? targets.filter((remote) => remote.name !== "upstream") : targets;
  const selected = origin ?? (candidates.length === 1 ? candidates[0] : undefined);
  if (!selected || isLocalRemoteUrl(selected.url)) return null;
  const provider = sourceControlDefinitions.recognizeRemote(selected.url);
  return provider ? { remoteName: selected.name, remoteUrl: selected.url, provider } : null;
}

/** A host CLI command that merges or closes a change request, such as `gh pr merge`. */
export const isChangeRequestCloseCommand = (command: string) =>
  sourceControlDefinitions.definitions.some(
    (definition) => definition.changeRequestCloseCommand?.test(command) === true,
  );

// A quoted or bare shell word. An unclosed quote, as Codex's `/bin/zsh -lc "gh pr merge 19"`
// leaves after the match, runs to the end.
const SHELL_WORD = /"((?:\\[\s\S]|[^"\\])*)"?|'([^']*)'?|((?:\\[\s\S]|[^\s"'\\])+)/gu;
// A whole word that names one, so a number inside `--subject "Release 20"` does not.
const NAMED_CHANGE_REQUEST = /^(?:--?[\w-]+=)?#?(\d+)$|^\S*\/(?:pulls?|merge_requests)\/(\d+)\/?$/u;

/**
 * The change request numbers a merge or close command names, or "any" when one names none, as a
 * bare `gh pr merge` on the checked-out branch or `gh stack merge` does.
 */
export function changeRequestsClosedBy(command: string): ReadonlySet<number> | "any" {
  const named = new Set<number>();
  for (const { changeRequestCloseCommand: close } of sourceControlDefinitions.definitions) {
    if (close === undefined) continue;
    for (const match of command.matchAll(new RegExp(close.source, `${close.flags}g`))) {
      // From the match's start, since Azure's match runs through `--id` to `--status`.
      const args = command.slice(match.index).split(/[;&|\n]/u, 1)[0] ?? "";
      // Every host's merge and close takes one change request, so any later one is option text.
      let target: string | undefined;
      for (const [, double, single, bare] of args.matchAll(SHELL_WORD)) {
        // A comment ends the command.
        if (bare !== undefined && /^#(?!\d+$)/u.test(bare)) break;
        const [, number, url] = NAMED_CHANGE_REQUEST.exec(double ?? single ?? bare ?? "") ?? [];
        target = number ?? url;
        if (target !== undefined) break;
      }
      if (target === undefined) return "any";
      named.add(Number(target));
    }
  }
  return named.size === 0 ? "any" : named;
}
