import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadPolicy } from '../lib/policy.js';
import { decide, formatOutput } from '../lib/hook.js';
import { parseVerdict, buildPrompt } from '../lib/decider.js';

let cwd;
beforeEach(() => {
  process.env.CCAUTO_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'ccauto-home-'));
  cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'ccauto-cwd-'));
});

function projectConfig(obj) {
  fs.mkdirSync(path.join(cwd, '.ccauto'), { recursive: true });
  fs.writeFileSync(path.join(cwd, '.ccauto', 'config.json'), JSON.stringify(obj));
}

const ev = (tool_name, tool_input, hook_event_name = 'PermissionRequest') => ({
  hook_event_name,
  session_id: 's',
  cwd,
  tool_name,
  tool_input,
});

test('PermissionRequest: allow shape', () => {
  const out = formatOutput('PermissionRequest', { action: 'allow', rule: { name: 'r' }, danger: false });
  assert.deepEqual(out, {
    hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow' } },
  });
});

test('PermissionRequest: deny carries a message; ask emits nothing', () => {
  const out = formatOutput('PermissionRequest', { action: 'deny', rule: { name: 'no-prod' }, danger: false });
  assert.equal(out.hookSpecificOutput.decision.behavior, 'deny');
  assert.match(out.hookSpecificOutput.decision.message, /rule:no-prod/);
  assert.equal(formatOutput('PermissionRequest', { action: 'ask', rule: null, danger: true }), null);
});

test('approve-all verdicts say so in the reason', () => {
  const out = formatOutput('PreToolUse', { action: 'allow', rule: null, danger: true, mode: 'approve-all' });
  assert.match(out.hookSpecificOutput.permissionDecisionReason, /approve-all mode/);
  const deny = formatOutput('PermissionRequest', { action: 'deny', rule: { name: 'no-prod' }, danger: false, mode: 'approve-all' });
  assert.match(deny.hookSpecificOutput.decision.message, /approve-all mode; rule:no-prod/);
});

test('PreToolUse: permissionDecision shape, silent when nothing to say', () => {
  const out = formatOutput('PreToolUse', { action: 'allow', rule: { name: 'r' }, danger: false });
  assert.equal(out.hookSpecificOutput.hookEventName, 'PreToolUse');
  assert.equal(out.hookSpecificOutput.permissionDecision, 'allow');
  assert.match(out.hookSpecificOutput.permissionDecisionReason, /rule:r/);
  assert.equal(formatOutput('PreToolUse', { action: 'ask', rule: null, danger: false }), null);
  const asked = formatOutput('PreToolUse', { action: 'ask', rule: null, danger: true });
  assert.equal(asked.hookSpecificOutput.permissionDecision, 'ask');
});

test('decide: rules only, no decider involved', async () => {
  const p = loadPolicy(cwd);
  const { verdict, output } = await decide(ev('Bash', { command: 'git diff' }), p, {
    runDecider: async () => {
      throw new Error('must not be called');
    },
  });
  assert.equal(verdict.action, 'allow');
  assert.equal(output.hookSpecificOutput.decision.behavior, 'allow');
});

test('decide: decider verdicts map to hook output', async () => {
  projectConfig({ onUnmatched: 'decider', deciders: { default: { command: 'stub' } } });
  const p = loadPolicy(cwd);
  const calls = [];
  const stub = (action, reason = '') => async (command, event, opts) => {
    calls.push({ command, tool: event.tool_name, danger: opts.danger });
    return { action, reason, raw: `${action.toUpperCase()}${reason ? ': ' + reason : ''}` };
  };

  let r = await decide(ev('Bash', { command: 'npm install x' }), p, { runDecider: stub('allow') });
  assert.equal(r.output.hookSpecificOutput.decision.behavior, 'allow');
  assert.deepEqual(calls[0], { command: 'stub', tool: 'Bash', danger: false });

  r = await decide(ev('Bash', { command: 'npm install x' }), p, { runDecider: stub('deny', 'not needed') });
  assert.equal(r.output.hookSpecificOutput.decision.behavior, 'deny');
  assert.match(r.output.hookSpecificOutput.decision.message, /not needed/);

  r = await decide(ev('Bash', { command: 'npm install x' }), p, { runDecider: stub('ask') });
  assert.equal(r.output, null);
  assert.equal(r.verdict.action, 'ask');
});

test('decide: decider action without a configured command falls back to ask', async () => {
  projectConfig({ rules: [{ name: 'd', tool: 'Bash', action: 'decider', decider: 'missing' }] });
  const p = loadPolicy(cwd);
  const { verdict, output } = await decide(ev('Bash', { command: 'anything' }), p);
  assert.equal(verdict.action, 'ask');
  assert.match(verdict.note, /missing/);
  assert.equal(output, null);
});

test('parseVerdict', () => {
  assert.deepEqual(parseVerdict('ALLOW\n'), { action: 'allow', reason: '', raw: 'ALLOW' });
  assert.equal(parseVerdict('some preamble\nDENY: touches prod').action, 'deny');
  assert.equal(parseVerdict('DENY: touches prod').reason, 'touches prod');
  assert.equal(parseVerdict('allow').action, 'allow');
  assert.equal(parseVerdict('I think this is fine.').action, 'ask');
  assert.equal(parseVerdict('').action, 'ask');
});

test('buildPrompt includes the call and the caution only when dangerous', () => {
  const e = ev('Bash', { command: 'git push' });
  assert.match(buildPrompt(e, { danger: true }), /CAUTION/);
  assert.doesNotMatch(buildPrompt(e, { danger: false }), /CAUTION/);
  assert.match(buildPrompt(e), /"command": "git push"/);
});
