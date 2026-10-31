#!/usr/bin/env bash
# Build del convertitore Python su Linux (x64 o arm64 nativo).
#
# Uso:  bash scripts/build-python-linux.sh [--debug]
#
# Compatibilità glibc: l'eseguibile PyInstaller funziona solo su sistemi con
# una glibc uguale o PIÙ RECENTE di quella della macchina di build. Per la
# massima compatibilità compila sulla distribuzione più vecchia che vuoi
# supportare (es. Ubuntu 22.04 LTS). Vedi docs/BUILD_LINUX.md.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

PY="${VIDEO2MP3_PYTHON:-python3}"
if [ ! -x ".venv/bin/python3" ]; then
  echo "Creazione del virtual environment .venv (serve il pacchetto python3-venv)..."
  "$PY" -m venv .venv
fi

.venv/bin/python3 -m pip install --upgrade pip
.venv/bin/python3 -m pip install -r src/python/requirements-build.txt

echo "glibc: $(ldd --version 2>/dev/null | head -n1 || echo sconosciuta)"
export VIDEO2MP3_PYTHON="$ROOT/.venv/bin/python3"
node scripts/build-python.js "$@"
