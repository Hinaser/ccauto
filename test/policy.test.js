import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { evaluate, loadPolicy, targetOf, toolRegex, writeState, readState } from '../lib/policy.js';
import { parseJsonc } from '../lib/jsonc.js';

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

test('jsonc strips comments and trailing commas', () => {
  const v = parseJsonc('{\n // c\n "a": [1, 2, /* x */ 3,],\n "s": "http://not/a/comment",\n}');
  assert.deepEqual(v, { a: [1, 2, 3], s: 'http://not/a/comment' });
});

test('toolRegex handles globs and alternation', () => {
  assert.ok(toolRegex('Bash').test('Bash'));
  assert.ok(!toolRegex('Bash').test('BashX'));
  assert.ok(toolRegex('Edit|Write').test('Write'));
  assert.ok(toolRegex('mcp__browser-devtools__*').test('mcp__browser-devtools__launch_browser'));
  assert.ok(!toolRegex('mcp__browser-devtools__*').test('mcp__other__x'));
  assert.ok(toolRegex('*').test('anything'));
});

test('targetOf maps tool inputs', () => {
  assert.equal(targetOf('Bash', { command: 'git status' }), 'git status');
  assert.equal(targetOf('Edit', { file_path: 'a.js' }), 'a.js');
  assert.equal(targetOf('mcp__x__y', { foo: 1 }), 'mcp__x__y');
});

test('defaults: read-only git is allowed', () => {
  const p = loadPolicy(cwd);
  const v = evaluate(p, 'Bash', { command: 'git status' });
  assert.equal(v.action, 'allow');
  assert.equal(v.rule.name, 'git-readonly');
  assert.equal(v.danger, false);
});

test('defaults: danger words turn an allow into ask', () => {
  const p = loadPolicy(cwd);
  const v = evaluate(p, 'Bash', { command: 'git status && rm -rf build' });
  assert.equal(v.action, 'ask');
  assert.equal(v.rule.name, 'git-readonly');
  assert.equal(v.danger, true);
  assert.equal(v.escalated, true);
});

test('defaults: unmatched command asks', () => {
  const p = loadPolicy(cwd);
  const v = evaluate(p, 'Bash', { command: 'npm install left-pad' });
  assert.equal(v.action, 'ask');
  assert.equal(v.rule, null);
});

test('defaults: deleting is named, not merely unmatched', () => {
  const p = loadPolicy(cwd);
  const v = evaluate(p, 'Bash', { command: 'rm -rf build' });
  assert.equal(v.action, 'ask');
  assert.equal(v.rule.name, 'deletes');
  assert.equal(v.danger, true);
});

test('defaults: test runners are allowed', () => {
  const p = loadPolicy(cwd);
  assert.equal(evaluate(p, 'Bash', { command: 'npm test' }).action, 'allow');
  assert.equal(evaluate(p, 'Bash', { command: 'cargo test --workspace' }).action, 'allow');
  assert.equal(evaluate(p, 'Bash', { command: 'npm install left-pad' }).action, 'ask');
});

test('defaults: secrets are always a human decision', () => {
  const p = loadPolicy(cwd);
  const v = evaluate(p, 'Edit', { file_path: 'C:/proj/.env.local', old_string: 'a', new_string: 'b' });
  assert.equal(v.action, 'ask');
  assert.equal(v.rule.name, 'secrets');
  assert.equal(evaluate(p, 'Bash', { command: 'ls -la .env' }).rule.name, 'secrets');
});

test('defaults: unknown MCP tool asks', () => {
  const p = loadPolicy(cwd);
  const v = evaluate(p, 'mcp__browser-devtools__launch_browser', { browserFamily: 'chromium' });
  assert.equal(v.action, 'ask');
  assert.equal(v.rule, null);
});

test('project config: allow an MCP server by glob', () => {
  writeProjectConfig({
    rules: [{ name: 'browser', tool: 'mcp__browser-devtools__*', action: 'allow' }],
  });
  const p = loadPolicy(cwd);
  const v = evaluate(p, 'mcp__browser-devtools__launch_browser', { browserFamily: 'chromium' });
  assert.equal(v.action, 'allow');
  assert.equal(v.rule.source, 'project');
});

test('project config: same-name rule shadows a default; disabled tombstones it', () => {
  writeProjectConfig({ rules: [{ name: 'git-readonly', disabled: true }] });
  const p = loadPolicy(cwd);
  const v = evaluate(p, 'Bash', { command: 'git status' });
  assert.equal(v.action, 'ask');
  assert.equal(v.rule, null);
  assert.equal(p.rules.filter((r) => r.name === 'git-readonly').length, 1);
});

test('project config: deny rule with message', () => {
  writeProjectConfig({
    rules: [{ name: 'no-prod', tool: 'Bash', match: 'kubectl.*prod', action: 'deny' }],
  });
  const p = loadPolicy(cwd);
  assert.equal(evaluate(p, 'Bash', { command: 'kubectl delete pod -n prod x' }).action, 'deny');
});

test('onUnmatched decider, but danger still goes to the human by default', () => {
  writeProjectConfig({ onUnmatched: 'decider', deciders: { default: { command: 'echo ALLOW' } } });
  const p = loadPolicy(cwd);
  assert.equal(evaluate(p, 'Bash', { command: 'npm install x' }).action, 'decider');
  assert.equal(evaluate(p, 'Bash', { command: 'rm -rf x' }).action, 'ask');
});

test('onDanger decider routes dangerous allows to the decider', () => {
  writeProjectConfig({ onDanger: 'decider', deciders: { default: { command: 'echo ASK' } } });
  const p = loadPolicy(cwd);
  // One command: matches git-readonly (allow), danger word 'delete' escalates.
  const v = evaluate(p, 'Bash', { command: 'git log --grep=delete' });
  assert.equal(v.action, 'decider');
  assert.equal(v.danger, true);
});

test('a second command is judged on its own, not covered by the first', () => {
  writeProjectConfig({ onDanger: 'decider', deciders: { default: { command: 'echo ASK' } } });
  const p = loadPolicy(cwd);
  // git status is allowed; git push matches no rule, so the human decides.
  const v = evaluate(p, 'Bash', { command: 'git status; git push' });
  assert.equal(v.action, 'ask');
  assert.deepEqual(v.segments, ['git status', 'git push']);
});

test('user config layers under project config', () => {
  fs.writeFileSync(
    path.join(home, 'config.json'),
    JSON.stringify({ rules: [{ name: 'u', tool: 'Bash', match: '^echo', action: 'allow' }], onUnmatched: 'decider' }),
  );
  writeProjectConfig({ onUnmatched: 'ask' });
  const p = loadPolicy(cwd);
  assert.equal(p.onUnmatched, 'ask');
  assert.equal(evaluate(p, 'Bash', { command: 'echo hi' }).rule.source, 'user');
});

test('mode defaults to policy', () => {
  const p = loadPolicy(cwd);
  assert.equal(p.mode, 'policy');
  assert.equal(p.modeSource, 'default');
  assert.equal(evaluate(p, 'Bash', { command: 'npm install x' }).mode, 'policy');
});

test('approve-all: everything is allowed, including danger and secrets', () => {
  writeProjectConfig({ mode: 'approve-all' });
  const p = loadPolicy(cwd);
  assert.equal(p.modeSource, 'project config');
  for (const [tool, input] of [
    ['Bash', { command: 'rm -rf build' }],
    ['Bash', { command: 'git push --force origin main' }],
    ['Edit', { file_path: 'C:/proj/.env' }],
    ['mcp__browser-devtools__launch_browser', { browserFamily: 'chromium' }],
    ['Bash', { command: 'npm install x' }],
  ]) {
    const v = evaluate(p, tool, input);
    assert.equal(v.action, 'allow', `${tool} ${JSON.stringify(input)}`);
    assert.equal(v.rule, null);
    assert.equal(v.mode, 'approve-all');
  }
  assert.equal(evaluate(p, 'Bash', { command: 'rm -rf build' }).danger, true, 'danger still reported for the log');
});

test('approve-all: explicit deny rules still win; ask/decider rules do not', () => {
  writeProjectConfig({
    mode: 'approve-all',
    onUnmatched: 'decider',
    deciders: { default: { command: 'echo ASK' } },
    rules: [
      { name: 'no-prod', tool: 'Bash', match: 'kubectl.*prod', action: 'deny' },
      { name: 'ask-me', tool: 'Bash', match: '^npm publish', action: 'ask' },
      { name: 'judge', tool: 'Bash', match: '^curl', action: 'decider' },
    ],
  });
  const p = loadPolicy(cwd);
  const denied = evaluate(p, 'Bash', { command: 'kubectl delete ns prod' });
  assert.equal(denied.action, 'deny');
  assert.equal(denied.rule.name, 'no-prod');
  assert.equal(evaluate(p, 'Bash', { command: 'npm publish' }).action, 'allow');
  assert.equal(evaluate(p, 'Bash', { command: 'curl https://x' }).action, 'allow');
});

test('mode precedence: env > stored override > project > user', () => {
  fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({ mode: 'approve-all' }));
  assert.equal(loadPolicy(cwd).modeSource, 'user config');
  writeProjectConfig({ mode: 'policy' });
  let p = loadPolicy(cwd);
  assert.equal(p.mode, 'policy');
  assert.equal(p.modeSource, 'project config');

  writeState({ mode: 'approve-all' });
  p = loadPolicy(cwd);
  assert.equal(p.mode, 'approve-all');
  assert.match(p.modeSource, /^override /);

  process.env.CCAUTO_MODE = 'policy';
  p = loadPolicy(cwd);
  assert.equal(p.mode, 'policy');
  assert.equal(p.modeSource, 'env CCAUTO_MODE');
  process.env.CCAUTO_MODE = '';
  assert.equal(loadPolicy(cwd).mode, 'approve-all', 'empty env var is ignored');

  writeState({ mode: undefined });
  assert.deepEqual(readState(), {});
  assert.equal(loadPolicy(cwd).modeSource, 'project config');
});

test('invalid mode is rejected wherever it comes from', () => {
  writeProjectConfig({ mode: 'yolo' });
  assert.throws(() => loadPolicy(cwd), /mode \(project config\) must be one of policy\|approve-all/);
  writeProjectConfig({});
  process.env.CCAUTO_MODE = 'nope';
  assert.throws(() => loadPolicy(cwd), /mode \(env CCAUTO_MODE\)/);
  delete process.env.CCAUTO_MODE;
});

test('invalid config is rejected', () => {
  writeProjectConfig({ rules: [{ name: 'bad', tool: 'Bash', match: '(', action: 'allow' }] });
  assert.throws(() => loadPolicy(cwd), /rule "bad"/);
  writeProjectConfig({ rules: [{ name: 'bad2', tool: 'Bash', action: 'yolo' }] });
  assert.throws(() => loadPolicy(cwd), /action must be one of/);
  writeProjectConfig({ onDanger: 'human' });
  assert.throws(() => loadPolicy(cwd), /onDanger/);
});
