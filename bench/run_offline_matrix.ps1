# bench/run_offline_matrix.ps1 — thin Windows launcher for run_offline_matrix.mjs
# (issue #86, workstream E3: offline and low-RAM validation matrix).
#
# The logic lives in the .mjs so the frozen acceptance checks can execute it
# hardware-free on any shell; this wrapper only locates node on PATH, forwards
# every argument verbatim, and exits with node's exit code.
#
# Fail-closed: no node on PATH -> named message on stderr + exit 2.
#
# Usage (administrator PowerShell for the network scenarios; see
# bench/offline-validation-matrix.md for the full operator steps):
#   powershell -ExecutionPolicy Bypass -File bench\run_offline_matrix.ps1 --list
#   powershell -ExecutionPolicy Bypass -File bench\run_offline_matrix.ps1 --selftest
#   powershell -ExecutionPolicy Bypass -File bench\run_offline_matrix.ps1 --scenario S1 --prep --adapter "<name>" --confirm-network-toggle
#   powershell -ExecutionPolicy Bypass -File bench\run_offline_matrix.ps1 --recover
$ErrorActionPreference = 'Stop'

$nodeCommand = Get-Command node -ErrorAction SilentlyContinue
if (-not $nodeCommand) {
    [Console]::Error.WriteLine(
        'run_offline_matrix.ps1: node was not found on PATH - install Node.js (>= 22.5) before running the offline matrix harness'
    )
    exit 2
}

$script = Join-Path $PSScriptRoot 'run_offline_matrix.mjs'
if (-not (Test-Path $script)) {
    [Console]::Error.WriteLine("run_offline_matrix.ps1: harness script not found next to this launcher: $script")
    exit 2
}

& $nodeCommand.Source $script @args
exit $LASTEXITCODE
