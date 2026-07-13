[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$appRoot = Split-Path -Parent $PSScriptRoot
$runtimeDir = Join-Path $appRoot '.runtime'
New-Item -ItemType Directory -Path $runtimeDir -Force | Out-Null

function Test-LocalEndpoint {
    param([string]$Uri)
    try {
        $response = Invoke-WebRequest -Uri $Uri -UseBasicParsing -TimeoutSec 2
        return $response.StatusCode -ge 200 -and $response.StatusCode -lt 500
    }
    catch {
        return $false
    }
}

function Resolve-NodePath {
    if ($env:CODEX_NODE_PATH -and (Test-Path -LiteralPath $env:CODEX_NODE_PATH)) {
        return $env:CODEX_NODE_PATH
    }
    $command = Get-Command node -ErrorAction SilentlyContinue
    if ($command) {
        return $command.Source
    }
    $candidate = Get-ChildItem -Path (Join-Path $env:LOCALAPPDATA 'Microsoft\WinGet\Packages') -Recurse -Filter node.exe -ErrorAction SilentlyContinue |
        Where-Object { $_.FullName -like '*OpenJS.NodeJS.LTS*' } |
        Sort-Object LastWriteTime -Descending |
        Select-Object -First 1
    if ($candidate) {
        return $candidate.FullName
    }
    throw 'Node.js could not be located.'
}

$node = Resolve-NodePath
$processes = @()

if (-not (Test-LocalEndpoint -Uri 'http://127.0.0.1:4318/api/health')) {
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

if (-not (Test-LocalEndpoint -Uri 'http://localhost:3000/')) {
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
    $appReady = Test-LocalEndpoint -Uri 'http://localhost:3000/'
    $runnerReady = Test-LocalEndpoint -Uri 'http://127.0.0.1:4318/api/health'
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
