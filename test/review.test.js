// Regressions for the findings of an external review of the policy gate.
// Every case here was once answered `allow` (or silently never expired).
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { evaluate, loadPolicy, splitShell, hasSubstitution, storedMode, shellFlavor } from '../lib/policy.js';

let cwd;

beforeEach(() => {
  process.env.CCAUTO_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'ccauto-home-'));
  cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'ccauto-cwd-'));
  delete process.env.CCAUTO_MODE;
});

const verdict = (command, tool = 'Bash') => evaluate(loadPolicy(cwd), tool, { command }).action;

// --- substitution the splitter used to miss ------------------------------

test('process substitution in either direction is not auto-allowed', () => {
  assert.ok(hasSubstitution('diff <(a) <(b)'), '<( )');
  assert.ok(hasSubstitution('git status >(printf PWN)'), '>( ) writes through a command too');
  assert.equal(verdict('git status >(printf PWN)'), 'ask');
  assert.equal(verdict('git status <(printf PWN)'), 'ask');
});

test('a line continuation cannot hide a substitution', () => {
  // The shell deletes backslash-newline outright, so bash reads this as
  // `git status $(printf PWN)`. Replacing it with a space would leave "$ (".
  const command = 'git status $\\\n(printf PWN)';
  assert.deepEqual(splitShell(command), ['git status $(printf PWN)']);
  assert.ok(hasSubstitution(splitShell(command)[0]));
  assert.equal(verdict(command), 'ask');
});

test('a continuation still joins a line without inventing a separator', () => {
  assert.deepEqual(splitShell('git status \\\n && ls'), ['git status', 'ls']);
  assert.deepEqual(splitShell('npm\\\ntest'), ['npmtest'], 'with no space, the shell joins the words');
});

// --- read-only git that was not read-only --------------------------------

test('git-readonly refuses commands that write', () => {
  for (const command of [
    'git branch -D important',
    'git branch --delete important',
    'git diff --output=/tmp/overwritten',
    'git branch -m old new',
    'git branch --set-upstream-to=origin/x',
  ]) {
    assert.equal(verdict(command), 'ask', command);
  }
});

test('git-readonly still allows the read-only forms', () => {
  for (const command of ['git status', 'git log --oneline', 'git diff HEAD~1', 'git branch', 'git show', 'git blame a.js', 'git remote -v', 'git stash list']) {
    assert.equal(verdict(command), 'allow', command);
  }
});

// --- test runners that were an arbitrary-code path -----------------------

test('a runner may not be pointed outside the project', () => {
  for (const command of [
    'node --test /tmp/payload.js',
    'node --test ~/payload.js',
    'node --test C:/tmp/payload.js',
    'node --test ../outside/x.js',
    'pytest /tmp/evil.py',
    'pytest ../evil.py',
  ]) {
    assert.equal(verdict(command), 'ask', command);
  }
});

test('a checker may not be turned into an editor', () => {
  assert.equal(verdict('npx eslint --fix .'), 'ask');
  assert.equal(verdict('npx prettier --check . --write'), 'ask');
});

test('runners against the project itself are still allowed', () => {
  for (const command of ['npm test', 'npm run build', 'cargo test --workspace', 'pytest tests/', 'node --test test/policy.test.js', 'npx eslint .', 'go test ./...']) {
    assert.equal(verdict(command), 'allow', command);
  }
});

// --- PowerShell is not bash ----------------------------------------------

test('PowerShell uses its own escape and substitution syntax', () => {
  assert.equal(shellFlavor('PowerShell'), 'powershell');
  assert.equal(shellFlavor('Bash'), 'bash');
  // A backslash escapes in bash but is an ordinary character in PowerShell,
  // so `\;` really does start a second statement there.
  assert.deepEqual(splitShell('git status \\; Write-Output PWN', 'powershell'), ['git status \\', 'Write-Output PWN']);
  assert.deepEqual(splitShell('git status \\; Write-Output PWN', 'bash'), ['git status \\; Write-Output PWN']);
  // A backtick runs a command in bash and escapes one in PowerShell.
  assert.ok(hasSubstitution('echo `id`', 'bash'));
  assert.ok(!hasSubstitution('echo `id`', 'powershell'));
  assert.ok(hasSubstitution('git status @(Write-Output PWN)', 'powershell'), '@( ) is a PowerShell subexpression');
  assert.ok(hasSubstitution('git status &(gcm evil)', 'powershell'));
});

test('a PowerShell allow rule does not carry a second statement', () => {
  fs.mkdirSync(path.join(cwd, '.ccauto'), { recursive: true });
  fs.writeFileSync(
    path.join(cwd, '.ccauto', 'config.json'),
    JSON.stringify({ rules: [{ name: 'ps-git', tool: 'PowerShell', match: '^git status\\b', action: 'allow' }] }),
  );
  assert.equal(verdict('git status', 'PowerShell'), 'allow');
  assert.equal(verdict('git status \\; Write-Output PWN', 'PowerShell'), 'ask');
  assert.equal(verdict('git status @(Write-Output PWN)', 'PowerShell'), 'ask');
});

// --- the safety deadline must fail closed --------------------------------

test('an expiry that cannot be read counts as expired, not as never', () => {
  for (const modeExpiresAt of ['not-a-date', '', 0, 1, {}, [], true]) {
    assert.equal(
      storedMode({ mode: 'approve-all', modeExpiresAt }, Date.now()),
      null,
      `modeExpiresAt = ${JSON.stringify(modeExpiresAt)}`,
    );
  }
});

test('an override with no deadline at all still lasts until reset', () => {
  assert.equal(storedMode({ mode: 'approve-all' }, Date.now()), 'approve-all');
  assert.equal(storedMode({ mode: 'approve-all', modeExpiresAt: null }, Date.now()), 'approve-all');
});

// --- payload stripping must not hide an action ---------------------------

test('an MCP tool whose action lives in a payload-named field is still scanned', () => {
  const p = loadPolicy(cwd);
  assert.equal(evaluate(p, 'mcp__db__query', { server: 'db', text: 'DROP TABLE users' }).danger, true);
  assert.equal(evaluate(p, 'mcp__sh__run', { body: 'sudo rm -rf /' }).danger, true);
  assert.equal(evaluate(p, 'mcp__fs__put', { content: 'chmod 777 /' }).danger, true);
});

test('an editing tool keeps its payload out of the danger subject', () => {
  const p = loadPolicy(cwd);
  assert.equal(evaluate(p, 'Write', { file_path: 'src/a.js', content: 'sudo rm -rf /' }).danger, false);
  assert.equal(evaluate(p, 'Write', { file_path: 'src/sudo-helper.js', content: 'x' }).danger, true, 'the path is still scanned');
});
