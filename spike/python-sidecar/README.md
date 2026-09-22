# spike/python-sidecar — issue #57 slice 2 (THROWAWAY)

Electron-hosted Python sidecar: PyInstaller onedir of the existing post-#51
`api_server.py`, spawned by a minimal Electron shell that proxies
`/health` + `/ask/stream` over loopback (SSE frames pass through; client abort
destroys the upstream socket, which is what cancels generation). Includes the
two-legged reranker packaging-risk probe (`probe_reranker.py`: leg A as-built
empty-cache load, leg B staged-model load). **Deleted in the fast-follow commit
after ADR-0003 merges.**

Build sequence (venv from repo pins):
1. `python -m venv .venv-sidecar && .venv-sidecar/Scripts/pip install -r requirements-sidecar.txt`
2. `.venv-sidecar/Scripts/python stage_reranker.py` (stages `staged_reranker/`)
3. `.venv-sidecar/Scripts/pyinstaller api_server_sidecar.spec --noconfirm --distpath shell/sidecar`
4. `.venv-sidecar/Scripts/pyinstaller probe_reranker.spec --noconfirm --distpath shell/probe`
5. `cd shell && npm ci && npm run build` → NSIS installer in `spike-release/`.
