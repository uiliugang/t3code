import type { DaxiangApprovalKind } from "@t3tools/contracts";

export type ParsedApprovalTarget =
  | {
      readonly kind: "pr";
      readonly key: string;
      readonly url: string;
      readonly repository: string;
      readonly number: number;
    }
  | {
      readonly kind: "mcm-plan";
      readonly key: string;
      readonly url: string;
      readonly planId: string;
    }
  | {
      readonly kind: "mcm-event";
      readonly key: string;
      readonly url: string;
      readonly changeId: string;
    }
  | {
      readonly kind: "lion";
      readonly key: string;
      readonly url: string;
      readonly auditId: string;
      readonly appKey: string | null;
    }
  | {
      readonly kind: "rds";
      readonly key: string;
      readonly url: string;
      readonly flowId: string;
    }
  | {
      readonly kind: "dms";
      readonly key: string;
      readonly url: string;
      readonly flowId: string;
      readonly dagId: string | null;
    };

const URL_PATTERN = /https?:\/\/[^\s<>"'`|)）】》]+/giu;
const REPOSITORY_PATTERN = /^[a-zA-Z0-9._~-]+\/[a-zA-Z0-9._-]+$/u;

function cleanCandidateUrl(raw: string): string {
  return raw.replace(/[\].,;:!?，。；：！？、{}“”‘’]+$/u, "");
}

function collectStrings(value: unknown, out: string[], depth = 0): void {
  if (depth > 6 || value === null || value === undefined) return;
  if (typeof value === "string") {
    out.push(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectStrings(item, out, depth + 1);
    return;
  }
  if (typeof value === "object") {
    for (const entry of Object.values(value)) collectStrings(entry, out, depth + 1);
  }
}

function extractUrlsFromWatchEvent(event: unknown): ReadonlyArray<string> {
  const strings: string[] = [];
  collectStrings(event, strings);
  const urls = new Set<string>();
  for (const text of strings) {
    for (const match of text.matchAll(URL_PATTERN)) {
      const cleaned = cleanCandidateUrl(match[0]);
      if (cleaned) urls.add(cleaned);
    }
  }
  return [...urls];
}

function parseFragmentPath(hash: string): {
  readonly pathname: string;
  readonly searchParams: URLSearchParams;
} {
  const withoutHash = hash.startsWith("#") ? hash.slice(1) : hash;
  const queryIndex = withoutHash.indexOf("?");
  if (queryIndex < 0) return { pathname: withoutHash, searchParams: new URLSearchParams() };
  return {
    pathname: withoutHash.slice(0, queryIndex),
    searchParams: new URLSearchParams(withoutHash.slice(queryIndex + 1)),
  };
}

export function parseApprovalLink(rawUrl: string): ParsedApprovalTarget | null {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return null;
  }
  if ((url.protocol !== "https:" && url.protocol !== "http:") || url.username || url.password) {
    return null;
  }
  const host = url.hostname.toLowerCase();

  if (host === "dev.sankuai.com") {
    const match = /^\/code\/repo-detail\/([^/]+\/[^/]+)\/pr\/([1-9]\d*)(?:\/|$)/u.exec(
      url.pathname,
    );
    if (match?.[1] && match[2] && REPOSITORY_PATTERN.test(match[1])) {
      const repository = match[1];
      const number = Number(match[2]);
      return {
        kind: "pr",
        key: `pr:${repository.toLowerCase()}#${number}`,
        url: `https://dev.sankuai.com/code/repo-detail/${repository}/pr/${number}/diff`,
        repository,
        number,
      };
    }
  }
  if (host === "git.sankuai.com") {
    const match = /^\/projects\/([^/]+)\/repos\/([^/]+)\/pull-requests\/([1-9]\d*)(?:\/|$)/u.exec(
      url.pathname,
    );
    const repo = match?.[1] && match[2] ? `${match[1]}/${match[2]}` : "";
    if (repo && match?.[3] && REPOSITORY_PATTERN.test(repo)) {
      const number = Number(match[3]);
      return {
        kind: "pr",
        key: `pr:${repo.toLowerCase()}#${number}`,
        url: `https://dev.sankuai.com/code/repo-detail/${repo}/pr/${number}/diff`,
        repository: repo,
        number,
      };
    }
  }

  if (
    host === "mcm.mws.sankuai.com" ||
    host === "mcm.mws-test.sankuai.com" ||
    host === "mcm.vip.sankuai.com"
  ) {
    const fragment = parseFragmentPath(url.hash);
    const combinedPath = fragment.pathname || url.pathname;
    const planMatch = /\/(?:mine\/)?plan\/detail\/([1-9]\d*)(?:\/|$)/u.exec(combinedPath);
    if (planMatch?.[1]) {
      return {
        kind: "mcm-plan",
        key: `mcm-plan:${host}:${planMatch[1]}`,
        url: url.href,
        planId: planMatch[1],
      };
    }
    const eventMatch = /\/process-center\/detail\/([1-9]\d*)(?:\/|$)/u.exec(combinedPath);
    if (eventMatch?.[1]) {
      return {
        kind: "mcm-event",
        key: `mcm-event:${host}:${eventMatch[1]}`,
        url: url.href,
        changeId: eventMatch[1],
      };
    }
  }

  if (
    host === "lion.mws.sankuai.com" ||
    host === "lion.mws-test.sankuai.com" ||
    host === "lion.sankuai.com"
  ) {
    const fragment = parseFragmentPath(url.hash);
    const auditId =
      url.searchParams.get("auditId") ??
      fragment.searchParams.get("auditId") ??
      /\/audit\/([1-9]\d*)(?:\/|$)/u.exec(fragment.pathname || url.pathname)?.[1] ??
      null;
    if (auditId && /^[1-9]\d*$/u.test(auditId)) {
      const appKey = url.searchParams.get("appKey") ?? fragment.searchParams.get("appKey");
      return {
        kind: "lion",
        key: `lion:${host}:${auditId}`,
        url: url.href,
        auditId,
        appKey: appKey?.trim() || null,
      };
    }
  }

  if (
    host === "rds.mws.sankuai.com" ||
    host === "rds.mws-test.sankuai.com" ||
    host === "sqlaudit.mws.sankuai.com"
  ) {
    const match = /^\/dba\/mission_detail(?:_appr)?\/([a-zA-Z0-9_-]+)(?:\/|$)/u.exec(url.pathname);
    if (match?.[1]) {
      return {
        kind: "rds",
        key: `rds:${host}:${match[1]}`,
        url: url.href,
        flowId: match[1],
      };
    }
  }

  if (
    host === "dms.mws.sankuai.com" ||
    host === "dms.mws-test.sankuai.com" ||
    host === "dms.sankuai.com"
  ) {
    const match =
      /^\/(?:mc\/import_mission_detail|dms\/iframe\/mission-detail)\/([a-zA-Z0-9_-]+)(?:\/|$)/u.exec(
        url.pathname,
      );
    if (match?.[1]) {
      const dagId = url.searchParams.get("dagId");
      return {
        kind: "dms",
        key: `dms:${host}:${match[1]}`,
        url: url.href,
        flowId: match[1],
        dagId: dagId?.trim() || null,
      };
    }
  }

  return null;
}

export function extractApprovalTargets(event: unknown): ReadonlyArray<ParsedApprovalTarget> {
  const seen = new Set<string>();
  const targets: ParsedApprovalTarget[] = [];
  for (const url of extractUrlsFromWatchEvent(event)) {
    const parsed = parseApprovalLink(url);
    if (!parsed || seen.has(parsed.key)) continue;
    seen.add(parsed.key);
    targets.push(parsed);
  }
  return targets;
}

export function approvalTargetLabel(target: ParsedApprovalTarget): string {
  switch (target.kind) {
    case "pr":
      return `${target.repository} #${target.number}`;
    case "mcm-plan":
      return `MCM #${target.planId}`;
    case "mcm-event":
      return `MCM Event #${target.changeId}`;
    case "lion":
      return target.appKey
        ? `Lion #${target.auditId} (${target.appKey})`
        : `Lion #${target.auditId}`;
    case "rds":
      return `RDS ${target.flowId.slice(0, 12)}`;
    case "dms":
      return target.dagId
        ? `DMS ${target.flowId.slice(0, 12)} (${target.dagId})`
        : `DMS ${target.flowId.slice(0, 12)}`;
  }
}

export function isDirectAutoApproveKind(
  kind: DaxiangApprovalKind,
): kind is "pr" | "mcm-plan" | "mcm-event" {
  return kind === "pr" || kind === "mcm-plan" || kind === "mcm-event";
}
