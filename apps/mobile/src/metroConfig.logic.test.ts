// @effect-diagnostics nodeBuiltinImport:off - verifies the config loaded by Metro.
import * as NodeModule from "node:module";
import * as NodePath from "node:path";
import { expect, it } from "vite-plus/test";

const mobileRoot = NodePath.resolve(__dirname, "..");
const requireFromMobile = NodeModule.createRequire(NodePath.join(mobileRoot, "package.json"));

it("keeps external lazy modules and the app entry reachable through Metro URLs", async () => {
  const config: {
    projectRoot: string;
    server: { unstable_serverRoot?: string; rewriteRequestUrl: (url: string) => string };
    resolver: {
      resolveRequest: (
        context: {
          originModulePath: string;
          resolveRequest: (context: unknown, moduleName: string) => string;
        },
        moduleName: string,
        platform: string,
      ) => string;
    };
  } = await requireFromMobile("./metro.config.js");
  const serverRoot = config.server.unstable_serverRoot ?? config.projectRoot;
  const lazyModule = requireFromMobile.resolve("expo-file-system");
  const lazyUrl = new URL(
    NodePath.relative(serverRoot, lazyModule).split(NodePath.sep).join("/") + ".bundle",
    "http://metro.test/",
  );
  expect(
    NodePath.resolve(
      serverRoot,
      "." + decodeURIComponent(lazyUrl.pathname).replace(/\.bundle$/, ""),
    ),
  ).toBe(lazyModule);
  const entry = new URL(
    config.server.rewriteRequestUrl("/apps/mobile/index.bundle?platform=android&lazy=true"),
    "http://metro.test",
  );
  expect(NodePath.resolve(serverRoot, "." + decodeURIComponent(entry.pathname))).toBe(
    NodePath.join(mobileRoot, "index.bundle"),
  );
  expect(entry.searchParams.get("lazy")).toBe("true");
  expect(config.server.rewriteRequestUrl("/_expo/loading")).toBe("/_expo/loading");
  const exportContext = {
    originModulePath: NodePath.join(serverRoot, "."),
    resolveRequest: (_context: unknown, moduleName: string) => moduleName,
  };
  expect(config.resolver.resolveRequest(exportContext, "./apps/mobile/index.ts", "android")).toBe(
    NodePath.join(mobileRoot, "index.ts"),
  );
});
