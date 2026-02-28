@echo off
REM ========================================
REM Document Q&A Assistant - API Server
REM ========================================

cd /d "%~dp0"

REM Configuration - Edit these as needed
set RAG_OLLAMA_MODEL=phi3:mini
set RAG_OLLAMA_URL=http://localhost:11434
set API_PORT=8080

REM Uncomment to use OpenVINO model instead of Ollama
REM set RAG_MODEL_PATH=C:\AImodels\Phi-3.5-mini-instruct-int4-cw-ov

REM Uncomment to use remote NPU server
REM set RAG_API_URL=http://192.168.1.122:8000/v1

echo ========================================
echo Document Q&A API Server
echo ========================================
echo.
echo Configuration:
echo   Ollama URL: %RAG_OLLAMA_URL%
echo   Ollama Model: %RAG_OLLAMA_MODEL%
echo   API Port: %API_PORT%
echo.
echo Starting server...
echo API will be available at: http://localhost:%API_PORT%
echo.

python main.py --api --port %API_PORT%

pause
