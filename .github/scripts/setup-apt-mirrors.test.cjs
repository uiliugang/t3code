const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const { test } = require("node:test");

const actionPath = join(__dirname, "../actions/setup-apt-mirrors/action.yml");
const ciWorkflowPath = join(__dirname, "../workflows/ci.yml");

function extractActionScript() {
  const action = readFileSync(actionPath, "utf8");
  const match = action.match(/run: \|\n((?:        .*\n|\n)+)/);
  assert.ok(match, "Could not find run script in setup-apt-mirrors/action.yml");
  return match[1].replace(/^        /gm, "");
}

test("setup-apt-mirrors rewrites both direct Ubuntu URLs and GitHub-hosted mirror+file sources", () => {
  const tempRoot = mkdtempSync(join(tmpdir(), "t3-apt-mirrors-test-"));
  const etcApt = join(tempRoot, "etc/apt");
  mkdirSync(join(etcApt, "sources.list.d"), { recursive: true });
  mkdirSync(join(etcApt, "apt.conf.d"), { recursive: true });

  //GitHub-hosted ubuntu-24.04 runner layout: ubuntu.sources points at <etcApt>/apt-mirrors.txt.
  writeFileSync(
    join(etcApt, "apt-mirrors.txt"),
    "http://us-east-1.ec2.archive.ubuntu.com/ubuntu/\tpriority:1\nhttp://archive.ubuntu.com/ubuntu/\tpriority:2\n",
  );
  writeFileSync(
    join(etcApt, "sources.list.d/ubuntu.sources"),
    `Types: deb\nURIs: mirror+file:${etcApt}/apt-mirrors.txt\nSuites: noble noble-updates noble-security\n`,
  );
  writeFileSync(
    join(etcApt, "sources.list.d/direct.list"),
    "deb http://security.ubuntu.com/ubuntu/ noble-security main\n",
  );

  // Redirect `/etc/apt` in the action script to our temporary directory and provide a PATH shim
  // for `sudo` and GNU-compatible `sed -i` so `find -exec` invokes it on both Linux and macOS.
  const binDir = join(tempRoot, "bin");
  mkdirSync(binDir, { recursive: true });
  writeFileSync(join(binDir, "sudo"), '#!/usr/bin/env bash\nexec "$@"\n', { mode: 0o755 });
  writeFileSync(
    join(binDir, "sed"),
    `#!/usr/bin/env bash
set -eu
if [ "\${1:-}" = "-i" ]; then
  shift
  args=()
  while [ "$#" -gt 0 ]; do
    case "$1" in
      -E|-e) args+=("$1"); shift ;;
      *) break ;;
    esac
  done
  expr="$1"; shift
  for file in "$@"; do
    tmp="$file.tmp.$$"
    /usr/bin/sed "\${args[@]}" "$expr" "$file" > "$tmp" && mv "$tmp" "$file"
  done
else
  exec /usr/bin/sed "$@"
fi
`,
    { mode: 0o755 },
  );
  const rawScript = extractActionScript().replaceAll("/etc/apt", etcApt);

  try {
    const result = spawnSync("bash", ["-e", "-o", "pipefail", "-c", rawScript], {
      encoding: "utf8",
      env: { ...process.env, PATH: `${binDir}:${process.env.PATH}` },
    });
    assert.equal(result.status, 0, result.stderr);

    const ubuntuSources = readFileSync(join(etcApt, "sources.list.d/ubuntu.sources"), "utf8");
    const directList = readFileSync(join(etcApt, "sources.list.d/direct.list"), "utf8");
    const mirrors = readFileSync(join(etcApt, "t3-ubuntu-mirrors.txt"), "utf8");
    const timeouts = readFileSync(join(etcApt, "apt.conf.d/80-mirror-timeouts"), "utf8");

    assert.match(ubuntuSources, /URIs: mirror\+file:.*\/t3-ubuntu-mirrors\.txt/);
    assert.doesNotMatch(ubuntuSources, /\/apt-mirrors\.txt/);
    assert.match(directList, /deb mirror\+file:.*\/t3-ubuntu-mirrors\.txt noble-security main/);
    assert.match(mirrors, /^https:\/\/archive\.ubuntu\.com\/ubuntu\tpriority:1$/m);
    assert.match(timeouts, /Acquire::http::Timeout "15";/);
    assert.match(timeouts, /Acquire::https::Timeout "15";/);
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("ci.yml Finish installing browser secret helper steps dump partial apt.log when timed out", () => {
  const ci = readFileSync(ciWorkflowPath, "utf8");
  const blocks = [
    ...ci.matchAll(
      /- name: Finish installing browser secret helper build libraries\n([\s\S]*?)(?=\n      - |\n  [a-z_]+:)/g,
    ),
  ];
  assert.equal(
    blocks.length,
    2,
    "Expected 2 Finish installing browser secret helper steps in ci.yml",
  );
  for (const [, block] of blocks) {
    assert.doesNotMatch(
      block,
      /until test -s "\$RUNNER_TEMP\/apt-status"; do sleep 1; done/,
      "Waiting step must enforce its own deadline and print apt.log before GitHub kills the step silent",
    );
    assert.match(block, /cat "\$RUNNER_TEMP\/apt\.log"/);
  }
});
