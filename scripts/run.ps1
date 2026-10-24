# Start the ARIA API and UI from the local .venv (Windows). Ctrl+C stops the UI; the API window is closed on exit.
$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
$py = Join-Path $root ".venv\python.exe"
if (-not (Test-Path $py)) { $py = Join-Path $root ".venv\Scripts\python.exe" }
if (-not $env:ARIA_HOST) { $env:ARIA_HOST = "127.0.0.1" }
if (-not $env:ARIA_PORT) { $env:ARIA_PORT = "8000" }
$env:ARIA_API_URL = "http://$($env:ARIA_HOST):$($env:ARIA_PORT)"

$api = Start-Process -FilePath $py -WorkingDirectory $root -PassThru -NoNewWindow `
    -ArgumentList "-m", "uvicorn", "api.main:app", "--host", $env:ARIA_HOST, "--port", $env:ARIA_PORT
try {
    & $py -m streamlit run (Join-Path $root "ui\app.py") --server.address 127.0.0.1 --server.port 8501 --browser.gatherUsageStats false
} finally {
    if (-not $api.HasExited) { Stop-Process -Id $api.Id -Force }
}
