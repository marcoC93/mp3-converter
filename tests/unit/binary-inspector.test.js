'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { inspectBuffer, isCompatible } = require('../../src/main/binary-inspector');

/** Header sintetici minimi: bastano per riconoscere formato e architettura. */
function pe(machine) {
  const b = Buffer.alloc(512);
  b.write('MZ', 0, 'latin1');
  b.writeUInt32LE(0x80, 0x3c);
  b.writeUInt32BE(0x50450000, 0x80);
  b.writeUInt16LE(machine, 0x84);
  return b;
}
function elf(machine) {
  const b = Buffer.alloc(128);
  b.set([0x7f, 0x45, 0x4c, 0x46, 2, 1], 0);
  b.writeUInt16LE(machine, 0x12);
  return b;
}
function macho(cpu) {
  const b = Buffer.alloc(128);
  b.writeUInt32LE(0xfeedfacf, 0);
  b.writeUInt32LE(cpu, 4);
  return b;
}
function fat(cpus) {
  const b = Buffer.alloc(256);
  b.writeUInt32BE(0xcafebabe, 0);
  b.writeUInt32BE(cpus.length, 4);
  cpus.forEach((cpu, i) => b.writeUInt32BE(cpu, 8 + i * 20));
  return b;
}

test('riconosce eseguibili Windows PE', () => {
  assert.deepEqual(inspectBuffer(pe(0x8664)), { format: 'pe', platform: 'win32', archs: ['x64'] });
  assert.deepEqual(inspectBuffer(pe(0xaa64)).archs, ['arm64']);
});

test('riconosce eseguibili Linux ELF', () => {
  assert.deepEqual(inspectBuffer(elf(0x3e)), { format: 'elf', platform: 'linux', archs: ['x64'] });
  assert.deepEqual(inspectBuffer(elf(0xb7)).archs, ['arm64']);
});

test('riconosce Mach-O e universal binary', () => {
  assert.deepEqual(inspectBuffer(macho(0x01000007)), { format: 'macho', platform: 'darwin', archs: ['x64'] });
  assert.deepEqual(inspectBuffer(macho(0x0100000c)).archs, ['arm64']);
  const universal = inspectBuffer(fat([0x01000007, 0x0100000c]));
  assert.equal(universal.format, 'macho-universal');
  assert.ok(isCompatible(universal, 'darwin', 'arm64'));
  assert.ok(isCompatible(universal, 'darwin', 'x64'));
});

test('file non eseguibili o troppo corti -> unknown', () => {
  assert.equal(inspectBuffer(Buffer.from('#!/bin/sh\necho ciao\n'.padEnd(100))).format, 'unknown');
  assert.equal(inspectBuffer(Buffer.alloc(10)).format, 'unknown');
  assert.equal(inspectBuffer('non buffer').format, 'unknown');
});

test('compatibilità: piattaforma e architettura devono coincidere', () => {
  assert.ok(isCompatible(inspectBuffer(pe(0x8664)), 'win32', 'x64'));
  assert.ok(!isCompatible(inspectBuffer(pe(0x8664)), 'win32', 'arm64'));
  assert.ok(!isCompatible(inspectBuffer(elf(0x3e)), 'win32', 'x64'));
  assert.ok(!isCompatible(inspectBuffer(macho(0x01000007)), 'darwin', 'arm64'));
});
