$t3Environment = @{}
foreach ($name in @("PATH", "VP_HOME", "VP_VERSION", "VP_NODE_MANAGER", "VP_PM_MANAGER", "VP_SELF_SETUP_NO_MODIFY_PATH", "VP_SETUP_NODE_VERSION")) {
    $t3Environment[$name] = [Environment]::GetEnvironmentVariable($name)
}
$t3Tls = [Net.ServicePointManager]::SecurityProtocol
try {
    & (Join-Path $PSScriptRoot "scripts/project-vp.ps1") @args
    exit $LASTEXITCODE
} finally {
    foreach ($name in $t3Environment.Keys) {
        [Environment]::SetEnvironmentVariable($name, $t3Environment[$name])
    }
    [Net.ServicePointManager]::SecurityProtocol = $t3Tls
}
