import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const BIN = fileURLToPath(new URL('../bin/ccauto.js', import.meta.url));
let home;
let cwd;
let claudeDir;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'ccauto-home-'));
  cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'ccauto-cwd-'));
  claudeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccauto-claude-'));
});

function run(args, { input, env = {} } = {}) {
  const r = spawnSync(process.execPath, [BIN, ...args], {
    input,
    cwd,
    encoding: 'utf8',
    env: {
      ...process.env,
      CCAUTO_HOME: home,
      CCAUTO_HOOK: '',
      CCAUTO_MODE: '',
      CLAUDE_CONFIG_DIR: claudeDir, // never touch the real ~/.claude from tests
      ...env,
    },
  });
  return r;
}

function hookEvent(tool_name, tool_input) {
  return JSON.stringify({
    session_id: 'test',
    hook_event_name: 'PermissionRequest',
    cwd,
    permission_mode: 'default',
    tool_name,
    tool_input,
  });
}

function logLines() {
  const f = path.join(home, 'log.jsonl');
  return fs.existsSync(f) ? fs.readFileSync(f, 'utf8').trim().split('\n').map(JSON.parse) : [];
}

test('hook: allowed call prints the allow decision and logs it', () => {
  const r = run(['hook'], { input: hookEvent('Bash', { command: 'git status' }) });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout), {
    hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow' } },
  });
  const log = logLines();
  assert.equal(log.length, 1);
  assert.equal(log[0].action, 'allow');
  assert.equal(log[0].rule, 'git-readonly');
  assert.equal(log[0].emitted, true);
});

test('hook: dangerous call prints nothing so the dialog appears', () => {
  const r = run(['hook'], { input: hookEvent('Bash', { command: 'rm -rf node_modules' }) });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, '');
  const [entry] = logLines();
  assert.equal(entry.action, 'ask');
  assert.equal(entry.danger, true);
  assert.equal(entry.emitted, false);
});

test('hook: nested inside our own decider does nothing', () => {
  const r = run(['hook'], { input: hookEvent('Bash', { command: 'git status' }), env: { CCAUTO_HOOK: '1' } });
  assert.equal(r.status, 0);
  assert.equal(r.stdout, '');
  assert.equal(logLines().length, 0);
});

test('hook: garbage on stdin exits 0 with no output', () => {
  const r = run(['hook'], { input: 'not json' });
  assert.equal(r.status, 0);
  assert.equal(r.stdout, '');
  assert.match(logLines()[0].error, /bad stdin/);
});

test('hook: broken project config falls through to the dialog', () => {
  fs.mkdirSync(path.join(cwd, '.ccauto'));
  fs.writeFileSync(path.join(cwd, '.ccauto', 'config.json'), '{ "onDanger": "nope" }');
  const r = run(['hook'], { input: hookEvent('Bash', { command: 'git status' }) });
  assert.equal(r.status, 0);
  assert.equal(r.stdout, '');
  assert.match(r.stderr, /onDanger/);
});

test('check: dry run reports the verdict and the hook output', () => {
  const r = run(['check', 'Bash', 'npm test']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /action:\s+allow/);
  assert.match(r.stdout, /"behavior": "allow"/);
  const r2 = run(['check', 'mcp__browser-devtools__launch_browser', '{"browserFamily":"chromium"}']);
  assert.match(r2.stdout, /action:\s+ask/);
  assert.match(r2.stdout, /shows the dialog/);
});

test('check --run: executes the configured decider', () => {
  fs.mkdirSync(path.join(cwd, '.ccauto'));
  fs.writeFileSync(
    path.join(cwd, '.ccauto', 'config.json'),
    JSON.stringify({ onUnmatched: 'decider', deciders: { default: { command: 'echo DENY: nope' } } }),
  );
  const dry = run(['check', 'Bash', 'npm install x']);
  assert.match(dry.stdout, /action:\s+decider/);
  assert.match(dry.stdout, /dry run/);
  const live = run(['check', '--run', 'Bash', 'npm install x']);
  assert.match(live.stdout, /action:\s+deny/, live.stderr);
  assert.match(live.stdout, /decider: DENY: nope/);
});

test('config and log commands', () => {
  run(['hook'], { input: hookEvent('Bash', { command: 'git status' }) });
  const c = run(['config']);
  assert.equal(c.status, 0, c.stderr);
  assert.match(c.stdout, /git-readonly/);
  const l = run(['log', '-n', '5']);
  assert.equal(l.status, 0, l.stderr);
  assert.match(l.stdout, /allow\s+Bash\s+"git status" rule=git-readonly/);
});

test('mode: approve-all override flips the hook, reset restores policy', () => {
  assert.match(run(['mode']).stdout, /^policy\s+\(default\)/);

  const set = run(['mode', 'approve-all']);
  assert.equal(set.status, 0, set.stderr);
  assert.match(set.stdout, /approve-all stored in .*state\.json/);
  assert.match(set.stdout, /every permission prompt will now be approved/);
  assert.equal(JSON.parse(fs.readFileSync(path.join(home, 'state.json'), 'utf8')).mode, 'approve-all');
  assert.match(run(['mode']).stdout, /^approve-all\s+\(override /);

  const r = run(['hook'], { input: hookEvent('Bash', { command: 'rm -rf node_modules' }) });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(JSON.parse(r.stdout).hookSpecificOutput.decision.behavior, 'allow');
  const [entry] = logLines();
  assert.equal(entry.mode, 'approve-all');
  assert.equal(entry.danger, true);
  assert.match(run(['log']).stdout, /allow Bash\s+"rm -rf node_modules" danger \[approve-all\]/);

  const reset = run(['mode', 'reset']);
  assert.match(reset.stdout, /mode is now policy \(default\)/);
  const r2 = run(['hook'], { input: hookEvent('Bash', { command: 'rm -rf node_modules' }) });
  assert.equal(r2.stdout, '');
});

test('mode: env var wins for one shell, bad values are rejected', () => {
  const r = run(['check', 'Bash', 'rm -rf x'], { env: { CCAUTO_MODE: 'approve-all' } });
  assert.match(r.stdout, /mode:\s+approve-all \(env CCAUTO_MODE\)/);
  assert.match(r.stdout, /action:\s+allow/);
  const bad = run(['mode', 'yolo']);
  assert.equal(bad.status, 2);
  assert.match(bad.stderr, /mode must be one of policy\|approve-all\|approve-except-deletes, or reset/);
  const badEnv = run(['hook'], { input: hookEvent('Bash', { command: 'git status' }), env: { CCAUTO_MODE: 'nope' } });
  assert.equal(badEnv.status, 0);
  assert.equal(badEnv.stdout, '', 'invalid mode falls through to the dialog');
  assert.match(badEnv.stderr, /mode \(env CCAUTO_MODE\)/);
});

test('install/uninstall round trip through the CLI, and mode warns when not installed', () => {
  const settings = path.join(claudeDir, 'settings.json');

  const m1 = run(['mode', 'approve-all']);
  assert.match(m1.stdout, /warning: the hook is not installed/);
  assert.match(run(['mode']).stdout, /hook:\s+NOT installed/);
  assert.match(run(['config']).stdout, /hook:\s+NOT installed/);

  const i1 = run(['install']);
  assert.equal(i1.status, 0, i1.stderr);
  assert.match(i1.stdout, /installed PermissionRequest hook in/);
  const s = JSON.parse(fs.readFileSync(settings, 'utf8'));
  assert.match(s.hooks.PermissionRequest[0].hooks[0].command, /bin\/ccauto\.js" hook$/);

  const i2 = run(['install']);
  assert.match(i2.stdout, /already installed/);

  const m2 = run(['mode', 'approve-all']);
  assert.doesNotMatch(m2.stdout, /warning/);
  assert.match(run(['mode']).stdout, /hook:\s+installed in/);

  const u = run(['uninstall']);
  assert.match(u.stdout, /removed 1 hook entry/);
  assert.deepEqual(JSON.parse(fs.readFileSync(settings, 'utf8')), {});
  assert.match(run(['uninstall']).stdout, /nothing to remove/);
});

test('unknown command exits 2', () => {
  assert.equal(run(['bogus']).status, 2);
  assert.equal(run([]).status, 0);
});
