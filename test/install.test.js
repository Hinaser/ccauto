import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { install, uninstall, installStatus, hookCommand, settingsPath, isOurs, installKind, binOnPath } from '../lib/install.js';

let dir;
let file;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccauto-claude-'));
  process.env.CLAUDE_CONFIG_DIR = dir;
  file = path.join(dir, 'settings.json');
});

const read = () => JSON.parse(fs.readFileSync(file, 'utf8'));

test('settingsPath honours CLAUDE_CONFIG_DIR', () => {
  assert.equal(settingsPath(), file);
});

test('hookCommand uses forward slashes and ends with hook', () => {
  const cmd = hookCommand();
  assert.match(cmd, /^node ".*\/bin\/ccauto\.js" hook$/);
  assert.doesNotMatch(cmd, /\\/);
  assert.ok(isOurs({ type: 'command', command: cmd }));
  assert.ok(!isOurs({ type: 'command', command: 'prettier --write' }));
});

test('install creates settings.json when absent', () => {
  assert.equal(installStatus().installed, false);
  const r = install();
  assert.equal(r.changed, true);
  const s = read();
  assert.equal(s.hooks.PermissionRequest.length, 1);
  assert.deepEqual(s.hooks.PermissionRequest[0].hooks[0], { type: 'command', command: hookCommand(), timeout: 60 });
  assert.equal(installStatus().installed, true);
  assert.equal(installStatus().stale, false);
});

test('install merges, preserves other settings and hooks, and is idempotent', () => {
  fs.writeFileSync(
    file,
    JSON.stringify({
      model: 'opus',
      permissions: { allow: ['Bash(git *)'] },
      hooks: {
        PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'echo pre' }] }],
        PermissionRequest: [{ matcher: 'Edit', hooks: [{ type: 'command', command: 'echo other' }] }],
      },
    }),
  );
  assert.equal(install().changed, true);
  assert.equal(install().changed, false);
  const s = read();
  assert.equal(s.model, 'opus');
  assert.deepEqual(s.permissions.allow, ['Bash(git *)']);
  assert.equal(s.hooks.PreToolUse[0].hooks[0].command, 'echo pre');
  assert.equal(s.hooks.PermissionRequest.length, 2);
  assert.equal(s.hooks.PermissionRequest[0].hooks[0].command, 'echo other');
  assert.equal(s.hooks.PermissionRequest[1].hooks[0].command, hookCommand());
});

test('install repoints a stale entry instead of adding a second one', () => {
  fs.writeFileSync(
    file,
    JSON.stringify({
      hooks: { PermissionRequest: [{ hooks: [{ type: 'command', command: 'node "D:/old/ccauto/bin/ccauto.js" hook', timeout: 60 }] }] },
    }),
  );
  assert.equal(installStatus().stale, true);
  const r = install();
  assert.equal(r.changed, true);
  assert.equal(r.updated, true);
  const entries = read().hooks.PermissionRequest.flatMap((g) => g.hooks);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].command, hookCommand());
});

test('uninstall removes only our entries and tidies empty containers', () => {
  fs.writeFileSync(
    file,
    JSON.stringify({
      model: 'opus',
      hooks: { PermissionRequest: [{ matcher: 'Edit', hooks: [{ type: 'command', command: 'echo other' }] }] },
    }),
  );
  install();
  let r = uninstall();
  assert.equal(r.removed, 1);
  let s = read();
  assert.equal(s.hooks.PermissionRequest.length, 1);
  assert.equal(s.hooks.PermissionRequest[0].hooks[0].command, 'echo other');
  assert.equal(uninstall().changed, false);

  fs.writeFileSync(file, JSON.stringify({ model: 'opus' }));
  install();
  r = uninstall();
  assert.equal(r.removed, 1);
  s = read();
  assert.deepEqual(s, { model: 'opus' });
});

test('install refuses to touch a settings.json it cannot parse', () => {
  fs.writeFileSync(file, '{ "model": "opus", ');
  assert.throws(() => install(), /not valid JSON/);
  assert.equal(fs.readFileSync(file, 'utf8'), '{ "model": "opus", ');
  assert.match(installStatus().error, /not valid JSON/);
});

// --- distribution form: checkout vs installed package vs npx -------------

const CHECKOUT = "C:/proj/ccauto/bin/ccauto.js";
const GLOBAL = "C:/Users/x/AppData/Roaming/npm/node_modules/ccauto/bin/ccauto.js";
const NPX = "C:/Users/x/AppData/Local/npm-cache/_npx/a1b2/node_modules/ccauto/bin/ccauto.js";

test("installKind tells a checkout, a global install and npx apart", () => {
  assert.equal(installKind(CHECKOUT), "checkout");
  assert.equal(installKind(GLOBAL), "package");
  assert.equal(installKind(NPX), "npx");
});

test("a checkout is recorded by absolute path", () => {
  assert.equal(hookCommand(CHECKOUT), `node "${CHECKOUT}" hook`);
});

test("an installed package uses the PATH launcher, and falls back without one", () => {
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), "ccauto-bin-"));
  const saved = process.env.PATH;
  try {
    process.env.PATH = bin;
    assert.equal(binOnPath(), false);
    assert.equal(hookCommand(GLOBAL), `node "${GLOBAL}" hook`, "no launcher on PATH: keep the absolute path");

    const shim = process.platform === "win32" ? "ccauto.cmd" : "ccauto";
    fs.writeFileSync(path.join(bin, shim), "");
    assert.equal(binOnPath(), true);
    assert.equal(hookCommand(GLOBAL), "ccauto hook", "launcher on PATH: survives the package moving");
  } finally {
    process.env.PATH = saved;
  }
});

test("install refuses to run under npx instead of writing a doomed path", () => {
  assert.throws(() => install({ file, bin: NPX }), /npx cache/);
  assert.equal(fs.existsSync(file), false, "settings.json must not be created");
});

test("isOurs recognises both the path form and the bare launcher form", () => {
  const ours = (command) => isOurs({ type: "command", command });
  assert.ok(ours(`node "${CHECKOUT}" hook`));
  assert.ok(ours("ccauto hook"));
  assert.ok(ours("node /usr/lib/node_modules/ccauto/bin/ccauto.js hook"));
  assert.ok(!ours("prettier --write"));
  assert.ok(!ours("myccauto hook"), "must not claim a different tool whose name ends in ccauto");
  assert.ok(!ours("ccauto check Bash ls"), "only the hook entry point is ours");
});

test("switching form repoints the existing entry rather than adding a second", () => {
  fs.writeFileSync(
    file,
    JSON.stringify({ hooks: { PermissionRequest: [{ hooks: [{ type: "command", command: `node "${CHECKOUT}" hook`, timeout: 60 }] }] } }),
  );
  assert.equal(installStatus(file, GLOBAL).installed, true);

  const bin = fs.mkdtempSync(path.join(os.tmpdir(), "ccauto-bin-"));
  const saved = process.env.PATH;
  try {
    process.env.PATH = bin;
    fs.writeFileSync(path.join(bin, process.platform === "win32" ? "ccauto.cmd" : "ccauto"), "");
    assert.equal(installStatus(file, GLOBAL).stale, true);
    const r = install({ file, bin: GLOBAL });
    assert.equal(r.updated, true);
    const entries = JSON.parse(fs.readFileSync(file, "utf8")).hooks.PermissionRequest.flatMap((g) => g.hooks);
    assert.equal(entries.length, 1);
    assert.equal(entries[0].command, "ccauto hook");
    assert.equal(uninstall({ file }).removed, 1, "uninstall must still find it in the new form");
  } finally {
    process.env.PATH = saved;
  }
});
