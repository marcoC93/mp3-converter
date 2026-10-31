# Build del convertitore Python su Windows (x64 o ARM64 nativo).
#
# Uso (PowerShell, dalla radice del progetto):
#   powershell -ExecutionPolicy Bypass -File scripts\build-python-windows.ps1
#   powershell -ExecutionPolicy Bypass -File scripts\build-python-windows.ps1 -DebugBuild
#
# Cosa fa:
#   1. crea .venv se non esiste (con il Python indicato da $env:VIDEO2MP3_PYTHON o "py -3");
#   2. installa le dipendenze di build fissate in src/python/requirements-build.txt;
#   3. lancia scripts/build-python.js, che compila e verifica l'eseguibile.

param([switch]$DebugBuild)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

$venvPython = Join-Path $root '.venv\Scripts\python.exe'
if (-not (Test-Path $venvPython)) {
    Write-Host 'Creazione del virtual environment .venv...'
    if ($env:VIDEO2MP3_PYTHON) { & $env:VIDEO2MP3_PYTHON -m venv .venv }
    elseif (Get-Command py -ErrorAction SilentlyContinue) { & py -3 -m venv .venv }
    else { & python -m venv .venv }
    if (-not (Test-Path $venvPython)) { throw 'Creazione del venv non riuscita.' }
}

& $venvPython -m pip install --upgrade pip | Out-Host
& $venvPython -m pip install -r src\python\requirements-build.txt | Out-Host
if ($LASTEXITCODE -ne 0) { throw 'Installazione delle dipendenze di build non riuscita.' }

$env:VIDEO2MP3_PYTHON = $venvPython
if ($DebugBuild) { node scripts\build-python.js --debug } else { node scripts\build-python.js }
exit $LASTEXITCODE
