$t3Arguments = $args
$ErrorActionPreference = "Stop"
$PSNativeCommandUseErrorActionPreference = $false

$manifest = Get-Content -LiteralPath (Join-Path $PSScriptRoot "../package.json") -Raw | ConvertFrom-Json
$nodeVersion = $manifest.engines.node
if ($nodeVersion -notmatch '^\d+\.\d+\.\d+$') {
    throw "Project package.json must specify an exact engines.node version."
}

$launcher = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot "../vp.cmd"))
$vp = $null
foreach ($candidate in (Get-Command vp -All -CommandType Application -ErrorAction SilentlyContinue)) {
    if ($candidate.Source -eq $launcher) { continue }
    $projectLauncher = Join-Path (Split-Path -Parent $candidate.Source) "scripts/project-vp.ps1"
    if (Test-Path -LiteralPath $projectLauncher) { continue }
    try {
        & $candidate.Source env current --json 2>$null | Out-Null
        if ($LASTEXITCODE -eq 0) { $vp = $candidate.Source; break }
    } catch { continue }
}
if (-not $vp) {
    if (-not $env:VP_HOME) {
        $env:VP_HOME = Join-Path $env:LOCALAPPDATA "t3code/vite-plus"
    }
    $vp = Join-Path $env:VP_HOME "bin/vp.exe"
    if (-not (Test-Path -LiteralPath $vp)) {
        [Console]::Error.WriteLine("Installing Vite+ for this project...")
        $installer = Join-Path ([IO.Path]::GetTempPath()) ("t3-vite-plus-" + [guid]::NewGuid().ToString() + ".ps1")
        try {
            [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
            Invoke-WebRequest -UseBasicParsing -Uri "https://vite.plus/ps1" -OutFile $installer
            $catalog = Get-Content -LiteralPath (Join-Path $PSScriptRoot "../pnpm-workspace.yaml") -Raw
            if ($catalog -notmatch '(?m)^  vite-plus: ([0-9]+\.[0-9]+\.[0-9]+)\r?$') { throw "Missing Vite+ catalog version." }
            $env:VP_VERSION = $Matches[1]
            $env:VP_NODE_MANAGER = "no"
            $env:VP_PM_MANAGER = "no"
            $env:VP_SELF_SETUP_NO_MODIFY_PATH = "1"
            $env:VP_SETUP_NODE_VERSION = $nodeVersion
            & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $installer
            if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
        } finally {
            Remove-Item -LiteralPath $installer -ErrorAction SilentlyContinue
        }
    }
}

$env:PATH = (Split-Path -Parent $vp) + [IO.Path]::PathSeparator + $env:PATH
& $vp env install "node@$nodeVersion" | ForEach-Object { [Console]::Error.WriteLine($_) }
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
# Windows PowerShell 5.1 drops empty arguments and embedded quotes in native splatting.
$nativeArguments = @("env", "exec", "--node", $nodeVersion, $vp) + $t3Arguments
$encodedArguments = foreach ($argument in $nativeArguments) {
    $escaped = [regex]::Replace([string]$argument, '(\\*)"', '$1$1\"')
    '"' + [regex]::Replace($escaped, '(\\+)$', '$1$1') + '"'
}
$PSNativeCommandArgumentPassing = "Legacy"
if ($MyInvocation.ExpectingInput) {
    $input | & $vp @encodedArguments
} else {
    & $vp @encodedArguments
}
exit $LASTEXITCODE
