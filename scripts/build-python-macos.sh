#!/usr/bin/env bash
# Build del convertitore Python su macOS.
#
# Uso:  bash scripts/build-python-macos.sh [--debug]
#
# Architettura: PyInstaller produce un eseguibile per l'architettura del
# Python che lo esegue. Per arm64 usa un Python arm64 nativo; per x64 usa
# un Python x86_64 (es. avviando il terminale sotto Rosetta: arch -x86_64 zsh)
# e un Node.js x64. Lo script verifica la coerenza e si ferma se non c'è.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

PY="${VIDEO2MP3_PYTHON:-python3}"
if [ ! -x ".venv/bin/python3" ]; then
  echo "Creazione del virtual environment .venv..."
  "$PY" -m venv .venv
fi

.venv/bin/python3 -m pip install --upgrade pip
.venv/bin/python3 -m pip install -r src/python/requirements-build.txt

echo "Architettura macchina: $(uname -m) / Python: $(.venv/bin/python3 -c 'import platform;print(platform.machine())') / Node: $(node -p process.arch)"

export VIDEO2MP3_PYTHON="$ROOT/.venv/bin/python3"
node scripts/build-python.js "$@"
