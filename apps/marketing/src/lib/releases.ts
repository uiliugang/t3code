const REPO = "pingdotgg/t3code";

export const RELEASES_URL = `https://github.com/${REPO}/releases`;
export const NIGHTLY_RELEASES_URL = `${RELEASES_URL}?q=nightly&expanded=true`;

const LATEST_API_URL = `https://api.github.com/repos/${REPO}/releases/latest`;
// GitHub's latest endpoint excludes prereleases; the newest nightly comes from the ordered release list.
const LIST_API_URL = `https://api.github.com/repos/${REPO}/releases`;
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

function cacheKey(channel: ReleaseChannel) {
  return `t3code-${channel}-release`;
}

async function fetchStable(): Promise<Release> {
  return fetch(LATEST_API_URL).then((r) => r.json());
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
  const cached = sessionStorage.getItem(key);
  if (cached) return JSON.parse(cached);

  const data = channel === "nightly" ? await fetchNightly() : await fetchStable();

  if (data?.assets) {
    sessionStorage.setItem(key, JSON.stringify(data));
  }

  return data;
}
