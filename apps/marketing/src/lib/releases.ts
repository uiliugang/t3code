import { GITHUB_REPOSITORY, GITHUB_REPOSITORY_URL } from "./repository";

export const RELEASES_URL = `${GITHUB_REPOSITORY_URL}/releases`;
export const NIGHTLY_RELEASES_URL = `${RELEASES_URL}?q=nightly&expanded=true`;

const LATEST_API_URL = `https://api.github.com/repos/${GITHUB_REPOSITORY}/releases/latest`;
// GitHub's latest endpoint excludes prereleases; the newest nightly comes from the ordered release list.
const LIST_API_URL = `https://api.github.com/repos/${GITHUB_REPOSITORY}/releases`;
const RELEASE_PAGE_SIZE = 100;
const MAX_RELEASE_PAGES = 10;

export type ReleaseChannel = "stable" | "nightly";

export interface ReleaseAsset {
  name: string;
  browser_download_url: string;
}

export interface Release {
  tag_name: string;
  html_url: string;
  published_at: string;
  assets: ReleaseAsset[];
}

function isRelease(value: unknown): value is Release {
  return (
    typeof value === "object" &&
    value !== null &&
    "tag_name" in value &&
    typeof value.tag_name === "string" &&
    "html_url" in value &&
    typeof value.html_url === "string" &&
    "published_at" in value &&
    typeof value.published_at === "string" &&
    "assets" in value &&
    Array.isArray(value.assets) &&
    value.assets.every(
      (asset: unknown) =>
        typeof asset === "object" &&
        asset !== null &&
        "name" in asset &&
        typeof asset.name === "string" &&
        "browser_download_url" in asset &&
        typeof asset.browser_download_url === "string",
    )
  );
}

function cacheKey(channel: ReleaseChannel) {
  return `t3code-${GITHUB_REPOSITORY}-${channel}-release`;
}

async function fetchStable(): Promise<Release> {
  const response = await fetch(LATEST_API_URL);
  if (!response.ok) throw new Error(`Release lookup failed (${response.status})`);
  return response.json();
}

async function fetchNightly(): Promise<Release> {
  for (let page = 1; page <= MAX_RELEASE_PAGES; page++) {
    const response = await fetch(`${LIST_API_URL}?per_page=${RELEASE_PAGE_SIZE}&page=${page}`);
    if (!response.ok) throw new Error(`Release lookup failed (${response.status})`);
    const list: Release[] = await response.json();
    if (!Array.isArray(list)) throw new Error("Invalid release list");
    const nightly = list.find((release) => release.tag_name?.includes("-nightly."));
    if (nightly) return nightly;
    if (list.length < RELEASE_PAGE_SIZE) break;
  }
  throw new Error("No nightly release in the release list");
}

export async function fetchLatestRelease(channel: ReleaseChannel = "stable"): Promise<Release> {
  const key = cacheKey(channel);
  try {
    const cached = sessionStorage.getItem(key);
    const data: unknown = cached ? JSON.parse(cached) : null;
    if (isRelease(data)) return data;
  } catch {
    // Blocked storage or a corrupt entry must not prevent loading the release.
  }

  const data = channel === "nightly" ? await fetchNightly() : await fetchStable();
  if (!isRelease(data)) throw new Error("Invalid release metadata");

  try {
    sessionStorage.setItem(key, JSON.stringify(data));
  } catch {
    // Writing is optional when storage is blocked or full.
  }

  return data;
}
