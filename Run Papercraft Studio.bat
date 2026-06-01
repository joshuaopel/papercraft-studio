@echo off
setlocal
cd /d "%~dp0"

if not exist node_modules (
    echo Installing dependencies (first run only)...
    call npm install
    if errorlevel 1 (
        echo.
        echo npm install failed. Press any key to close.
        pause >nul
        exit /b 1
    )
)

if not exist ".env.local" (
    echo.
    echo No .env.local found. The app will start, but you'll need to paste
    echo your OpenAI key into the UI each session.
    echo To prefill it, create .env.local with:  VITE_OPENAI_API_KEY=sk-...
    echo.
)

start "Papercraft Studio (dev server)" cmd /k "npm run dev"
timeout /t 3 /nobreak >nul
start "" http://localhost:5173/

endlocal
