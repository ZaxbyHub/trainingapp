# bench/run_offline_matrix.ps1 — thin Windows launcher for run_offline_matrix.mjs
# (issue #86, workstream E3: offline and low-RAM validation matrix).
#
# The logic lives in the .mjs so the frozen acceptance checks can execute it
# hardware-free on any shell; this wrapper only locates node on PATH, forwards
# every argument verbatim, and exits with node's exit code.
#
# Fail-closed: no node on PATH -> named message on stderr + exit 2; a node run
# that produces no exit code at all also exits 2 (never a silent success).
#
# Usage (administrator PowerShell for the network scenarios; see
# bench/offline-validation-matrix.md for the full operator steps):
#   powershell -ExecutionPolicy Bypass -File bench\run_offline_matrix.ps1 --list
#   powershell -ExecutionPolicy Bypass -File bench\run_offline_matrix.ps1 --selftest
#   powershell -ExecutionPolicy Bypass -File bench\run_offline_matrix.ps1 --scenario S1 --prep --adapter "<name>" --confirm-network-toggle
#   powershell -ExecutionPolicy Bypass -File bench\run_offline_matrix.ps1 --recover
#
# PS 5.1 note (PR review round): $ErrorActionPreference stays at its default
# (Continue). 'Stop' aborts the script the moment node writes to stderr
# in-process — before $LASTEXITCODE is ever read — masking the harness's own
# refusal exit codes (2/3/4/5) as a generic 1.

$nodeCommand = Get-Command node -ErrorAction SilentlyContinue -CommandType Application
if (-not $nodeCommand) {
    [Console]::Error.WriteLine(
        'run_offline_matrix.ps1: node was not found on PATH - install Node.js (>= 18.2, the floor for the stdlib APIs the harness uses, e.g. server.closeAllConnections) before running the offline matrix harness'
    )
    exit 2
}

$script = Join-Path $PSScriptRoot 'run_offline_matrix.mjs'
if (-not (Test-Path $script)) {
    [Console]::Error.WriteLine("run_offline_matrix.ps1: harness script not found next to this launcher: $script")
    exit 2
}

& $nodeCommand.Source $script @args
if ($null -ne $LASTEXITCODE -and "$LASTEXITCODE" -ne '') {
    exit $LASTEXITCODE
}
exit 2
