# -*- mode: python ; coding: utf-8 -*-
#
# Configurazione PyInstaller per il convertitore.
#
# Modalità: ONEDIR (una cartella con l'eseguibile e la cartella _internal).
# Motivi (vedi docs/PACKAGING.md):
#   - avvio più rapido: nessuna estrazione in una cartella temporanea;
#   - struttura ispezionabile, quindi più facile da diagnosticare;
#   - meno falsi positivi degli antivirus rispetto a onefile.
#
# Variabili d'ambiente lette da questo file (impostate da scripts/build-python.js):
#   CONVERTER_DEBUG=1     build di debug: bootloader verboso, nessuna ottimizzazione
#   CONVERTER_ONEFILE=1   produce un unico eseguibile (opzione sperimentale)
#
# Console su Windows: l'eseguibile resta un'applicazione "console" perché così
# stdin/stdout/stderr funzionano in modo affidabile con le pipe di Node.js.
# La finestra NON compare perché Electron avvia il processo con windowsHide: true.
# Per vederla durante il debug: VIDEO2MP3_SHOW_CONVERTER_CONSOLE=1 (vedi docs).

import os

debug_build = os.environ.get("CONVERTER_DEBUG") == "1"
onefile = os.environ.get("CONVERTER_ONEFILE") == "1"

block_cipher = None

a = Analysis(
    [os.path.join(SPECPATH, "convert.py")],
    pathex=[SPECPATH],
    binaries=[],
    datas=[],
    hiddenimports=[],
    hookspath=[],
    runtime_hooks=[],
    # Moduli della libreria standard sicuramente inutili: riducono la dimensione.
    excludes=["tkinter", "unittest", "pydoc", "test", "lib2to3", "idlelib", "turtle"],
    noarchive=False,
    optimize=0 if debug_build else 1,
)

pyz = PYZ(a.pure)

if onefile:
    exe = EXE(
        pyz,
        a.scripts,
        a.binaries,
        a.datas,
        [],
        name="converter",
        debug=debug_build,
        strip=False,
        upx=False,
        console=True,
        runtime_tmpdir=None,
    )
else:
    exe = EXE(
        pyz,
        a.scripts,
        [],
        exclude_binaries=True,
        name="converter",
        debug=debug_build,
        strip=False,
        # UPX disabilitato: comprime poco e aumenta i falsi positivi antivirus.
        upx=False,
        console=True,
    )
    coll = COLLECT(
        exe,
        a.binaries,
        a.datas,
        strip=False,
        upx=False,
        name="converter",
    )
