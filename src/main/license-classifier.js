'use strict';

/**
 * Classificazione della licenza delle librerie FFmpeg incluse (tramite PyAV).
 *
 * Attenzione: FFmpeg dichiara la propria licenza in base ai flag --enable-gpl /
 * --enable-version3 / --enable-nonfree. Ma una build può essere collegata a
 * librerie esterne GPL (es. x264, x265) anche senza --enable-gpl: in quel caso
 * la combinazione distribuita va trattata come GPL, qualunque cosa dichiari
 * la stringa "license". Questo modulo considera ENTRAMBE le cose.
 *
 * Non è consulenza legale: produce un'indicazione da verificare (vedi
 * docs/LICENSE_COMPLIANCE.md).
 */

// Librerie esterne con licenza GPL (elenco non esaustivo, dai controlli di configure di FFmpeg).
const GPL_LIBRARIES = Object.freeze([
  'libx264', 'libx265', 'libxvid', 'librubberband', 'libvidstab', 'libzvbi', 'frei0r',
  'libcdio', 'libdavs2', 'libxavs', 'libxavs2', 'libopencore-amrnb', 'libopencore-amrwb', 'libvo-amrwbenc'
]);
// Librerie che rendono la build non ridistribuibile.
const NONFREE_LIBRARIES = Object.freeze(['libfdk-aac', 'libnpp', 'cuda-nvcc', 'libtls-nonfree']);

function enabledLibraries(configuration) {
  const libs = new Set();
  for (const flag of String(configuration || '').split(/\s+/)) {
    const m = /^--enable-([a-z0-9_-]+)$/i.exec(flag);
    if (m) libs.add(m[1].toLowerCase());
  }
  return libs;
}

/**
 * @param {string} configuration riga "configuration" di FFmpeg
 * @param {string} [declaredLicense] licenza dichiarata da libavcodec (es. "LGPL version 3 or later")
 */
function classifyLicense(configuration, declaredLicense = '') {
  const flags = enabledLibraries(configuration);
  const v3 = flags.has('version3');
  const gplLibs = GPL_LIBRARIES.filter((lib) => flags.has(lib));
  const nonfreeLibs = NONFREE_LIBRARIES.filter((lib) => flags.has(lib));

  if (flags.has('nonfree') || nonfreeLibs.length) {
    return {
      classification: 'NONFREE',
      distributable: false,
      declared: declaredLicense,
      gplLibraries: gplLibs,
      note: 'Build con componenti nonfree: NON ridistribuibile.'
    };
  }
  if (flags.has('gpl') || gplLibs.length) {
    const declaredMismatch = gplLibs.length && !flags.has('gpl')
      ? ` La licenza dichiarata ("${declaredLicense || 'n/d'}") non tiene conto delle librerie GPL incluse: ${gplLibs.join(', ')}.`
      : '';
    return {
      classification: v3 ? 'GPL-3.0-or-later' : 'GPL-2.0-or-later',
      distributable: true,
      declared: declaredLicense,
      gplLibraries: gplLibs,
      note: `Da trattare come GPL: la distribuzione comporta gli obblighi della GPL (sorgente corrispondente, testo della licenza).${declaredMismatch}`
    };
  }
  return {
    classification: v3 ? 'LGPL-3.0-or-later' : 'LGPL-2.1-or-later',
    distributable: true,
    declared: declaredLicense,
    gplLibraries: [],
    note: 'LGPL: verificare comunque le licenze delle librerie esterne incluse.'
  };
}

module.exports = { classifyLicense, GPL_LIBRARIES, NONFREE_LIBRARIES };
