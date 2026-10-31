'use strict';

/**
 * Riconosce sistema operativo e architettura di un eseguibile leggendo
 * soltanto i primi byte dell'intestazione (nessuna esecuzione).
 *
 * Perché serve? Un binario per il sistema sbagliato (es. un convertitore Linux dentro
 * il pacchetto Windows, o x64 al posto di arm64) produce errori criptici
 * come "Exec format error" o "%1 non è un'applicazione Win32 valida".
 * Rilevarlo prima permette un messaggio chiaro e un controllo in fase di build.
 *
 * Formati:
 * - PE (Windows): "MZ", poi a offset 0x3C la posizione dell'header "PE\0\0";
 *   il campo Machine indica l'architettura.
 * - ELF (Linux): 0x7F "ELF"; il campo e_machine indica l'architettura.
 * - Mach-O (macOS): magic 0xFEEDFACF; cputype indica l'architettura.
 *   I "fat/universal binary" (0xCAFEBABE) contengono più architetture.
 */

const fs = require('node:fs');

const PE_MACHINES = { 0x8664: 'x64', 0xaa64: 'arm64', 0x014c: 'ia32' };
const ELF_MACHINES = { 0x3e: 'x64', 0xb7: 'arm64', 0x03: 'ia32' };
const MACHO_CPU = { 0x01000007: 'x64', 0x0100000c: 'arm64', 0x00000007: 'ia32' };

function inspectBuffer(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 64) return { format: 'unknown', platform: null, archs: [] };

  // PE / Windows
  if (buf[0] === 0x4d && buf[1] === 0x5a) {
    const peOffset = buf.readUInt32LE(0x3c);
    if (peOffset + 6 <= buf.length && buf.readUInt32BE(peOffset) === 0x50450000) {
      const arch = PE_MACHINES[buf.readUInt16LE(peOffset + 4)];
      return { format: 'pe', platform: 'win32', archs: arch ? [arch] : [] };
    }
    return { format: 'pe', platform: 'win32', archs: [] };
  }

  // ELF / Linux
  if (buf[0] === 0x7f && buf[1] === 0x45 && buf[2] === 0x4c && buf[3] === 0x46) {
    const littleEndian = buf[5] === 1;
    const machine = littleEndian ? buf.readUInt16LE(0x12) : buf.readUInt16BE(0x12);
    const arch = ELF_MACHINES[machine];
    return { format: 'elf', platform: 'linux', archs: arch ? [arch] : [] };
  }

  // Mach-O 64 bit little endian (CF FA ED FE)
  const magicLE = buf.readUInt32LE(0);
  if (magicLE === 0xfeedfacf || magicLE === 0xfeedface) {
    const arch = MACHO_CPU[buf.readUInt32LE(4)];
    return { format: 'macho', platform: 'darwin', archs: arch ? [arch] : [] };
  }

  // Mach-O universal (big endian)
  if (buf.readUInt32BE(0) === 0xcafebabe) {
    const count = buf.readUInt32BE(4);
    // 0xCAFEBABE è anche il magic delle classi Java: un fat binary ha pochi slice.
    if (count > 0 && count < 10) {
      const archs = [];
      for (let i = 0; i < count; i += 1) {
        const offset = 8 + i * 20;
        if (offset + 4 > buf.length) break;
        const arch = MACHO_CPU[buf.readUInt32BE(offset)];
        if (arch) archs.push(arch);
      }
      return { format: 'macho-universal', platform: 'darwin', archs };
    }
  }

  return { format: 'unknown', platform: null, archs: [] };
}

function inspectFile(filePath) {
  const fd = fs.openSync(filePath, 'r');
  try {
    const buf = Buffer.alloc(4096);
    const read = fs.readSync(fd, buf, 0, buf.length, 0);
    return inspectBuffer(buf.subarray(0, read));
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * Verifica che un binario sia compatibile con piattaforma/architettura attese.
 * Un binario "universal" macOS è compatibile se contiene l'architettura richiesta.
 */
function isCompatible(info, platform, arch) {
  return info.platform === platform && info.archs.includes(arch);
}

module.exports = { inspectBuffer, inspectFile, isCompatible };
