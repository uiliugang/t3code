import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

const marketingDir = NodePath.dirname(NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)));
const repoRoot = NodePath.dirname(NodePath.dirname(marketingDir));
const publicDir = NodePath.join(marketingDir, "public");
NodeFS.mkdirSync(publicDir, { recursive: true });
NodeFS.copyFileSync(
  NodePath.join(repoRoot, "scripts", "install.sh"),
  NodePath.join(publicDir, "install.sh"),
);
// A previous build can have left this generated asset in the public directory.
NodeFS.rmSync(NodePath.join(publicDir, "install.ps1"), { force: true });
