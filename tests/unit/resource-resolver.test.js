'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const r = require('../../src/main/resource-resolver');

const ctx = (overrides = {}) => r.createRuntimeContext({
  isPackaged: false,
  appRoot: overrides.platform === 'win32' ? 'C:\\progetto' : '/progetto',
  resourcesPath: overrides.platform === 'win32' ? 'C:\\Programmi\\App\\resources' : '/opt/app/resources',
  platform: 'linux',
  arch: 'x64',
  env: {},
  ...overrides
});

test('chiave piattaforma: supportate e non supportate', () => {
  for (const key of r.SUPPORTED_PLATFORM_KEYS) {
    const [platform, arch] = key.split('-');
    assert.equal(r.getPlatformKey(platform, arch), key);
  }
  assert.throws(() => r.getPlatformKey('win32', 'ia32'), (err) => err.code === 'UNSUPPORTED_PLATFORM');
  assert.throws(() => r.getPlatformKey('freebsd', 'x64'), (err) => err.code === 'UNSUPPORTED_PLATFORM');
  assert.throws(() => ctx({ arch: 'riscv64' }), (err) => err.code === 'UNSUPPORTED_PLATFORM');
});

test('rilevamento sviluppo/produzione', () => {
  const dev = ctx({ isPackaged: false });
  assert.equal(dev.mode, 'development');
  assert.equal(dev.resourceRoot, '/progetto/resources');
  const prod = ctx({ isPackaged: true });
  assert.equal(prod.mode, 'production');
  assert.equal(prod.resourceRoot, '/opt/app/resources');
  assert.throws(() => r.createRuntimeContext({ isPackaged: true, appRoot: '/x' }));
  assert.ok(Object.isFrozen(prod));
});

test('resolveConverterExecutable: script in sviluppo, eseguibile compilato in produzione', () => {
  const never = () => false;
  const dev = r.resolveConverterExecutable(ctx(), { exists: never });
  assert.equal(dev.kind, 'script');
  assert.equal(dev.command, 'python3');
  assert.deepEqual(dev.args, ['-u', '-I', '/progetto/src/python/convert.py']);

  const devWin = r.resolveConverterExecutable(ctx({ platform: 'win32' }), { exists: never });
  assert.equal(devWin.command, 'python');

  const venv = r.resolveConverterExecutable(ctx(), { exists: (p) => p.endsWith(path.posix.join('.venv', 'bin', 'python3')) });
  assert.equal(venv.command, '/progetto/.venv/bin/python3');

  const custom = r.resolveConverterExecutable(ctx({ env: { VIDEO2MP3_PYTHON: '/opt/py/bin/python3.13' } }), { exists: never });
  assert.equal(custom.command, '/opt/py/bin/python3.13');

  const prodWin = r.resolveConverterExecutable(ctx({ platform: 'win32', isPackaged: true }));
  assert.deepEqual(prodWin, {
    kind: 'compiled',
    command: 'C:\\Programmi\\App\\resources\\python-converter\\win32-x64\\converter\\converter.exe',
    args: []
  });

  // Selezione per piattaforma e architettura
  const prodMacArm = r.resolveConverterExecutable(ctx({ platform: 'darwin', arch: 'arm64', isPackaged: true }));
  assert.equal(prodMacArm.command, '/opt/app/resources/python-converter/darwin-arm64/converter/converter');
  const prodLinuxArm = r.resolveConverterExecutable(ctx({ platform: 'linux', arch: 'arm64', isPackaged: true }));
  assert.equal(prodLinuxArm.command, '/opt/app/resources/python-converter/linux-arm64/converter/converter');

  const devBuilt = r.resolveConverterExecutable(ctx({ env: { VIDEO2MP3_USE_BUILT_CONVERTER: '1' } }));
  assert.equal(devBuilt.kind, 'compiled');
  assert.equal(devBuilt.command, '/progetto/resources/python-converter/linux-x64/converter/converter');
});

test('in produzione le variabili di sviluppo vengono ignorate', () => {
  const prod = r.resolveConverterExecutable(ctx({ isPackaged: true, env: { VIDEO2MP3_PYTHON: '/tmp/evil-python' } }));
  assert.equal(prod.kind, 'compiled');
  assert.ok(!prod.command.includes('evil'));
});

test('checkResources: eseguibile del convertitore mancante', () => {
  const status = r.checkResources(ctx({ isPackaged: true }), {
    statSync: () => { throw Object.assign(new Error('x'), { code: 'ENOENT' }); }
  });
  assert.equal(status.ready, false);
  assert.deepEqual(status.problems.map((p) => `${p.component}:${p.code}`), ['converter:CONVERTER_NOT_FOUND']);
});

test('checkResources: script Python mancante in sviluppo', () => {
  const status = r.checkResources(ctx(), { exists: () => false });
  assert.deepEqual(status.problems.map((p) => p.code), ['CONVERTER_NOT_FOUND']);
  const ok = r.checkResources(ctx(), { exists: () => true });
  assert.equal(ok.ready, true);
});

test('applyEngineCheck: PyAV assente, encoder assente, convertitore muto', () => {
  const base = { ready: true, problems: [], converter: {} };
  assert.equal(r.applyEngineCheck(base, { engine: { available: true, libmp3lame: true } }).ready, true);
  assert.equal(r.applyEngineCheck(base, { engine: { available: false } }).problems[0].code, 'MEDIA_ENGINE_MISSING');
  assert.equal(r.applyEngineCheck(base, { engine: { available: true, libmp3lame: false } }).problems[0].code, 'ENCODER_NOT_AVAILABLE');
  assert.equal(r.applyEngineCheck(base, null).problems[0].code, 'CONVERTER_NOT_FOUND');
});

test('checkExecutable: architettura errata e permessi mancanti', () => {
  const base = { statSync: () => ({ isFile: () => true }), accessSync: () => {} };
  const wrongArch = r.checkExecutable('/x/converter', { platform: 'linux', arch: 'arm64', notFoundCode: 'CONVERTER_NOT_FOUND' }, {
    ...base,
    inspectFile: () => ({ format: 'elf', platform: 'linux', archs: ['x64'] })
  });
  assert.equal(wrongArch.code, 'BINARY_WRONG_ARCH');

  const wrongOs = r.checkExecutable('/x/converter', { platform: 'linux', arch: 'x64', notFoundCode: 'CONVERTER_NOT_FOUND' }, {
    ...base,
    inspectFile: () => ({ format: 'pe', platform: 'win32', archs: ['x64'] })
  });
  assert.equal(wrongOs.code, 'BINARY_WRONG_ARCH');

  const noExec = r.checkExecutable('/x/converter', { platform: 'linux', arch: 'x64', notFoundCode: 'CONVERTER_NOT_FOUND' }, {
    statSync: () => ({ isFile: () => true }),
    accessSync: () => { throw Object.assign(new Error('EACCES'), { code: 'EACCES' }); },
    inspectFile: () => ({ platform: 'linux', archs: ['x64'] })
  });
  assert.equal(noExec.code, 'BINARY_NOT_EXECUTABLE');

  // Su Windows il permesso di esecuzione non esiste: accessSync non viene chiamato.
  const win = r.checkExecutable('C:\\x\\converter.exe', { platform: 'win32', arch: 'x64', notFoundCode: 'CONVERTER_NOT_FOUND' }, {
    statSync: () => ({ isFile: () => true }),
    accessSync: () => { throw new Error('non dovrebbe essere chiamato'); },
    inspectFile: () => ({ platform: 'win32', archs: ['x64'] })
  });
  assert.deepEqual(win, { ok: true });
});

test('checkExecutable su file reale: uno script di testo non è un binario valido', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'v2m-res-'));
  const file = path.join(dir, 'converter');
  fs.writeFileSync(file, '#!/bin/sh\necho finto\n'.padEnd(200, ' '), { mode: 0o755 });
  const res = r.checkExecutable(file, { platform: process.platform, arch: process.arch, notFoundCode: 'CONVERTER_NOT_FOUND' });
  assert.equal(res.code, 'BINARY_WRONG_ARCH');
  fs.rmSync(dir, { recursive: true, force: true });
});
