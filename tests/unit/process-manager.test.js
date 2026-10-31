'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { ConverterProcess, parseEventLine, validateEvent, MAX_LINE_LENGTH } = require('../../src/main/process-manager');

const silentLogger = () => {
  const warnings = [];
  return { warnings, debug() {}, info() {}, warn: (m) => warnings.push(m), error() {} };
};

test('JSON Lines: eventi validi', () => {
  assert.deepEqual(parseEventLine('{"type":"status","status":"analyzing","message":"Analisi del file"}'), {
    ok: true,
    event: { type: 'status', status: 'analyzing', message: 'Analisi del file' }
  });
  assert.deepEqual(parseEventLine('{"type":"progress","progress":42.5,"processedSeconds":51.2}').event, {
    type: 'progress', progress: 42.5, processedSeconds: 51.2
  });
  assert.equal(parseEventLine('{"type":"progress","progress":null,"processedSeconds":3}').ok, true);
  assert.equal(parseEventLine('{"type":"completed","outputPath":"/tmp/x.mp3"}').ok, true);
  assert.equal(parseEventLine('{"type":"error","code":"NO_AUDIO_STREAM","message":"Il file non contiene una traccia audio"}').ok, true);
  assert.equal(parseEventLine('  {"type":"cancelled"}  \r').ok, true);
});

test('JSON Lines: righe malformate o non previste vengono rifiutate', () => {
  const cases = {
    '': 'empty',
    'non json': 'invalid-json',
    '{"type":"progress"': 'invalid-json',
    '[1,2]': 'invalid-event',
    'null': 'invalid-event',
    '{"type":"boom"}': 'invalid-event',
    '{"type":"status","status":"hacking"}': 'invalid-event',
    '{"type":"progress","progress":150,"processedSeconds":1}': 'invalid-event',
    '{"type":"progress","progress":-1,"processedSeconds":1}': 'invalid-event',
    '{"type":"progress","progress":"50","processedSeconds":1}': 'invalid-event',
    '{"type":"error","code":"lowercase","message":"x"}': 'invalid-event',
    '{"type":"completed","outputPath":""}': 'invalid-event'
  };
  for (const [line, reason] of Object.entries(cases)) {
    assert.deepEqual(parseEventLine(line), { ok: false, reason }, line);
  }
  assert.deepEqual(parseEventLine(`{"type":"status","message":"${'x'.repeat(MAX_LINE_LENGTH)}"}`), { ok: false, reason: 'too-long' });
});

test('evento version: informazioni sul motore validate', () => {
  const ev = validateEvent({
    type: 'version', converter: '2.0.0', python: '3.14.6', protocol: 1, frozen: true,
    engine: { available: true, pyav: '19.0.2', ffmpegLibraries: { libavcodec: '63.1.102', 'bad key!': 'x' }, license: 'LGPL', configuration: '--enable-libmp3lame', libmp3lame: true, extra: 1 }
  });
  assert.deepEqual(ev.engine, {
    available: true, pyav: '19.0.2', ffmpegLibraries: { libavcodec: '63.1.102' }, license: 'LGPL', configuration: '--enable-libmp3lame', libmp3lame: true
  });
  assert.deepEqual(validateEvent({ type: 'version', converter: '2.0.0' }).engine, { available: false });
  assert.deepEqual(validateEvent({ type: 'version', converter: '2.0.0', engine: { available: 'yes' } }).engine, { available: false });
});

test('validateEvent scarta i campi non previsti', () => {
  const ev = validateEvent({ type: 'status', status: 'converting', message: 'ok', extra: '<script>' });
  assert.deepEqual(Object.keys(ev).sort(), ['message', 'status', 'type']);
});

function nodeScript(code) {
  return { command: process.execPath, args: ['-e', code] };
}

test('ConverterProcess: inoltra gli eventi validi e registra le righe malformate', async () => {
  const logger = silentLogger();
  const { command, args } = nodeScript(`
    console.log(JSON.stringify({type:'status',status:'analyzing',message:'a'}));
    console.log('riga non json');
    console.log(JSON.stringify({type:'progress',progress:50,processedSeconds:5}));
    console.error('log tecnico su stderr');
    console.log(JSON.stringify({type:'completed',outputPath:'/x.mp3'}));
  `);
  const proc = new ConverterProcess({ command, args, logger });
  const events = [];
  proc.on('event', (e) => events.push(e));
  const exit = new Promise((resolve) => proc.on('exit', resolve));
  proc.start();
  const info = await exit;
  assert.equal(info.code, 0);
  assert.deepEqual(events.map((e) => e.type), ['status', 'progress', 'completed']);
  assert.equal(proc.malformedLines, 1);
  assert.ok(logger.warnings.some((w) => w.includes('invalid-json')));
  assert.ok(proc.stderrTail.includes('log tecnico su stderr'));
});

test('ConverterProcess: annullamento cooperativo tramite stdin', async () => {
  const { command, args } = nodeScript(`
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (d) => { if (d.includes('cancel')) { console.log(JSON.stringify({type:'cancelled'})); process.exit(130); } });
    setTimeout(() => process.exit(0), 20000);
  `);
  const proc = new ConverterProcess({ command, args, logger: silentLogger() });
  const events = [];
  proc.on('event', (e) => events.push(e));
  const exit = new Promise((resolve) => proc.on('exit', resolve));
  proc.start();
  await new Promise((r) => setTimeout(r, 300));
  const started = Date.now();
  proc.cancel();
  const info = await exit;
  assert.equal(info.code, 130);
  assert.ok(Date.now() - started < 5000);
  assert.deepEqual(events.map((e) => e.type), ['cancelled']);
});

test('ConverterProcess: terminazione forzata se il processo ignora l\'annullamento', async () => {
  const { command, args } = nodeScript(`process.stdin.resume(); setInterval(() => {}, 1000);`);
  const proc = new ConverterProcess({ command, args, logger: silentLogger(), killTimeoutMs: 300 });
  const exit = new Promise((resolve) => proc.on('exit', resolve));
  proc.start();
  await new Promise((r) => setTimeout(r, 200));
  proc.cancel();
  const info = await exit;
  assert.ok(info.code !== 0 || info.signal, 'il processo deve essere terminato');
});

test('ConverterProcess: eseguibile inesistente -> CONVERTER_NOT_FOUND', async () => {
  const proc = new ConverterProcess({ command: '/percorso/che/non/esiste/converter', args: [], logger: silentLogger() });
  const exit = new Promise((resolve) => proc.on('exit', resolve));
  proc.start();
  const info = await exit;
  assert.equal(info.spawnError, 'CONVERTER_NOT_FOUND');
});

test('ConverterProcess: argomenti con caratteri speciali arrivano intatti (nessuna shell)', async () => {
  const tricky = 'file "strano" & del *.* ; rm -rf ~ $(whoami) %PATH% `id`.mp4';
  const { command, args } = nodeScript(`console.log(JSON.stringify({type:'completed',outputPath:process.argv[1]}))`);
  const proc = new ConverterProcess({ command, args: [...args, tricky], logger: silentLogger() });
  const events = [];
  proc.on('event', (e) => events.push(e));
  const exit = new Promise((resolve) => proc.on('exit', resolve));
  proc.start();
  await exit;
  assert.equal(events[0].outputPath, tricky);
});
