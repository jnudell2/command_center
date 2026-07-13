[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$appRoot = Split-Path -Parent $PSScriptRoot
$runtimeDir = Join-Path $appRoot '.runtime'
$stopped = @()

foreach ($name in @('app', 'runner')) {
    $pidPath = Join-Path $runtimeDir "$name.pid"
    if (-not (Test-Path -LiteralPath $pidPath)) { continue }
    $processId = 0
    if (-not [int]::TryParse((Get-Content -LiteralPath $pidPath -Raw).Trim(), [ref]$processId)) { continue }
    $process = Get-CimInstance Win32_Process -Filter "ProcessId = $processId" -ErrorAction SilentlyContinue
    if (-not $process) { continue }
    if ($process.CommandLine -notlike "*$appRoot*") {
        throw "Refusing to stop process $processId because it is outside the Serent Tend app."
    }
    Stop-Process -Id $processId
    $stopped += [ordered]@{ name = $name; id = $processId }
}

[ordered]@{ stopped = $stopped } | ConvertTo-Json -Depth 4

