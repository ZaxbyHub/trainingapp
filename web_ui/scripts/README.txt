╔══════════════════════════════════════════════════════════════╗
║         Document Q&A — Offline Edition                       ║
╠══════════════════════════════════════════════════════════════╣
║                                                              ║
║  HOW TO RUN                                                  ║
║  ──────────                                                  ║
║                                                              ║
║  Windows:  Double-click  start.bat                           ║
║  macOS:    Double-click  start.command                       ║
║  Linux:    Run  ./start.command                              ║
║                                                              ║
║  Your browser will open automatically to the app.            ║
║  No internet connection required.                            ║
║  No software to install — everything is included.            ║
║                                                              ║
║  ─────────────────────────────────────────────────────       ║
║                                                              ║
║  REQUIREMENTS                                                ║
║                                                              ║
║  • Windows 10+ (PowerShell is built in)                      ║
║    — or —                                                    ║
║  • macOS / Linux with Node.js installed                      ║
║    (For Windows: no installation needed at all.)             ║
║                                                              ║
║  • A modern browser (Chrome, Edge, or Firefox)               ║
║                                                              ║
║  ─────────────────────────────────────────────               ║
║                                                              ║
║  WHAT'S INSIDE                                               ║
║                                                              ║
║  • Full RAG document Q&A app (runs 100% in your browser)     ║
║  • Google Gemma 4 E2B-it — browser-local multimodal AI       ║
║  • BGE embedding model for document search                   ║
║  • ONNX Runtime + wllama (WASM inference, no GPU needed)     ║
║  • All documents stored locally in your browser              ║
║  • start.bat uses built-in PowerShell — nothing to install   ║
║                                                              ║
║  ─────────────────────────────────────────────               ║
║                                                              ║
║  TROUBLESHOOTING                                             ║
║                                                              ║
║  Q: "ExecutionPolicy" or script error on Windows             ║
║  A: start.bat passes -ExecutionPolicy Bypass automatically.  ║
║     If it still fails, right-click start.bat → Run as admin. ║
║                                                              ║
║  Q: The page opens but the model won't load                  ║
║  A: Make sure you extracted ALL files from the zip,          ║
║     including the dist/ folder (it's ~500 MB).               ║
║                                                              ║
║  Q: Port 8080 is already in use                              ║
║  A: Edit start.ps1 and change $Port = 8080 to another number.║
║                                                              ║
║  Q: To stop the server                                      ║
║  A: Close the terminal window, or press Ctrl+C.              ║
║                                                              ║
╚══════════════════════════════════════════════════════════════╝
