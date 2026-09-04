// `approve-except-deletes`: approve everything, but stop before anything
// that removes files. The gap it fills is that `approve-all` ignores `ask`
// rules by design, so there was no way to say "silent, except confirm this".
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { evaluate, loadPolicy, DEFAULT_DELETION_WORDS, defaultRules } from '../lib/policy.js';

let cwd;

function writeConfig(obj) {
  fs.mkdirSync(path.join(cwd, '.ccauto'), { recursive: true });
  fs.writeFileSync(path.join(cwd, '.ccauto', 'config.json'), JSON.stringify(obj));
}

beforeEach(() => {
  process.env.CCAUTO_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'ccauto-home-'));
  cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'ccauto-cwd-'));
  delete process.env.CCAUTO_MODE;
});

const inMode = (extra = {}) => {
  writeConfig({ mode: 'approve-except-deletes', ...extra });
  return loadPolicy(cwd);
};
const act = (p, command, tool = 'Bash') => evaluate(p, tool, { command }).action;

test('everything that does not delete is approved silently', () => {
  const p = inMode();
  for (const command of [
    'npm test',
    'npm install left-pad',
    'curl -s https://example.com',
    'mkdir -p build',
    'git push --force origin main',
    'git reset --hard HEAD~3',
    'chmod 777 /tmp/x',
  ]) {
    assert.equal(act(p, command), 'allow', command);
  }
  assert.equal(evaluate(p, 'Write', { file_path: 'src/a.js', content: 'x' }).action, 'allow');
  assert.equal(evaluate(p, 'mcp__browser-devtools__launch_browser', { browserFamily: 'chromium' }).action, 'allow');
});

test('anything that removes files stops and asks', () => {
  const p = inMode();
  for (const command of [
    'rm -rf build',
    'rm file.txt',
    'rmdir old',
    'find . -name "*.log" -delete',
    'git clean -fd',
    'git rm a.js',
    'npx rimraf dist',
    'shred secret.key',
    'Remove-Item -Recurse x',
    'del C:/tmp/x',
  ]) {
    const v = evaluate(p, 'Bash', { command });
    assert.equal(v.action, 'ask', command);
    assert.equal(v.rule.name, 'deletes', command);
  }
});

test('a deletion anywhere on the line is enough', () => {
  const p = inMode();
  assert.equal(act(p, 'npm test && rm -rf dist'), 'ask');
  assert.equal(act(p, 'npm test && npm run build'), 'allow');
});

test('a tool whose name says it removes something asks too', () => {
  const p = inMode();
  for (const tool of ['mcp__fs__delete_file', 'mcp__s3__removeObject', 'mcp__x__unlink', 'mcp__mail__trash']) {
    const v = evaluate(p, tool, { path: '/important' });
    assert.equal(v.action, 'ask', tool);
    assert.equal(v.rule.name, 'delete-tools', tool);
  }
});

test('other ask rules apply too, which is what separates this from approve-all', () => {
  const p = inMode();
  const v = evaluate(p, 'Edit', { file_path: 'C:/proj/.env', new_string: 'x' });
  assert.equal(v.action, 'ask');
  assert.equal(v.rule.name, 'secrets');
  // approve-all, by contrast, ignores ask rules entirely.
  writeConfig({ mode: 'approve-all' });
  assert.equal(evaluate(loadPolicy(cwd), 'Edit', { file_path: 'C:/proj/.env', new_string: 'x' }).action, 'allow');
});

test('deny rules still win', () => {
  const p = inMode({ rules: [{ name: 'never-prod', tool: 'Bash', match: 'kubectl.*prod', action: 'deny' }] });
  const v = evaluate(p, 'Bash', { command: 'kubectl delete -n prod x' });
  assert.equal(v.action, 'deny');
  assert.equal(v.rule.name, 'never-prod');
});

test('your own allow rule keeps a deletion you trust silent', () => {
  const p = inMode({ rules: [{ name: 'ok-to-clean', tool: 'Bash', match: '^rm -rf build$', action: 'allow' }] });
  assert.equal(act(p, 'rm -rf build'), 'allow', 'first match wins, and yours comes first');
  assert.equal(act(p, 'rm -rf src'), 'ask', 'anything else still asks');
});

test('a decider rule does not stop this mode to think', () => {
  const p = inMode({
    rules: [{ name: 'judge', tool: 'Bash', match: '^npm install', action: 'decider' }],
    deciders: { default: { command: 'echo ASK' } },
  });
  assert.equal(act(p, 'npm install left-pad'), 'allow');
});

test('deletionWords replaces the built-in list', () => {
  const p = inMode({ deletionWords: ['\\bnuke\\b'] });
  assert.deepEqual(p.deletionWords, ['\\bnuke\\b']);
  assert.equal(act(p, 'nuke everything'), 'ask');
  assert.equal(act(p, 'rm -rf build'), 'allow', 'no longer in the list');
});

test('the mode is a normal mode: env, override and expiry all work on it', () => {
  writeConfig({ mode: 'policy' });
  process.env.CCAUTO_MODE = 'approve-except-deletes';
  const p = loadPolicy(cwd);
  assert.equal(p.mode, 'approve-except-deletes');
  assert.match(p.modeSource, /^env/);
});

test('in policy mode the deletes rule names what is happening', () => {
  const p = loadPolicy(cwd); // policy mode, no config
  const v = evaluate(p, 'Bash', { command: 'rm -rf build' });
  assert.equal(v.action, 'ask');
  assert.equal(v.rule.name, 'deletes');
});

test('defaultRules rebuilds the deletes rule from the words given', () => {
  const rebuilt = defaultRules(['\\bnuke\\b']).find((r) => r.name === 'deletes');
  assert.equal(rebuilt.match, '\\bnuke\\b');
  const stock = defaultRules().find((r) => r.name === 'deletes');
  assert.equal(stock.match, DEFAULT_DELETION_WORDS.join('|'));
});
