'use strict';

/**
 * Copia sicura del risultato nella destinazione scelta dall'utente.
 *
 * Procedura:
 * 1. copia in un file temporaneo nella STESSA cartella di destinazione
 *    (così il rename finale è atomico, anche su dischi diversi da quello temp);
 * 2. verifica che la dimensione coincida con l'originale;
 * 3. rinomina sul nome definitivo;
 * 4. in caso di errore rimuove il temporaneo e traduce il codice di errore.
 *
 * La conferma di sovrascrittura avviene PRIMA, nel dialog nativo di salvataggio.
 */

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { AppError } = require('./errors');
const { isPlausibleAbsolutePath, ensureMp3Extension } = require('./validation');

function mapFsError(err) {
  switch (err && err.code) {
    case 'ENOSPC':
    case 'EDQUOT':
      return 'INSUFFICIENT_DISK_SPACE';
    case 'EACCES':
    case 'EPERM':
    case 'EROFS':
    case 'EISDIR':
    case 'EBUSY':
      return 'DESTINATION_NOT_WRITABLE';
    case 'ENOENT':
    case 'ENOTDIR':
    case 'ENODEV':
    case 'ENXIO':
    case 'EIO':
      return 'DESTINATION_UNAVAILABLE';
    default:
      return 'DESTINATION_NOT_WRITABLE';
  }
}

/**
 * @param {string} sourcePath MP3 temporaneo creato dal convertitore
 * @param {string} destinationPath percorso restituito dal dialog nativo
 * @returns {Promise<{ path: string, size: number }>}
 */
async function saveResultFile(sourcePath, destinationPath, fsImpl = fs.promises) {
  if (!isPlausibleAbsolutePath(destinationPath)) throw new AppError('DESTINATION_UNAVAILABLE', 'percorso non valido');
  const finalPath = ensureMp3Extension(path.normalize(destinationPath));
  const dir = path.dirname(finalPath);

  let sourceSize;
  try {
    sourceSize = (await fsImpl.stat(sourcePath)).size;
  } catch (err) {
    throw new AppError('JOB_NOT_COMPLETED', `sorgente mancante: ${err.code}`);
  }

  try {
    const dirStat = await fsImpl.stat(dir);
    if (!dirStat.isDirectory()) throw Object.assign(new Error('not dir'), { code: 'ENOTDIR' });
  } catch (err) {
    throw new AppError(mapFsError(err), `cartella: ${err.code}`);
  }

  const tempPath = path.join(dir, `.${path.basename(finalPath)}.${crypto.randomBytes(6).toString('hex')}.tmp`);
  try {
    await fsImpl.copyFile(sourcePath, tempPath, fs.constants.COPYFILE_EXCL);
    const copiedSize = (await fsImpl.stat(tempPath)).size;
    if (copiedSize !== sourceSize) throw new AppError('SAVE_VERIFICATION_FAILED', `${copiedSize} != ${sourceSize}`);
    await fsImpl.rename(tempPath, finalPath);
    const finalSize = (await fsImpl.stat(finalPath)).size;
    if (finalSize !== sourceSize) throw new AppError('SAVE_VERIFICATION_FAILED', 'dimensione finale diversa');
    return { path: finalPath, size: finalSize };
  } catch (err) {
    await fsImpl.rm(tempPath, { force: true }).catch(() => {});
    if (err instanceof AppError) throw err;
    throw new AppError(mapFsError(err), err.code);
  }
}

module.exports = { saveResultFile, mapFsError };
