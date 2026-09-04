import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { appendLog, readLog, logPath, rotatedPath, rotateIfNeeded } from '../lib/log.js';
import { parseJsonc, stripComments, stripTrailingCommas } from '../lib/jsonc.js';

let home;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'ccauto-home-'));
  process.env.CCAUTO_HOME = home;
});

const policyWith = (log) => ({ log: { enabled: true, file: null, maxBytes: 5 * 1024 * 1024, ...log } });
const fill = (policy, n, from = 0) => {
  for (let i = from; i < from + n; i++) appendLog(policy, { i, tool: 'Bash', action: 'allow', pad: 'x'.repeat(40) });
};

test('the log grows until maxBytes, then rolls over to one previous generation', () => {
  const policy = policyWith({ maxBytes: 2000 });
  const file = logPath(policy);
  fill(policy, 200);
  assert.ok(fs.existsSync(rotatedPath(file)), 'previous generation kept');
  assert.ok(fs.statSync(file).size < 2000 + 200, 'live file restarted');
});

test('rotation keeps exactly one generation', () => {
  const policy = policyWith({ maxBytes: 500 });
  const file = logPath(policy);
  fill(policy, 300);
  assert.equal(fs.existsSync(rotatedPath(file)), true);
  assert.equal(fs.existsSync(`${rotatedPath(file)}.1`), false);
  assert.equal(fs.existsSync(`${file}.2`), false);
});

test('the newest entries survive a rotation', () => {
  const policy = policyWith({ maxBytes: 2000 });
  fill(policy, 200);
  assert.deepEqual(
    readLog(policy, 5).map((e) => e.i),
    [195, 196, 197, 198, 199],
  );
});

test('reading more than the live file holds tops up from the previous generation', () => {
  // Two generations must be able to hold the 50 entries we ask for.
  const policy = policyWith({ maxBytes: 6000 });
  fill(policy, 200);
  const entries = readLog(policy, 50);
  assert.equal(entries.length, 50);
  assert.deepEqual(
    entries.map((e) => e.i),
    Array.from({ length: 50 }, (_, k) => 150 + k),
    'contiguous across the rotation boundary',
  );
});

test('maxBytes 0 never rotates', () => {
  const policy = policyWith({ maxBytes: 0 });
  fill(policy, 200);
  assert.equal(fs.existsSync(rotatedPath(logPath(policy))), false);
  assert.equal(readLog(policy, 1)[0].i, 199);
});

test('rotateIfNeeded is a no-op with no log yet', () => {
  assert.equal(rotateIfNeeded(policyWith({ maxBytes: 10 })), false);
});

test('reading a log that does not exist yields nothing', () => {
  assert.deepEqual(readLog(policyWith({}), 10), []);
});

test('a truncated last line does not break reading', () => {
  const policy = policyWith({});
  fill(policy, 3);
  fs.appendFileSync(logPath(policy), '{"i":99,"broken"');
  const entries = readLog(policy, 10);
  assert.equal(entries.length, 4);
  assert.ok(entries.at(-1).raw, 'unparseable line is surfaced raw rather than thrown away');
});

test('logging stays disabled when asked', () => {
  const policy = { log: { enabled: false } };
  fill(policy, 5);
  assert.equal(fs.existsSync(logPath(policy)), false);
});

// --- the JSONC bug this shook out ---------------------------------------

test('a comma is trailing even when a comment sits before the bracket', () => {
  // The pattern in config.example.jsonc: a real last rule, then a
  // commented-out one. Looking ahead in the raw text sees "/" and keeps the
  // comma, which is only invalid once the comment is gone.
  const src = '{\n "rules": [\n  {"a": 1},\n  // {"b": 2},\n ],\n}';
  assert.deepEqual(parseJsonc(src), { rules: [{ a: 1 }] });
});

test('block comments and nested structures before a bracket', () => {
  assert.deepEqual(parseJsonc('{"a":[1,/* gone */],"b":{"c":1,/* gone */}}'), { a: [1], b: { c: 1 } });
});

test('separators inside strings are left alone', () => {
  assert.deepEqual(parseJsonc('{"u":"http://x/y","s":"a,]","t":"/* not a comment */"}'), {
    u: 'http://x/y',
    s: 'a,]',
    t: '/* not a comment */',
  });
});

test('escapes inside strings survive both passes', () => {
  assert.deepEqual(parseJsonc('{"s":"he said \\"hi\\", ok","p":"C:\\\\tmp\\\\x"}'), {
    s: 'he said "hi", ok',
    p: 'C:\\tmp\\x',
  });
});

test('the passes are usable on their own', () => {
  assert.equal(stripComments('{"a":1} // tail').trim(), '{"a":1}');
  assert.equal(stripTrailingCommas('{"a":[1,2,]}'), '{"a":[1,2]}');
});
