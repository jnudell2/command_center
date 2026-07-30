[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$appRoot = Split-Path -Parent $PSScriptRoot
$runtimeDir = Join-Path $appRoot '.runtime'
New-Item -ItemType Directory -Path $runtimeDir -Force | Out-Null

function Test-RunnerEndpoint {
    try {
        $payload = Invoke-RestMethod -Uri 'http://127.0.0.1:4318/api/health' -TimeoutSec 2
        return $payload.status -eq 'ready' -and $payload.database -like "$appRoot*"
    }
    catch {
        return $false
    }
}

function Test-AppEndpoint {
    try {
        $response = Invoke-WebRequest -Uri 'http://localhost:3000/' -UseBasicParsing -TimeoutSec 2
        return $response.StatusCode -eq 200 -and $response.Content -match '<title>Serent Command Center</title>'
    }
    catch {
        return $false
    }
}

function Resolve-NodePath {
    function Test-SupportedNode {
        param([string]$Path)
        if (-not $Path -or -not (Test-Path -LiteralPath $Path)) { return $false }
        try {
            $version = & $Path -p "process.versions.node" 2>$null
            return [version]$version -ge [version]'22.13.0'
        }
        catch {
            return $false
        }
    }

    if (Test-SupportedNode $env:CODEX_NODE_PATH) {
        return $env:CODEX_NODE_PATH
    }

    $candidate = Get-ChildItem -Path (Join-Path $env:LOCALAPPDATA 'Microsoft\WinGet\Packages') -Recurse -Filter node.exe -ErrorAction SilentlyContinue |
        Where-Object { $_.FullName -like '*OpenJS.NodeJS.LTS*' } |
        Sort-Object LastWriteTime -Descending |
        Select-Object -First 1
    if ($candidate -and (Test-SupportedNode $candidate.FullName)) {
        return $candidate.FullName
    }

    $command = Get-Command node -ErrorAction SilentlyContinue
    if ($command -and (Test-SupportedNode $command.Source)) {
        return $command.Source
    }

    throw 'Node.js 22.13 or newer could not be located.'
}

$node = Resolve-NodePath
$processes = @()

if (-not (Test-RunnerEndpoint)) {
    $runnerOut = Join-Path $runtimeDir 'runner.stdout.log'
    $runnerErr = Join-Path $runtimeDir 'runner.stderr.log'
    $runner = Start-Process -FilePath $node `
        -ArgumentList (Join-Path $PSScriptRoot 'local-control-server.mjs') `
        -WorkingDirectory $appRoot `
        -WindowStyle Hidden `
        -RedirectStandardOutput $runnerOut `
        -RedirectStandardError $runnerErr `
        -PassThru
    $runner.Id | Set-Content -LiteralPath (Join-Path $runtimeDir 'runner.pid')
    $processes += [ordered]@{ name = 'runner'; id = $runner.Id; started = $true }
}
else {
    $processes += [ordered]@{ name = 'runner'; started = $false; status = 'already_ready' }
}

if (-not (Test-AppEndpoint)) {
    $vinextCli = Join-Path $appRoot 'node_modules\vinext\dist\cli.js'
    $serverOut = Join-Path $runtimeDir 'app.stdout.log'
    $serverErr = Join-Path $runtimeDir 'app.stderr.log'
    # The Codex in-app Browser blocks the production server's inline hydration
    # bootstrap. Vinext dev uses an external client bundle and keeps the local
    # app interactive, while the launcher prewarms it before opening.
    $server = Start-Process -FilePath $node `
        -ArgumentList @($vinextCli, 'dev') `
        -WorkingDirectory $appRoot `
        -WindowStyle Hidden `
        -RedirectStandardOutput $serverOut `
        -RedirectStandardError $serverErr `
        -PassThru
    $server.Id | Set-Content -LiteralPath (Join-Path $runtimeDir 'app.pid')
    $processes += [ordered]@{ name = 'app'; id = $server.Id; started = $true }
}
else {
    $processes += [ordered]@{ name = 'app'; started = $false; status = 'already_ready' }
}

$deadline = (Get-Date).AddSeconds(15)
do {
    $appReady = Test-AppEndpoint
    $runnerReady = Test-RunnerEndpoint
    if ($appReady -and $runnerReady) { break }
    Start-Sleep -Milliseconds 250
} while ((Get-Date) -lt $deadline)

[ordered]@{
    app_ready = $appReady
    runner_ready = $runnerReady
    app_mode = 'local_interactive'
    url = 'http://localhost:3000/'
    processes = $processes
} | ConvertTo-Json -Depth 5
