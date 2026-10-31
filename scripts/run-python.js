'use strict';

/**
 * Avvia Python con gli argomenti indicati, scegliendo l'interprete in modo
 * coerente su tutti i sistemi (vedi findPython). Usato da `npm run test:python`.
 */

const { ROOT, findPython, run, fail } = require('./lib/common');

const python = findPython();
if (!python) fail('Python 3 non trovato. Installa Python 3.10+ oppure imposta VIDEO2MP3_PYTHON.');
process.exit(run(python, process.argv.slice(2), { cwd: ROOT }));
