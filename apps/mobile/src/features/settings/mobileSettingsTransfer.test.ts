import { parseSettingsFile, type SettingsFile } from "@t3tools/client-runtime/settings-transfer";
import { File } from "expo-file-system";
import { expect, it, vi } from "vite-plus/test";

import { isForegroundHandoffActive } from "../../lib/foreground-handoff";
import { shareSettingsFile } from "./mobileSettingsTransfer";

const mocks = vi.hoisted(() => ({
  directories: new Set<string>(),
  files: new Map<string, string>(),
  writeFails: false,
  share: vi.fn<(uri: string) => Promise<void>>(),
}));

vi.mock("expo-file-system", () => {
  class Directory {
    readonly uri: string;

    constructor(...parts: Array<string | Directory>) {
      this.uri = parts.map((part) => (typeof part === "string" ? part : part.uri)).join("/");
    }

    get name() {
      return this.uri.split("/").at(-1)!;
    }

    get exists() {
      return mocks.directories.has(this.uri);
    }

    create() {
      mocks.directories.add(this.uri);
    }

    list() {
      const prefix = `${this.uri}/`;
      return [...mocks.directories]
        .filter((uri) => uri.startsWith(prefix) && !uri.slice(prefix.length).includes("/"))
        .map((uri) => new Directory(uri));
    }

    delete() {
      mocks.directories.delete(this.uri);
      for (const uri of mocks.files.keys()) {
        if (uri.startsWith(`${this.uri}/`)) mocks.files.delete(uri);
      }
    }
  }

  class File {
    readonly uri: string;

    constructor(parent: string | Directory, name?: string) {
      const uri = typeof parent === "string" ? parent : parent.uri;
      this.uri = name ? `${uri}/${name}` : uri;
    }

    write(contents: string | Uint8Array) {
      if (mocks.writeFails) throw new Error("Disk full");
      mocks.files.set(
        this.uri,
        typeof contents === "string" ? contents : new TextDecoder().decode(contents),
      );
    }

    async text() {
      const contents = mocks.files.get(this.uri);
      if (contents === undefined) throw new Error("Shared file was deleted");
      return contents;
    }
  }

  return { Directory, File, Paths: { cache: "file:///cache" } };
});

vi.mock("expo-sharing", () => ({
  isAvailableAsync: async () => true,
  shareAsync: mocks.share,
}));
vi.mock("../../lib/uuid", () => ({ uuidv4: () => "00000000-0000-4000-8000-000000000001" }));

const settings: SettingsFile = {
  format: "t3-code-settings",
  version: 1,
  scope: "application",
  providers: {},
  clientSettings: { uiLanguage: "zh-CN" },
  server: {},
  keybindings: [],
};

function setup() {
  mocks.directories.clear();
  mocks.files.clear();
  mocks.writeFails = false;
  mocks.share.mockReset();
}

it("keeps exported settings readable after Android's share chooser returns", async () => {
  setup();
  const opened = Promise.withResolvers<void>();
  const shared = Promise.withResolvers<void>();
  let exportedUri = "";
  mocks.share.mockImplementation((uri) => {
    exportedUri = uri;
    opened.resolve();
    return shared.promise;
  });
  const exporting = shareSettingsFile(settings);
  await opened.promise;
  expect(isForegroundHandoffActive()).toBe(true);
  shared.resolve();
  await exporting;

  expect(isForegroundHandoffActive()).toBe(false);
  expect(parseSettingsFile(await new File(exportedUri).text())).toEqual(settings);
});

it.each(["write", "share"])("cleans a failed %s and ends its foreground handoff", async (stage) => {
  setup();
  mocks.writeFails = stage === "write";
  mocks.share.mockRejectedValue(new Error("Share failed"));

  await expect(shareSettingsFile(settings)).rejects.toThrow();

  expect(isForegroundHandoffActive()).toBe(false);
  expect(mocks.files.size).toBe(0);
  expect(
    [...mocks.directories].filter((uri) => uri.endsWith("00000000-0000-4000-8000-000000000001")),
  ).toEqual([]);
});
