<#
.SYNOPSIS
  Document Q&A — Offline Edition server (zero dependencies, PowerShell only).
.DESCRIPTION
  Serves the dist/ folder with cross-origin isolation headers required for
  SharedArrayBuffer (multi-threaded WASM inference). Runs entirely on the
  built-in PowerShell / .NET HttpListener — no Node.js, no Python, no npm,
  no internet. Works on any Windows machine with PowerShell (pre-installed
  on all modern Windows).

  Key design points:
  - HEAD requests return headers ONLY (no body) — the readiness gate probes
    model files with HEAD, and reading a 229 MB GGUF into memory for every
    probe would be catastrophically slow and error-prone.
  - Large files are streamed (chunked) rather than loaded into memory, so
    the 229 MB model GGUF doesn't OOM the server.
  - Range requests are supported so wllama/ONNX can byte-range fetch.
#>

$ErrorActionPreference = 'Stop'

# dist/ lives next to this script in the distribution package, or one level
# up (../dist) during development where the script is inside scripts/.
$DistDir = Join-Path $PSScriptRoot 'dist'
if (-not (Test-Path $DistDir)) {
    $DistDir = Join-Path $PSScriptRoot '..\dist'
    $DistDir = [System.IO.Path]::GetFullPath($DistDir)
}

if (-not (Test-Path $DistDir)) {
    Write-Host ''
    Write-Host '  ERROR: dist/ folder not found.' -ForegroundColor Red
    Write-Host '  Make sure you extracted ALL files from the zip.' -ForegroundColor Red
    Write-Host ''
    Read-Host '  Press Enter to exit'
    exit 1
}

$Port = 8080

# ---- MIME type map -----------------------------------------------------------
$MimeTypes = @{
    '.html' = 'text/html; charset=utf-8'
    '.htm'  = 'text/html; charset=utf-8'
    '.js'   = 'text/javascript; charset=utf-8'
    '.mjs'  = 'text/javascript; charset=utf-8'
    '.css'  = 'text/css; charset=utf-8'
    '.json' = 'application/json; charset=utf-8'
    '.wasm' = 'application/wasm'
    '.gguf' = 'application/octet-stream'
    '.onnx' = 'application/octet-stream'
    '.woff2' = 'font/woff2'
    '.woff'  = 'font/woff'
    '.ttf'   = 'font/ttf'
    '.png'  = 'image/png'
    '.jpg'  = 'image/jpeg'
    '.jpeg' = 'image/jpeg'
    '.gif'  = 'image/gif'
    '.svg'  = 'image/svg+xml'
    '.ico'  = 'image/x-icon'
    '.map'  = 'application/json; charset=utf-8'
    '.txt'  = 'text/plain; charset=utf-8'
}

# ---- Create the listener -----------------------------------------------------
$Listener = New-Object System.Net.HttpListener
$Listener.Prefixes.Add("http://127.0.0.1:${Port}/")

try {
    $Listener.Start()
} catch {
    Write-Host ''
    Write-Host "  ERROR: Cannot start the server on port ${Port}." -ForegroundColor Red
    Write-Host "  The port may be in use. Close other programs and try again," -ForegroundColor Red
    Write-Host "  or edit start.ps1 and change the port number." -ForegroundColor Red
    Write-Host ''
    Write-Host "  Details: $_" -ForegroundColor DarkGray
    Write-Host ''
    Read-Host '  Press Enter to exit'
    exit 1
}

$Url = "http://localhost:${Port}"
Write-Host ''
Write-Host '  ============================================' -ForegroundColor Cyan
Write-Host '     Document Q&A — Offline Edition' -ForegroundColor White
Write-Host '  ============================================' -ForegroundColor Cyan
Write-Host ''
Write-Host "  Opening your browser to: $Url" -ForegroundColor Green
Write-Host ''
Write-Host '  To stop the server: close this window or press Ctrl+C' -ForegroundColor DarkGray
Write-Host ''

# Auto-open browser
try {
    Start-Process $Url
} catch {
    # Non-fatal — URL is printed above.
}

# ---- Request loop ------------------------------------------------------------
while ($Listener.IsListening) {
    try {
        $Context = $Listener.GetContext()
    } catch [System.Net.HttpListenerException] {
        break
    }

    $Request  = $Context.Request
    $Response = $Context.Response

    try {
        $Path = [System.Uri]::UnescapeDataString($Request.Url.AbsolutePath)

        # Prevent path traversal — -match checks for substring, NOT -contains
        # (which is a scalar equality check and would miss embedded '..').
        if ($Path -match '\.\.') {
            $Response.StatusCode = 403
            $Response.Close()
            continue
        }

        # Map to file on disk and canonicalize.
        $FilePath = Join-Path $DistDir $Path.TrimStart('/\')
        $FilePath = $FilePath -replace '/', '\'
        # PRR-003: defense-in-depth canonical-path containment check, matching
        # the Node server's normalize+startsWith pattern. Prevents any traversal
        # gadget that the regex above might miss. Append a trailing separator to
        # the base so a sibling like "dist-evil" doesn't false-match "dist".
        $ResolvedPath = [System.IO.Path]::GetFullPath($FilePath)
        $DistDirRoot = if ($DistDir.EndsWith('\')) { $DistDir } else { "$DistDir\" }
        if (-not $ResolvedPath.StartsWith($DistDirRoot, [StringComparison]::OrdinalIgnoreCase)) {
            $Response.StatusCode = 403
            $Response.Close()
            continue
        }

        # Directory → index.html
        if ((Test-Path $ResolvedPath -PathType Container)) {
            $ResolvedPath = Join-Path $ResolvedPath 'index.html'
        }

        # SPA fallback: if file doesn't exist and has no extension, serve index.html.
        if (-not (Test-Path $ResolvedPath -PathType Leaf)) {
            $Ext = [System.IO.Path]::GetExtension($ResolvedPath)
            if ([string]::IsNullOrEmpty($Ext)) {
                $ResolvedPath = Join-Path $DistDir 'index.html'
            }
        }

        if (-not (Test-Path $ResolvedPath -PathType Leaf)) {
            $Response.StatusCode = 404
            $Bytes = [System.Text.Encoding]::UTF8.GetBytes('404 Not Found')
            $Response.ContentLength64 = $Bytes.Length
            $Response.OutputStream.Write($Bytes, 0, $Bytes.Length)
            $Response.Close()
            continue
        }

        # Determine content type.
        $Ext = [System.IO.Path]::GetExtension($ResolvedPath).ToLowerInvariant()
        $ContentType = if ($MimeTypes.ContainsKey($Ext)) { $MimeTypes[$Ext] } else { 'application/octet-stream' }

        # Cross-origin isolation headers — required for SharedArrayBuffer.
        $Response.Headers.Set('Cross-Origin-Opener-Policy', 'same-origin')
        $Response.Headers.Set('Cross-Origin-Embedder-Policy', 'require-corp')
        # CORP header is required under COEP require-corp: without it, the
        # browser blocks cross-origin subresource loads (ORT workers, WASM),
        # which breaks cross-origin isolation and SharedArrayBuffer.
        $Response.Headers.Set('Cross-Origin-Resource-Policy', 'same-origin')
        $Response.Headers.Set('Cache-Control', 'no-cache')
        $Response.ContentType = $ContentType

        $FileLen = (Get-Item $ResolvedPath).Length

        # ---- HEAD request: headers only, no body ----
        # The readiness gate AND wllama's download progress both read the
        # Content-Length from the HEAD response. We need to return the real
        # file size, but NOT send the body. HttpListener .NET HttpListenerResponse
        # suppresses the body for HEAD automatically when ContentLength64 is set
        # — the framework knows HEAD must not have a body. The earlier hang was
        # caused by a conflicting manual Content-Length header, not by setting
        # ContentLength64 itself. We set it to the real size here.
        if ($Request.HttpMethod -eq 'HEAD') {
            $Response.StatusCode = 200
            $Response.ContentLength64 = $FileLen
            $Response.Close()
            continue
        }

        # ---- GET request: stream the file ----
        # Use FileStream + chunked copy so the 229 MB model GGUF doesn't load
        # entirely into memory. Supports Range requests via the stream offset.
        $AcceptRanges = $Request.Headers['Range']
        $Fs = [System.IO.File]::Open($ResolvedPath, [System.IO.FileMode]::Open, [System.IO.FileAccess]::Read, [System.IO.FileShare]::ReadWrite)
        try {
            if ($AcceptRanges) {
                # Parse "bytes=start-end" (end optional).
                if ($AcceptRanges -match 'bytes=(\d+)-(\d*)') {
                    $Start = [int64]$Matches[1]
                    $End = if ($Matches[2]) { [int64]$Matches[2] } else { $FileLen - 1 }
                    if ($Start -lt $FileLen -and $End -lt $FileLen -and $Start -le $End) {
                        $Fs.Seek($Start, [System.IO.SeekOrigin]::Begin) | Out-Null
                        $BytesToWrite = $End - $Start + 1
                        $Response.StatusCode = 206
                        $Response.Headers.Set('Content-Range', "bytes $Start-$End/$FileLen")
                        $Response.ContentLength64 = $BytesToWrite
                        $Buffer = New-Object byte[] 65536
                        $Remaining = $BytesToWrite
                        while ($Remaining -gt 0) {
                            $ToRead = [Math]::Min($Remaining, $Buffer.Length)
                            $Read = $Fs.Read($Buffer, 0, $ToRead)
                            if ($Read -le 0) { break }
                            $Response.OutputStream.Write($Buffer, 0, $Read)
                            $Remaining -= $Read
                        }
                    } else {
                        $Response.StatusCode = 416
                    }
                } else {
                    $Response.StatusCode = 416
                }
            } else {
                # Full file — stream in chunks.
                $Response.StatusCode = 200
                $Response.ContentLength64 = $FileLen
                $Buffer = New-Object byte[] 65536
                while ($true) {
                    $Read = $Fs.Read($Buffer, 0, $Buffer.Length)
                    if ($Read -le 0) { break }
                    $Response.OutputStream.Write($Buffer, 0, $Read)
                }
            }
        } finally {
            $Fs.Close()
        }
        $Response.Close()
    } catch {
        try { $Response.StatusCode = 500; $Response.Close() } catch {}
    }
}

$Listener.Stop()
