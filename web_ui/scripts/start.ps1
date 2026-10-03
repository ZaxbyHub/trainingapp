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
    model files with HEAD, and reading a ~2.6 GB GGUF into memory for every
    probe would be catastrophically slow and error-prone.
  - Large files are streamed (chunked) rather than loaded into memory, so
    the ~2.6 GB model GGUF doesn't OOM the server.
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

# ---- Player-origin framing policy (final-critic FC6) -------------------------
# Untrusted course JS on the player origin can script any same-origin document
# it frames, so framing is denied by default: EVERY response gets
# frame-ancestors 'none' + X-Frame-Options: DENY (set right after the request
# is taken, before any branch, so the 403/404/416/500 answers carry them too).
# /training-boot.html is the single exception: it gets this restrictive HEADER
# CSP (no fetch, no form, no subresource; scripts and workers pinned to the
# exact URLs of its own script and the course worker), and only the app
# origin, the loopback alias of the Host the request was sent to, may frame
# it. Any other Host gets 'none' for all three (fail closed). Mirrors
# web_ui/vite.config.ts bootPageCsp.
function Get-BootPageCsp([string]$HostHeader) {
    $Script = "'none'"
    $Worker = "'none'"
    $Ancestor = "'none'"
    if ($HostHeader -match '^(localhost|127\.0\.0\.1)(:\d{1,5})?$') {
        $Name = $Matches[1].ToLowerInvariant()
        $Alias = if ($Name -eq 'localhost') { '127.0.0.1' } else { 'localhost' }
        $Script = "http://$Name$($Matches[2])/training-boot.js"
        $Worker = "http://$Name$($Matches[2])/training/sw.js"
        $Ancestor = "http://$Alias$($Matches[2])"
    }
    return "default-src 'none'; script-src $Script; worker-src $Worker; connect-src 'none'; base-uri 'none'; form-action 'none'; object-src 'none'; frame-ancestors $Ancestor"
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
    # Framing denied by default (FC6); only the boot page overrides it below.
    $Response.Headers.Set('Content-Security-Policy', "frame-ancestors 'none'")
    $Response.Headers.Set('X-Frame-Options', 'DENY')

    try {
        $Path = [System.Uri]::UnescapeDataString($Request.Url.AbsolutePath)

        # Prevent path traversal — -match checks for substring, NOT -contains
        # (which is a scalar equality check and would miss embedded '..').
        if ($Path -match '\.\.') {
            $Response.StatusCode = 403
            $Response.Close()
            continue
        }

        # Player-origin routes (browser-training-parity, ADR-0012): this server
        # also answers as the course PLAYER origin (http://localhost:PORT is the
        # app, its loopback alias http://127.0.0.1:PORT the player, or the
        # reverse). The boot frame files get CORP cross-origin (below); the
        # course service worker is served at /training/sw.js; every other
        # /training/* path is 404, never the SPA shell (course paths are served
        # by that worker only). Mirrors web_ui/vite.config.ts.
        $RawPath = $Request.Url.AbsolutePath
        $IsTrainingBoot = ($RawPath -ceq '/training-boot.html' -or $RawPath -ceq '/training-boot.js')
        $IsTrainingWorker = ($RawPath -ceq '/training/sw.js')
        if ($RawPath -ceq '/training-boot.html') {
            $Response.Headers.Remove('X-Frame-Options')
            $Response.Headers.Set('Content-Security-Policy', (Get-BootPageCsp $Request.Headers['Host']))
        }
        if (($RawPath -ceq '/training' -or $RawPath.StartsWith('/training/', [StringComparison]::Ordinal)) -and -not $IsTrainingWorker) {
            $Response.StatusCode = 404
            $Response.Headers.Set('Cross-Origin-Opener-Policy', 'same-origin')
            $Response.Headers.Set('Cross-Origin-Embedder-Policy', 'require-corp')
            $Response.Headers.Set('Cross-Origin-Resource-Policy', 'same-origin')
            $Response.Headers.Set('X-Content-Type-Options', 'nosniff')
            $Response.ContentType = 'text/plain; charset=utf-8'
            $Bytes = [System.Text.Encoding]::UTF8.GetBytes('404 Not Found')
            $Response.ContentLength64 = $Bytes.Length
            # HEAD gets the headers only: writing a body throws and the catch
            # below turns the answer into a 500.
            if ($Request.HttpMethod -ne 'HEAD') {
                $Response.OutputStream.Write($Bytes, 0, $Bytes.Length)
            }
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
        if ($IsTrainingBoot) {
            # The boot frame is embedded cross-origin by the COEP require-corp app page.
            $Response.Headers.Set('Cross-Origin-Resource-Policy', 'cross-origin')
            $Response.Headers.Set('X-Content-Type-Options', 'nosniff')
        } elseif ($IsTrainingWorker) {
            $Response.Headers.Set('X-Content-Type-Options', 'nosniff')
        }
        # Every other response keeps the deny-by-default framing headers set
        # when the request was taken (the app shell is never frameable).
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
        # Use FileStream + chunked copy so the ~2.6 GB model GGUF doesn't load
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
