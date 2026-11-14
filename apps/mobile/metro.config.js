const fs = require("node:fs");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { getDefaultConfig } = require("expo/metro-config");
const { withUniwindConfig } = require("uniwind/metro");
const extraThemes = require("./generated-uniwind-theme-names.json");

/** @type {import("expo/metro-config").MetroConfig} */
const config = getDefaultConfig(__dirname);
const workspaceRoot = path.resolve(__dirname, "../..");
const generatedLicenseModuleRoot = path.join(__dirname, ".generated", "third-party-licenses");
const licenseGeneratorSource = path.join(
  workspaceRoot,
  "scripts",
  "lib",
  "third-party-licenses.ts",
);
const escapedWorkspaceRoot = workspaceRoot.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const generatedDeviceStreamRoot = path.join(__dirname, ".generated", "device-stream");
const generatedPreviewStreamRoot = path.join(__dirname, ".generated", "preview-stream");

const nodeModulesRoot = fs.realpathSync(path.join(workspaceRoot, "node_modules"));
// pnpm 12 stores JSON in .modules.yaml; its store path is relative to the physical modules directory.
const { virtualStoreDir } = JSON.parse(
  fs.readFileSync(path.join(nodeModulesRoot, ".modules.yaml"), "utf8"),
);
const virtualStoreRoot = path.resolve(nodeModulesRoot, virtualStoreDir);
if (
  path.parse(workspaceRoot).root.toLowerCase() !== path.parse(virtualStoreRoot).root.toLowerCase()
) {
  throw new Error("Metro requires the workspace and pnpm virtual store on the same volume.");
}
let serverRoot = workspaceRoot;
while (path.relative(serverRoot, virtualStoreRoot).split(path.sep)[0] === "..") {
  serverRoot = path.dirname(serverRoot);
}
config.watchFolders = [
  ...new Set([...(config.watchFolders ?? []), workspaceRoot, virtualStoreRoot]),
];
const workspaceUrlPrefix = path.relative(serverRoot, workspaceRoot).split(path.sep).join("/");
if (workspaceUrlPrefix) {
  const rewriteRequestUrl = config.server.rewriteRequestUrl;
  const mobileUrlPrefix = `/${path.relative(workspaceRoot, __dirname).split(path.sep).join("/")}/`;
  // Lazy module URLs must not escape their root through browser-normalized .. segments.
  config.server = {
    ...config.server,
    unstable_serverRoot: serverRoot,
    rewriteRequestUrl(input) {
      const rewritten = rewriteRequestUrl(input);
      const url = new URL(rewritten, "http://metro.invalid");
      if (url.pathname.startsWith(mobileUrlPrefix)) {
        url.pathname = `/${workspaceUrlPrefix}${url.pathname}`;
      }
      return rewritten.startsWith("/") ? url.pathname + url.search + url.hash : url.href;
    },
  };
}
const resolveRequest = config.resolver.resolveRequest;
config.resolver = {
  ...config.resolver,
  resolveRequest(context, moduleName, platform) {
    // Expo exports resolve workspace-relative entries without the HTTP URL rewrite.
    const entry =
      workspaceUrlPrefix &&
      path.resolve(context.originModulePath) === serverRoot &&
      moduleName.startsWith("./apps/mobile/")
        ? path.resolve(workspaceRoot, moduleName)
        : moduleName;
    return (resolveRequest ?? context.resolveRequest)(context, entry, platform);
  },
  blockList: [
    ...(Array.isArray(config.resolver?.blockList)
      ? config.resolver.blockList
      : config.resolver?.blockList
        ? [config.resolver.blockList]
        : []),
    new RegExp(`${escapedWorkspaceRoot}[/\\\\]\\.t3[/\\\\].*`),
  ],
  extraNodeModules: {
    ...config.resolver?.extraNodeModules,
    "@t3tools/mobile-third-party-licenses": generatedLicenseModuleRoot,
    "@t3tools/mobile-device-stream": generatedDeviceStreamRoot,
    "@t3tools/mobile-preview-stream": generatedPreviewStreamRoot,
  },
};

async function writeFileIfChanged(filePath, contents) {
  try {
    if ((await fs.promises.readFile(filePath, "utf8")) === contents) return;
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  await fs.promises.writeFile(filePath, contents, "utf8");
}

async function generateMobileThirdPartyLicenses() {
  await fs.promises.mkdir(generatedLicenseModuleRoot, { recursive: true });
  const generatorVersion = (await fs.promises.stat(licenseGeneratorSource)).mtimeMs;
  const { generateThirdPartyLicenseManifest } = await import(
    `${pathToFileURL(licenseGeneratorSource).href}?version=${String(generatorVersion)}`
  );
  const manifest = await generateThirdPartyLicenseManifest({
    configFile: path.join(workspaceRoot, "third-party-licenses.config.json"),
    packageManifests: [{ bundle: "mobile", path: path.join(__dirname, "package.json") }],
  });

  await Promise.all([
    writeFileIfChanged(
      path.join(generatedLicenseModuleRoot, "index.js"),
      `module.exports = ${JSON.stringify(manifest)};\n`,
    ),
    writeFileIfChanged(
      path.join(generatedLicenseModuleRoot, "package.json"),
      '{"main":"index.js"}\n',
    ),
  ]);
}

async function prepareStreamScripts() {
  const { generateDeviceStreamScript, generatePreviewStreamScript } = await import(
    pathToFileURL(path.join(__dirname, "scripts", "generate-device-stream.mts")).href
  );
  const generateAll = () =>
    Promise.all([generateDeviceStreamScript(), generatePreviewStreamScript()]);
  await generateAll();
  if (process.env.NODE_ENV !== "production") {
    let rebuild = Promise.resolve();
    for (const [directory, files, generate] of [
      [
        "apps/mobile/src/features/devices",
        ["device-stream.browser.ts"],
        generateDeviceStreamScript,
      ],
      [
        "apps/mobile/src/features/browser",
        ["preview-stream.browser.ts"],
        generatePreviewStreamScript,
      ],
      ["packages/client-runtime/src/device", ["stream.ts", "hubAccess.ts"], generateAll],
      [
        "packages/client-runtime/src/preview",
        ["serverBrowserStream.ts"],
        generatePreviewStreamScript,
      ],
    ]) {
      fs.watch(path.join(workspaceRoot, directory), { persistent: false }, (_event, filename) => {
        if (filename && !files.includes(String(filename))) return;
        rebuild = rebuild
          .then(generate)
          .then(() => undefined)
          .catch((error) => {
            console.error("Could not rebuild a WebView stream script:", error);
          });
      });
    }
  }
}

module.exports = Promise.all([generateMobileThirdPartyLicenses(), prepareStreamScripts()]).then(
  () =>
    withUniwindConfig(config, {
      cssEntryFile: "./global.css",
      extraThemes,
      polyfills: { rem: 14 },
    }),
);
