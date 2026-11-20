// @effect-diagnostics nodeBuiltinImport:off - Exercises the shell installer with isolated platform command fixtures.
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { describe, expect, it } from "vite-plus/test";

const appName = "T3 Code.app";
const betaAppName = "T3 Code (Beta).app";
const bundleId = "com.t3tools.t3code";
const version = "1.2.3";
const asset = `T3-Code-${version}-arm64.dmg`;
const dmg = "desktop disk image";
const checksum = NodeCrypto.createHash("sha256").update(dmg).digest("hex");
const installer = NodePath.resolve(import.meta.dirname, "install-desktop.sh");
const appImage = Buffer.concat([
  Buffer.from([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1, 0, 0x41, 0x49, 2]),
  Buffer.from("new desktop"),
]);
const oldAppImage = Buffer.concat([appImage.subarray(0, 11), Buffer.from("old desktop")]);

const commandFixture = `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const root = process.env.FIXTURE_ROOT;
const options = JSON.parse(process.env.FIXTURE_OPTIONS);
const command = path.basename(process.argv[1]);
const args = process.argv.slice(2);
const linux = options.platform === 'Linux';
const linuxAsset = 'T3-Code-' + (['arm64', 'aarch64'].includes(options.arch) ? 'arm64' : 'x86_64') + '.AppImage';
const destination = path.join(root, 'Applications', linux ? linuxAsset : options.betaRelease ? '${betaAppName}' : '${appName}');
fs.appendFileSync(path.join(root, 'commands.jsonl'), JSON.stringify({ command, args }) + '\\n');
switch (command) {
  case 'uname':
    console.log(args[0] === '-s' ? (options.platform || 'Darwin') : (options.arch || 'arm64'));
    break;
  case 'sysctl':
    console.log(options.appleSilicon === false ? '0' : '1');
    break;
  case 'sw_vers':
    console.log(options.systemVersion || '13.0.0');
    break;
  case 'curl': {
    const url = args.at(-1);
    const output = args[args.indexOf('-o') + 1];
    if (options.downloadFailure && url.endsWith(options.downloadFailure)) process.exit(22);
    if (args.includes('%{url_effective}')) {
      process.stdout.write('https://github.com/uiliugang/t3code/releases/tag/' + (options.tag || 'v1.2.3'));
      break;
    }
    const image = linux ? fs.readFileSync(path.join(root, 'appimage')) : null;
    const body = url.endsWith('/releases/latest')
      ? JSON.stringify({ tag_name: options.tag || 'v1.2.3' })
      : url.endsWith('/SHA256SUMS')
        ? (options.nativeImage ? fs.readFileSync(path.join(root, 'SHA256SUMS')) : options.checksums ?? (linux ? require('node:crypto').createHash('sha256').update(image).digest('hex') + '  ' + linuxAsset + '\\n' : '${checksum}  ${asset}\\n'))
        : options.nativeImage ? fs.readFileSync(path.join(root, '${asset}')) : linux ? image : '${dmg}';
    fs.writeFileSync(output, body);
    break;
  }
  case 'plutil': {
    const document = JSON.parse(fs.readFileSync(args.at(-1), 'utf8'));
    const value = document[args[args.indexOf('-extract') + 1]];
    if (typeof value !== 'string') process.exit(1);
    console.log(value);
    break;
  }
  case 'hdiutil':
    if (args[0] === 'attach') {
      if (options.mountFailure) process.exit(1);
      const mount = args[args.indexOf('-mountpoint') + 1];
      fs.cpSync(path.join(root, 'image'), mount, { recursive: true });
    }
    break;
  case 'lsappinfo':
    if (options.running || (options.runningAfterCopy && fs.existsSync(path.join(root, 'copied')))) console.log('ASN:0x0-0x1:');
    break;
  case 'pgrep': {
    const running = options.running || (options.runningAfterCopy && fs.existsSync(path.join(root, 'copied'))) || (options.otherUserRunning && !args.includes('-u'));
    process.exit(options.processCheckFailure ? 2 : running ? 0 : 1);
    break;
  }
  case 'codesign':
    if (options.badSignature) process.exit(1);
    break;
  case 'cp':
  case 'ditto':
    if (options.copyFailure) process.exit(1);
    fs.cpSync(args.at(-2), args.at(-1), { recursive: true });
    fs.writeFileSync(path.join(root, 'copied'), '');
    break;
  case 'mv':
    if (options.restoreFailure && args.at(-2).endsWith('/previous')) process.exit(1);
    if (options.backupFailure && args.at(-1).endsWith('/previous')) process.exit(1);
    if (options.replaceFailure && args.at(-1) === destination && !args.at(-2).endsWith('/previous')) {
      console.error('fixture: replacement failed');
      process.exit(1);
    }
    fs.renameSync(args.at(-2), args.at(-1));
    break;
  default:
    throw new Error('Unexpected fixture command: ' + command);
}
`;

async function fixture(options: Record<string, unknown> = {}) {
  options = { arch: "arm64", ...options };
  const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-desktop-install-"));
  const bin = NodePath.join(root, "bin");
  const installDir = NodePath.join(root, "Applications");
  const linuxAsset = `T3-Code-${["arm64", "aarch64"].includes(String(options.arch)) ? "arm64" : "x86_64"}.AppImage`;
  const imageAppName = options.betaRelease ? betaAppName : appName;
  const destination = NodePath.join(
    installDir,
    options.platform === "Linux" ? linuxAsset : imageAppName,
  );
  const source = await NodeFSP.readFile(installer, "utf8");
  await NodeFSP.mkdir(bin);
  await NodeFSP.mkdir(installDir);
  await NodeFSP.writeFile(
    NodePath.join(root, "appimage"),
    options.badImage ? "not an AppImage" : appImage,
  );
  await NodeFSP.mkdir(NodePath.join(root, "home", ".t3"), { recursive: true });
  await NodeFSP.writeFile(NodePath.join(root, "home", ".t3", "user-data"), "keep me");
  await NodeFSP.mkdir(NodePath.join(root, "image", imageAppName, "Contents"), { recursive: true });
  await NodeFSP.writeFile(
    NodePath.join(root, "image", imageAppName, "Contents", "Info.plist"),
    JSON.stringify({
      CFBundleIdentifier: options.bundleId ?? bundleId,
      CFBundleShortVersionString: options.bundleVersion ?? version,
      LSMinimumSystemVersion: options.minimumSystemVersion ?? "13.0",
    }),
  );
  for (const command of [
    "uname",
    "sysctl",
    "sw_vers",
    "curl",
    "plutil",
    "hdiutil",
    "lsappinfo",
    "pgrep",
    "codesign",
    "ditto",
    "cp",
    "mv",
  ]) {
    if (options.nativeImage && !["curl", "lsappinfo"].includes(command)) continue;
    await NodeFSP.writeFile(NodePath.join(bin, command), commandFixture, { mode: 0o755 });
  }
  return {
    root,
    destination,
    installDir,
    async existingApp(id = bundleId, existingPath = destination) {
      if (options.platform === "Linux") {
        await NodeFSP.writeFile(destination, oldAppImage);
        await NodeFSP.writeFile(
          NodePath.join(installDir, ".t3-desktop-source"),
          "uiliugang/t3code\n",
        );
        return;
      }
      await NodeFSP.mkdir(NodePath.join(existingPath, "Contents"), { recursive: true });
      await NodeFSP.writeFile(
        NodePath.join(existingPath, "Contents", "Info.plist"),
        JSON.stringify({ CFBundleIdentifier: id, CFBundleShortVersionString: "1.0.0" }),
      );
      await NodeFSP.writeFile(NodePath.join(existingPath, "old.txt"), "old app");
    },
    run(env: NodeJS.ProcessEnv = {}) {
      return NodeChildProcess.spawnSync("sh", options.pipe ? [] : [installer], {
        input: options.pipe ? source : undefined,
        env: {
          ...process.env,
          HOME: NodePath.join(root, "home"),
          PATH: `${bin}${NodePath.delimiter}${process.env.PATH}`,
          TMPDIR: root,
          FIXTURE_ROOT: root,
          FIXTURE_OPTIONS: JSON.stringify(options),
          T3CODE_VERSION: "",
          T3CODE_RELEASE_BASE_URL: "https://mirror.example/download",
          T3CODE_DESKTOP_INSTALL_DIR: installDir,
          ...env,
        },
        encoding: "utf8",
      });
    },
    async commands() {
      const content = await NodeFSP.readFile(NodePath.join(root, "commands.jsonl"), "utf8");
      return content
        .trim()
        .split("\n")
        .map(
          (line) =>
            JSON.parse(line) as {
              command: string;
              args: string[];
            },
        );
    },
    async [Symbol.asyncDispose]() {
      await NodeFSP.rm(root, { recursive: true, force: true });
    },
  };
}

describe.skipIf(HostProcess.Platform.defaultValue() === "win32")("desktop installer", () => {
  it.each([false, true])(
    "installs a verified desktop release (existing app: %s)",
    async (existing) => {
      await using test = await fixture();
      if (existing) await test.existingApp();
      const result = test.run();
      expect(result.status, result.stdout + result.stderr).toBe(0);
      expect(result.stdout + result.stderr).toContain(version);
      const info = JSON.parse(
        await NodeFSP.readFile(NodePath.join(test.destination, "Contents", "Info.plist"), "utf8"),
      );
      expect(info.CFBundleShortVersionString).toBe(version);
      expect(
        await NodeFSP.readFile(NodePath.join(test.root, "home", ".t3", "user-data"), "utf8"),
      ).toBe("keep me");
      expect(await NodeFSP.readdir(test.installDir)).toEqual([appName]);
      const commands = await test.commands();
      expect(
        commands.filter(({ command }) => command === "curl").map(({ args }) => args.at(-1)),
      ).toEqual([
        "https://github.com/uiliugang/t3code/releases/latest",
        `https://mirror.example/download/v${version}/SHA256SUMS`,
        `https://mirror.example/download/v${version}/${asset}`,
      ]);
      expect(
        commands.filter(({ command }) => command === "hdiutil").map(({ args }) => args[0]),
      ).toEqual(["attach", "detach"]);
      expect(commands.some(({ command }) => command === "codesign")).toBe(true);
    },
  );

  it("pins a version without looking up latest and supports Rosetta on Apple Silicon", async () => {
    await using test = await fixture({
      arch: "x86_64",
      systemVersion: "13.10",
      minimumSystemVersion: "13.9.8",
    });
    const result = test.run({ T3CODE_VERSION: version });
    expect(result.status, result.stdout + result.stderr).toBe(0);
    const urls = (await test.commands())
      .filter(({ command }) => command === "curl")
      .map(({ args }) => args.at(-1));
    expect(urls).toHaveLength(2);
    expect(urls.at(-1)).toBe(`https://mirror.example/download/v${version}/${asset}`);
  });

  it.each([
    [{ checksums: `${"0".repeat(64)}  ${asset}\n` }, "checksum mismatch"],
    [{ checksums: "" }, "checksum"],
    [{ checksums: `${checksum}  ${asset}\n${checksum}  ${asset}\n` }, "checksum"],
    [{ downloadFailure: ".dmg" }, "download"],
    [{ badSignature: true }, "signature"],
    [{ bundleId: "com.example.other" }, "bundle"],
    [{ bundleVersion: "9.9.9" }, "version"],
    [{ systemVersion: "12.7.6", minimumSystemVersion: "13.0" }, "requires macOS 13.0"],
    [{ systemVersion: "13.0.1", minimumSystemVersion: "13.0.2" }, "requires macOS 13.0.2"],
    [{ copyFailure: true }, "copy"],
    [{ backupFailure: true }, "back up"],
    [{ mountFailure: true }, "mount"],
    [{ running: true }, "Quit T3 Code"],
    [{ runningAfterCopy: true }, "Quit T3 Code"],
    [{ platform: "FreeBSD" }, "operating system"],
    [{ arch: "x86_64", appleSilicon: false }, "Apple Silicon"],
    [{ tag: "v1.2.3/../../escape" }, "version"],
    [{ tag: "v1.2.3\n1.2.4" }, "version"],
  ] as const)("leaves the old app intact on failure: %j", async (options, message) => {
    await using test = await fixture(options);
    await test.existingApp();
    const result = test.run();
    expect(result.status, result.stdout + result.stderr).not.toBe(0);
    expect(result.stdout + result.stderr).toContain(message);
    expect(await NodeFSP.readFile(NodePath.join(test.destination, "old.txt"), "utf8")).toBe(
      "old app",
    );
    expect(await NodeFSP.readdir(test.installDir)).toEqual([appName]);
  });

  it("preserves an existing Beta app when the requested release has the same name", async () => {
    await using test = await fixture({ betaRelease: true });
    await test.existingApp();

    const result = test.run({ T3CODE_VERSION: version });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(`Move ${test.destination} out of the install directory`);
    expect(await NodeFSP.readFile(NodePath.join(test.destination, "old.txt"), "utf8")).toBe(
      "old app",
    );
  });

  it("restores the previous app if the final rename fails", async () => {
    await using test = await fixture({ replaceFailure: true });
    await test.existingApp();
    const result = test.run();
    expect(result.status, result.stdout + result.stderr).not.toBe(0);
    expect(result.stdout + result.stderr).toContain("could not install the new app");
    expect(result.stdout + result.stderr).toContain("Restored the previous app");
    expect(await NodeFSP.readFile(NodePath.join(test.destination, "old.txt"), "utf8")).toBe(
      "old app",
    );
    expect(await NodeFSP.readdir(test.installDir)).toEqual([appName]);
  });

  it.each([
    { betaRelease: false, bothInstalled: false },
    { betaRelease: false, bothInstalled: true },
    { betaRelease: true, bothInstalled: false },
  ])("preserves conflicting macOS apps: %j", async ({ betaRelease, bothInstalled }) => {
    await using test = await fixture({ betaRelease });
    const otherName = betaRelease ? appName : betaAppName;
    const otherApp = NodePath.join(test.installDir, otherName);
    await test.existingApp(bundleId, otherApp);
    if (bothInstalled) await test.existingApp();

    const result = test.run(betaRelease ? { T3CODE_VERSION: version } : {});
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(`Move ${otherApp} out of the install directory`);
    expect(await NodeFSP.readFile(NodePath.join(otherApp, "old.txt"), "utf8")).toBe("old app");
    expect((await NodeFSP.readdir(test.installDir)).sort()).toEqual(
      bothInstalled ? [betaAppName, appName] : [otherName],
    );
  });

  it.each(["Darwin", "Linux"])(
    "preserves the backup when restoring it fails on %s",
    async (platform) => {
      await using test = await fixture({ platform, replaceFailure: true, restoreFailure: true });
      await test.existingApp();
      const result = test.run();
      expect(result.status).not.toBe(0);
      expect(result.stdout + result.stderr).toContain("Previous app preserved at");
      const staging = (await NodeFSP.readdir(test.installDir)).find((entry) =>
        entry.startsWith(".t3-desktop."),
      );
      expect(staging).toMatch(/^\.t3-desktop\./);
      const previous = NodePath.join(test.installDir, staging!, "previous");
      if (platform === "Linux") expect(await NodeFSP.readFile(previous)).toEqual(oldAppImage);
      else
        expect(await NodeFSP.readFile(NodePath.join(previous, "old.txt"), "utf8")).toBe("old app");
    },
  );

  it("refuses another application or a symlink at the destination", async () => {
    await using test = await fixture();
    await test.existingApp("com.example.other");
    const foreign = test.run();
    expect(foreign.status).not.toBe(0);
    expect(foreign.stdout + foreign.stderr).toContain("refusing to replace another app");
    expect(await NodeFSP.readFile(NodePath.join(test.destination, "old.txt"), "utf8")).toBe(
      "old app",
    );
    const other = NodePath.join(test.root, "other.app");
    await NodeFSP.rename(test.destination, other);
    await NodeFSP.symlink(other, test.destination);
    const symlink = test.run();
    expect(symlink.status).not.toBe(0);
    expect(symlink.stdout + symlink.stderr).toContain("refusing to replace a symbolic link");
    expect(await NodeFSP.readlink(test.destination)).toBe(other);
    expect(await NodeFSP.readdir(test.installDir)).toEqual([appName]);
  });

  it.each(["Darwin", "Linux"])(
    "does not remove another installer's lock on %s",
    async (platform) => {
      await using test = await fixture({ platform });
      const lock = NodePath.join(test.installDir, ".t3-desktop-install.lock");
      await NodeFSP.mkdir(lock);
      const result = test.run();
      expect(result.status).not.toBe(0);
      expect(result.stdout + result.stderr).toContain("another installer");
      expect(await NodeFSP.readdir(test.installDir)).toEqual([NodePath.basename(lock)]);
    },
  );

  describe("Linux AppImage", () => {
    it.each(["x86_64", "amd64", "arm64", "aarch64"])(
      "selects the published package for %s",
      async (arch) => {
        await using test = await fixture({
          platform: "Linux",
          arch,
          pipe: true,
          otherUserRunning: true,
        });
        const result = test.run();
        expect(result.status, result.stdout + result.stderr).toBe(0);
        expect(await NodeFSP.readFile(test.destination)).toEqual(appImage);
        expect((await NodeFSP.stat(test.destination)).mode & 0o111).not.toBe(0);
        const commands = await test.commands();
        expect(commands.find(({ command }) => command === "pgrep")?.args).toEqual([
          "-u",
          String(process.getuid?.()),
          "-x",
          "t3code",
        ]);
        expect(
          commands
            .filter(({ command }) => command === "curl")
            .at(-1)
            ?.args.at(-1),
        ).toBe(
          `https://mirror.example/download/v${version}/${NodePath.basename(test.destination)}`,
        );
        expect(
          commands.some(({ command }) => ["hdiutil", "plutil", "codesign"].includes(command)),
        ).toBe(false);
        expect(
          await NodeFSP.readFile(NodePath.join(test.installDir, ".t3-desktop-source"), "utf8"),
        ).toBe("uiliugang/t3code\n");
      },
    );

    it("updates its own installation without touching T3 home", async () => {
      await using test = await fixture({ platform: "Linux", arch: "x86_64" });
      await test.existingApp();
      const result = test.run({ T3CODE_VERSION: version });
      expect(result.status, result.stdout + result.stderr).toBe(0);
      expect(await NodeFSP.readFile(test.destination)).toEqual(appImage);
      expect(await NodeFSP.readdir(test.installDir)).toEqual([
        ".t3-desktop-source",
        NodePath.basename(test.destination),
      ]);
      expect(
        await NodeFSP.readFile(NodePath.join(test.root, "home", ".t3", "user-data"), "utf8"),
      ).toBe("keep me");
      expect((await test.commands()).filter(({ command }) => command === "curl")).toHaveLength(2);
    });

    it("defaults to the current user's Applications directory", async () => {
      await using test = await fixture({ platform: "Linux", arch: "x86_64" });
      const result = test.run({ T3CODE_DESKTOP_INSTALL_DIR: "" });
      expect(result.status, result.stdout + result.stderr).toBe(0);
      expect(
        await NodeFSP.readFile(
          NodePath.join(test.root, "home", "Applications", "T3-Code-x86_64.AppImage"),
        ),
      ).toEqual(appImage);
    });

    it("removes its source marker if the first installation fails", async () => {
      await using test = await fixture({ platform: "Linux", arch: "x86_64", replaceFailure: true });
      const result = test.run();
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("could not install the new app");
      expect(await NodeFSP.readdir(test.installDir)).toEqual([]);
    });

    it.each([
      [{ checksums: `${"0".repeat(64)}  T3-Code-x86_64.AppImage\n` }, "checksum mismatch"],
      [{ badImage: true }, "AppImage"],
      [{ downloadFailure: ".AppImage" }, "download"],
      [{ copyFailure: true }, "copy"],
      [{ backupFailure: true }, "back up"],
      [{ replaceFailure: true }, "could not install"],
      [{ running: true }, "Quit T3 Code"],
      [{ runningAfterCopy: true }, "Quit T3 Code"],
      [{ processCheckFailure: true }, "could not check"],
      [{ arch: "riscv64" }, "architecture"],
    ] as const)(
      "keeps the previous image when installation fails: %j",
      async (options, message) => {
        await using test = await fixture({ platform: "Linux", arch: "x86_64", ...options });
        await test.existingApp();
        const result = test.run();
        expect(result.status, result.stdout + result.stderr).not.toBe(0);
        expect(result.stdout + result.stderr).toContain(message);
        expect(await NodeFSP.readFile(test.destination)).toEqual(oldAppImage);
        expect(await NodeFSP.readdir(test.installDir)).toEqual([
          ".t3-desktop-source",
          NodePath.basename(test.destination),
        ]);
      },
    );

    it("refuses unmanaged files and symbolic links", async () => {
      await using test = await fixture({ platform: "Linux", arch: "x86_64" });
      await NodeFSP.writeFile(test.destination, appImage);
      const unmanaged = test.run();
      expect(unmanaged.status).not.toBe(0);
      expect(unmanaged.stderr).toContain("unmanaged AppImage");
      expect(await NodeFSP.readFile(test.destination)).toEqual(appImage);
      await NodeFSP.writeFile(
        NodePath.join(test.installDir, ".t3-desktop-source"),
        "example/other\n",
      );
      const foreign = test.run();
      expect(foreign.status).not.toBe(0);
      expect(foreign.stderr).toContain("source marker");
      expect(await NodeFSP.readFile(test.destination)).toEqual(appImage);
      await NodeFSP.rm(test.destination);
      await NodeFSP.symlink(NodePath.join(test.root, "appimage"), test.destination);
      const symlink = test.run();
      expect(symlink.status).not.toBe(0);
      expect(await NodeFSP.readlink(test.destination)).toBe(NodePath.join(test.root, "appimage"));
    });
  });

  it.skipIf(HostProcess.Platform.defaultValue() !== "darwin").each([undefined, "99.0"])(
    "checks a real ad hoc signed DMG against minimum macOS %s",
    async (minimumMacOS) => {
      await using test = await fixture({ nativeImage: true });
      const source = NodePath.join(test.root, "image", appName);
      const contents = NodePath.join(source, "Contents");
      await NodeFSP.mkdir(NodePath.join(contents, "MacOS"));
      await NodeFSP.copyFile("/usr/bin/true", NodePath.join(contents, "MacOS", "T3"));
      await NodeFSP.writeFile(
        NodePath.join(contents, "Info.plist"),
        `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleIdentifier</key><string>${bundleId}</string>
<key>CFBundleExecutable</key><string>T3</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>CFBundleVersion</key><string>${version}</string>
<key>CFBundleShortVersionString</key><string>${version}</string>
${minimumMacOS === undefined ? "" : `<key>LSMinimumSystemVersion</key><string>${minimumMacOS}</string>`}
</dict></plist>
`,
      );
      NodeChildProcess.execFileSync("/usr/bin/codesign", ["--force", "--sign", "-", source]);
      const image = NodePath.join(test.root, asset);
      NodeChildProcess.execFileSync("/usr/bin/hdiutil", [
        "create",
        "-quiet",
        "-fs",
        "HFS+",
        "-srcfolder",
        NodePath.dirname(source),
        image,
      ]);
      const hash = NodeCrypto.createHash("sha256")
        .update(await NodeFSP.readFile(image))
        .digest("hex");
      await NodeFSP.writeFile(NodePath.join(test.root, "SHA256SUMS"), `${hash}  ${asset}\n`);
      if (minimumMacOS !== undefined) await test.existingApp();
      const result = test.run();
      if (minimumMacOS === undefined) {
        expect(result.status, result.stdout + result.stderr).toBe(0);
        expect(result.stdout).toContain(`Installed T3 Code ${version}`);
        NodeChildProcess.execFileSync("/usr/bin/codesign", [
          "--verify",
          "--deep",
          "--strict",
          test.destination,
        ]);
      } else {
        expect(result.status, result.stdout + result.stderr).not.toBe(0);
        expect(result.stderr).toContain(`requires macOS ${minimumMacOS}`);
        expect(await NodeFSP.readFile(NodePath.join(test.destination, "old.txt"), "utf8")).toBe(
          "old app",
        );
      }
      expect(await NodeFSP.readdir(test.installDir)).toEqual([appName]);
    },
  );
});
