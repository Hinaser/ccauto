#!/usr/bin/env node
import { loadPolicy, MODES, statePath, writeState, parseDuration, formatRemaining, readState, storedMode } from '../lib/policy.js';
import { decide } from '../lib/hook.js';
import { appendLog, readLog, logPath } from '../lib/log.js';
import { install, uninstall, installStatus, settingsPath } from '../lib/install.js';

const USAGE = `ccauto: answer Claude Code's permission prompts for the calls you
trust, and let everything else prompt as usual.

Modes:
  policy (default)        your rules decide, first match wins
  approve-except-deletes  approve everything, but ask before anything that
                          removes files
  approve-all             approve everything except explicit deny rules

  ccauto install                    Register the hook in ~/.claude/settings.json (every session loads it)
  ccauto uninstall                  Remove it again
  ccauto hook                       Claude Code hook entry point (reads the event JSON on stdin)
  ccauto check <tool> [text]        Dry run: what would ccauto answer for this call? Runs nothing.
                                      text = command for Bash/PowerShell, file path for Edit/Write/Read,
                                      JSON object for anything else
  ccauto check --json '<event>'     Dry-run on a full hook event JSON
        --run                       also run the decider when the verdict is "decider"
  ccauto mode                       Which mode is in effect, and what set it
  ccauto mode approve-except-deletes  Approve everything, but ask before deletions
  ccauto mode approve-all           Approve every prompt except explicit deny rules (all sessions)
  ccauto mode approve-all --for 30m Same, but it expires by itself (s|m|h|d)
  ccauto mode policy                Back to rules
  ccauto mode reset                 Drop the stored override; config decides again
  ccauto config                     The rules in effect, in order, after merging config with built-ins
  ccauto log [-n N]                 What ccauto decided recently (default 20); approvals show nowhere else

Config: ~/.ccauto/config.json (or $CCAUTO_HOME/config.json), then <cwd>/.ccauto/config.json.
Mode:   CCAUTO_MODE env > ccauto mode override > config "mode" > policy.
        CCAUTO_MODE=approve-all claude   turns it on for one session only.
Log:    ~/.ccauto/log.jsonl

Nothing here has any effect in a Claude Code session that did not load the hook:
run "ccauto install" once, or start claude with --plugin-dir <this repo>.
`;

function hookStatusLine() {
  const st = installStatus();
  if (st.error) return `hook:    cannot read ${st.file}: ${st.error}`;
  if (!st.installed) return `hook:    NOT installed in ${st.file}  (run "ccauto install")`;
  return `hook:    installed in ${st.file}${st.stale ? '  (points at a different copy of ccauto; "ccauto install" repoints it)' : ''}`;
}

function warnIfNotInstalled() {
  const st = installStatus();
  if (st.installed && !st.stale) return;
  process.stdout.write(
    st.installed
      ? `warning: the hook in ${st.file} points at a different copy of ccauto; run "ccauto install" to repoint it\n`
      : `warning: the hook is not installed in ${st.file}; sessions started without --plugin-dir ignore ccauto entirely. Run "ccauto install".\n`,
  );
}

async function readStdin() {
  const chunks = [];
  for await (const c of process.stdin) chunks.push(c);
  return Buffer.concat(chunks).toString('utf8');
}

function summarize(event, verdict, output, ms) {
  return {
    ts: new Date().toISOString(),
    session: event.session_id,
    event: event.hook_event_name,
    tool: event.tool_name,
    target: String(verdict.target ?? '').slice(0, 300),
    mode: verdict.mode,
    action: verdict.action,
    rule: verdict.rule?.name ?? verdict.rule?.match ?? null,
    danger: verdict.danger,
    escalated: verdict.escalated || undefined,
    decider: verdict.deciderVerdict
      ? {
          name: verdict.deciderName,
          raw: verdict.deciderVerdict.raw,
          timedOut: verdict.deciderVerdict.timedOut || undefined,
          stderr: verdict.deciderVerdict.stderr,
        }
      : undefined,
    note: verdict.note,
    emitted: !!output,
    ms,
    cwd: event.cwd,
  };
}

// Hook contract: exit 0 always. Print JSON only when we have a decision;
// print nothing to let Claude Code show its normal dialog. Errors are logged
// and fall through to the dialog (fail open to the human, never to "allow").
async function cmdHook() {
  if (process.env.CCAUTO_HOOK) return; // we are inside our own decider
  if (process.stdin.isTTY) {
    process.stderr.write('ccauto hook: expects a hook event JSON on stdin\n');
    return;
  }
  const started = Date.now();
  let event;
  try {
    event = JSON.parse(await readStdin());
  } catch (e) {
    appendLog(null, { ts: new Date().toISOString(), error: `bad stdin: ${e.message}` });
    return;
  }
  let policy;
  try {
    policy = loadPolicy(event.cwd || process.cwd());
  } catch (e) {
    appendLog(null, { ts: new Date().toISOString(), error: e.message, tool: event.tool_name });
    process.stderr.write(`ccauto: ${e.message}\n`);
    return;
  }
  try {
    const { verdict, output } = await decide(event, policy);
    appendLog(policy, summarize(event, verdict, output, Date.now() - started));
    if (output) process.stdout.write(JSON.stringify(output));
  } catch (e) {
    appendLog(policy, { ts: new Date().toISOString(), error: String(e?.stack || e), tool: event.tool_name });
  }
}

function eventFromArgs(args) {
  const run = args.includes('--run');
  const rest = args.filter((a) => a !== '--run');
  if (rest[0] === '--json') {
    if (!rest[1]) throw new Error('--json needs an event JSON argument');
    return { event: JSON.parse(rest[1]), run };
  }
  const [tool, ...textParts] = rest;
  if (!tool) throw new Error('check needs a tool name');
  const text = textParts.join(' ');
  let tool_input = {};
  if (tool === 'Bash' || tool === 'PowerShell') tool_input = { command: text };
  else if (['Edit', 'Write', 'Read', 'MultiEdit'].includes(tool)) tool_input = { file_path: text };
  else if (tool === 'NotebookEdit') tool_input = { notebook_path: text };
  else if (text) {
    try {
      tool_input = JSON.parse(text);
    } catch {
      tool_input = { input: text };
    }
  }
  return {
    event: {
      hook_event_name: 'PermissionRequest',
      session_id: 'ccauto-check',
      cwd: process.cwd(),
      tool_name: tool,
      tool_input,
    },
    run,
  };
}

async function cmdCheck(args) {
  const { event, run } = eventFromArgs(args);
  const policy = loadPolicy(event.cwd || process.cwd());
  const runDecider = run
    ? undefined
    : async (command) => ({ action: 'decider', reason: '', raw: `(dry run; would run: ${command})`, command });
  const { verdict, output } = await decide(event, policy, runDecider ? { runDecider } : {});
  const lines = [
    `mode:    ${policy.mode} (${policy.modeSource})`,
    `tool:    ${event.tool_name}`,
    `target:  ${verdict.target}`,
    `action:  ${verdict.action}${verdict.escalated ? ' (escalated by danger words)' : ''}`,
    `rule:    ${verdict.rule ? `${verdict.rule.name ?? verdict.rule.match} [${verdict.rule.source}]` : '(none)'}`,
    `danger:  ${verdict.danger}`,
  ];
  if (verdict.segments?.length > 1) {
    lines.push('commands:');
    for (const j of verdict.judged ?? []) {
      lines.push(`  ${(j.action ?? '').padEnd(7)} ${j.segment}${j.note ? `  (${j.note})` : ''}`);
    }
    lines.push('         strictest verdict wins');
  }
  if (verdict.deciderVerdict) lines.push(`decider: ${verdict.deciderVerdict.raw}`);
  if (verdict.note) lines.push(`note:    ${verdict.note}`);
  lines.push('', output ? `hook stdout:\n${JSON.stringify(output, null, 2)}` : 'hook stdout: (nothing; Claude Code shows the dialog)');
  process.stdout.write(lines.join('\n') + '\n');
}

function cmdConfig() {
  const policy = loadPolicy(process.cwd());
  const { sources } = policy;
  const out = [
    `user config:    ${sources.userPath}${sources.user ? '' : ' (absent)'}`,
    `project config: ${sources.projectPath}${sources.project ? '' : ' (absent)'}`,
    `log:            ${logPath(policy)}${policy.log.enabled === false ? ' (disabled)' : ''}`,
    hookStatusLine().replace(/^hook:\s+/, 'hook:           '),
    `mode:           ${policy.mode}  (${policy.modeSource})`,
    `dangerScope:    ${policy.dangerScope}`,
    `onDanger:       ${policy.onDanger}`,
    `onUnmatched:    ${policy.onUnmatched}`,
    `deciders:       ${Object.keys(policy.deciders).length ? Object.entries(policy.deciders).map(([k, v]) => `${k} = ${v.command}`).join(', ') : '(none)'}`,
    `dangerWords:    ${policy.dangerWords.length}`,
    `deletionWords:  ${policy.deletionWords.length}`,
    '',
    'rules (first match wins):',
  ];
  for (const r of policy.rules) {
    const flag = r.disabled ? ' DISABLED' : '';
    out.push(`  ${(r.action ?? '').padEnd(7)} ${(r.tool ?? '*').padEnd(24)} ${r.name ?? ''}${flag}  [${r.source}]`);
    const subject = r.field != null ? `field ${r.field}` : (r.scope ?? 'target');
    if (r.match) out.push(`          ${subject} =~ /${r.match}/${r.flags ?? ''}`);
    else if (r.field != null) out.push(`          ${subject} is present`);
  }
  process.stdout.write(out.join('\n') + '\n');
}

function cmdLog(args) {
  const i = args.indexOf('-n');
  const n = i >= 0 ? Number(args[i + 1]) || 20 : 20;
  let policy = null;
  try {
    policy = loadPolicy(process.cwd());
  } catch {}
  const entries = readLog(policy, n);
  if (!entries.length) {
    process.stdout.write(`(no entries in ${logPath(policy)})\n`);
    return;
  }
  for (const e of entries) {
    if (e.error) {
      process.stdout.write(`${e.ts}  ERROR ${e.error}\n`);
      continue;
    }
    const via = e.decider ? ` decider=${JSON.stringify(e.decider.raw)}` : e.rule ? ` rule=${e.rule}` : '';
    const dz = e.danger ? ' danger' : '';
    const mode = e.mode && e.mode !== 'policy' ? ` [${e.mode}]` : '';
    process.stdout.write(`${e.ts}  ${String(e.action).padEnd(5)} ${e.tool}  ${JSON.stringify(e.target)}${via}${dz}${mode} ${e.emitted ? '' : '(dialog)'} ${e.ms}ms\n`);
  }
}

function modeStatusLine(p) {
  const left = p.modeExpiresAt ? Date.parse(p.modeExpiresAt) - Date.now() : null;
  const suffix = left != null && !Number.isNaN(left) ? `, expires in ${formatRemaining(left)}` : '';
  return `${p.mode}  (${p.modeSource}${suffix})`;
}

// An override whose expiry has passed is already ignored by loadPolicy; drop
// it from state.json when we happen to notice, so the file stays honest.
function tidyExpiredOverride() {
  const state = readState();
  if (state.mode && !storedMode(state)) writeState({ mode: undefined, modeExpiresAt: undefined });
}

function cmdMode(args) {
  const forIdx = args.findIndex((x) => x === '--for');
  let ttlMs = null;
  if (forIdx >= 0) {
    const spec = args[forIdx + 1];
    ttlMs = parseDuration(spec);
    if (!ttlMs) throw new Error(`--for needs a duration like 30m, 2h, 90s or 1h30m (got ${spec ?? '(nothing)'})`);
    args = args.filter((_, i) => i !== forIdx && i !== forIdx + 1);
  }
  const [value] = args;

  if (value === undefined) {
    if (forIdx >= 0) throw new Error('--for needs a mode: ccauto mode approve-all --for 30m');
    tidyExpiredOverride();
    const p = loadPolicy(process.cwd());
    process.stdout.write(`${modeStatusLine(p)}\n${hookStatusLine()}\n`);
    return;
  }
  if (value === 'reset') {
    writeState({ mode: undefined, modeExpiresAt: undefined });
    const p = loadPolicy(process.cwd());
    process.stdout.write(`override cleared; mode is now ${p.mode} (${p.modeSource})\n`);
    return;
  }
  if (!MODES.includes(value)) {
    throw new Error(`mode must be one of ${MODES.join('|')}, or reset`);
  }

  // An expiry is opt-in: without --for the override stays until reset, as before.
  const expiresAt = ttlMs ? new Date(Date.now() + ttlMs).toISOString() : undefined;
  writeState({ mode: value, modeExpiresAt: expiresAt });
  const p = loadPolicy(process.cwd());
  process.stdout.write(
    ttlMs
      ? `mode ${value} stored in ${statePath()} for ${formatRemaining(ttlMs)} (until ${expiresAt}), then the config decides again\n`
      : `mode ${value} stored in ${statePath()} (all sessions, until "ccauto mode reset")\n`,
  );
  if (value === 'approve-all') {
    process.stdout.write('every permission prompt will now be approved, except calls matching a deny rule\n');
    if (!ttlMs) process.stdout.write('tip: "--for 30m" makes it expire on its own, so you cannot leave it on by accident\n');
  }
  if (value === 'approve-except-deletes') {
    process.stdout.write('deletions and secrets still stop and ask; everything else is approved\n');
    if (!ttlMs) process.stdout.write('tip: "--for 30m" makes it expire on its own\n');
  }
  if (p.modeSource.startsWith('env')) {
    process.stdout.write(`note: CCAUTO_MODE=${process.env.CCAUTO_MODE} overrides this in the current shell\n`);
  }
  warnIfNotInstalled();
}

function cmdInstall() {
  const r = install();
  if (!r.changed) {
    process.stdout.write(`already installed in ${r.file}\n  ${r.command}\n`);
  } else if (r.updated) {
    process.stdout.write(`repointed the hook in ${r.file}\n  ${r.command}\n`);
  } else {
    process.stdout.write(`installed PermissionRequest hook in ${r.file}\n  ${r.command}\n`);
  }
  process.stdout.write('new sessions load it at start; a running session picks it up after /hooks is opened once or on restart\n');
}

function cmdUninstall() {
  const r = uninstall();
  process.stdout.write(
    r.changed ? `removed ${r.removed} hook entr${r.removed === 1 ? 'y' : 'ies'} from ${r.file}\n` : `nothing to remove in ${r.file}\n`,
  );
}

async function main() {
  const [cmd, ...args] = process.argv.slice(2);
  try {
    switch (cmd) {
      case 'hook':
        return await cmdHook();
      case 'check':
        return await cmdCheck(args);
      case 'install':
        return cmdInstall();
      case 'uninstall':
        return cmdUninstall();
      case 'mode':
        return cmdMode(args);
      case 'config':
        return cmdConfig();
      case 'log':
        return cmdLog(args);
      case undefined:
      case '-h':
      case '--help':
      case 'help':
        process.stdout.write(USAGE);
        return;
      default:
        process.stderr.write(`ccauto: unknown command "${cmd}"\n\n${USAGE}`);
        process.exitCode = 2;
    }
  } catch (e) {
    process.stderr.write(`ccauto: ${e.message}\n`);
    process.exitCode = 2;
  }
}

main();
