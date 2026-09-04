import { spawn } from 'node:child_process';

// Ask an external command (a script, or an LLM CLI such as `claude -p`)
// whether a tool call may run without a human. The prompt goes to the
// command's stdin; it prints exactly one directive line.

export const INSTRUCTIONS = `You are the permission gate for an AI coding agent (Claude Code) working in a developer's repository.
The agent wants to run the tool call described below. Decide whether it may run WITHOUT asking the human.

Reply with EXACTLY ONE line and nothing else, in one of these forms:
ALLOW            the action is clearly safe, reversible, and expected for ordinary development work
DENY: <reason>   the action is clearly wrong or harmful; the agent will be shown <reason> and will try something else
ASK              anything else: unsure, destructive, touches secrets or credentials, leaves the working directory, network side effects

Prefer ASK over a wrong ALLOW.`;

export const DANGER_CAUTION = `CAUTION: the call below contains potentially destructive wording (delete/remove/force/push/reset ...).
Reply ALLOW only if the action is unambiguously safe in this context; when in doubt, reply ASK.`;

export function buildPrompt(event, { danger = false } = {}) {
  const lines = [INSTRUCTIONS, ''];
  if (danger) lines.push(DANGER_CAUTION, '');
  lines.push(
    '--- tool call ---',
    `cwd: ${event.cwd ?? '(unknown)'}`,
    `tool: ${event.tool_name ?? '(unknown)'}`,
    `input: ${JSON.stringify(event.tool_input ?? {}, null, 2)}`,
    '',
  );
  return lines.join('\n');
}

export function parseVerdict(out) {
  const text = String(out ?? '');
  const line = text
    .split(/\r?\n/)
    .map((s) => s.trim())
    .find((l) => /^(ALLOW|DENY|ASK)\b/i.test(l));
  if (!line) {
    return { action: 'ask', reason: 'decider gave no verdict', raw: text.trim().slice(0, 300) };
  }
  const m = /^(ALLOW|DENY|ASK)\b[:\s-]*(.*)$/i.exec(line);
  return { action: m[1].toLowerCase(), reason: m[2].trim(), raw: line.slice(0, 300) };
}

export function runCommand(command, input, { timeoutMs = 45000, env = {} } = {}) {
  return new Promise((resolve) => {
    let out = '';
    let err = '';
    let done = false;
    const finish = (extra) => {
      if (done) return;
      done = true;
      resolve({ out, err, ...extra });
    };
    let child;
    try {
      child = spawn(command, {
        shell: true,
        env: { ...process.env, ...env },
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
      });
    } catch (e) {
      return finish({ error: String(e) });
    }
    const timer = setTimeout(() => {
      try {
        child.kill();
      } catch {}
      finish({ timedOut: true });
    }, timeoutMs);
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (err += d));
    child.on('error', (e) => {
      clearTimeout(timer);
      finish({ error: String(e) });
    });
    child.on('close', () => {
      clearTimeout(timer);
      finish({});
    });
    child.stdin.on('error', () => {});
    child.stdin.end(input);
  });
}

// CCAUTO_HOOK=1 marks the decider's own environment so that, if the decider
// is itself a Claude Code session, a nested `ccauto hook` exits without
// deciding anything (see bin/ccauto.js). No built-in recursion guard exists
// on the Claude Code side.
export async function askDecider(command, event, { danger = false, timeoutMs = 45000 } = {}) {
  const prompt = buildPrompt(event, { danger });
  const res = await runCommand(command, prompt, { timeoutMs, env: { CCAUTO_HOOK: '1' } });
  const verdict = res.timedOut
    ? { action: 'ask', reason: 'decider timed out', raw: '(timeout)' }
    : res.error
      ? { action: 'ask', reason: `decider failed: ${res.error}`, raw: '(error)' }
      : parseVerdict(res.out);
  return {
    ...verdict,
    command,
    timedOut: !!res.timedOut,
    stderr: res.err?.trim() ? res.err.trim().slice(0, 300) : undefined,
  };
}
