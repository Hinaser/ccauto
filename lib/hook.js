import { evaluate } from './policy.js';
import { askDecider } from './decider.js';

export function reasonOf(v) {
  const parts = [];
  if (v.mode === 'approve-all') parts.push('approve-all mode');
  parts.push(v.rule ? `rule:${v.rule.name ?? v.rule.match}` : 'no rule matched');
  if (v.danger) parts.push('danger words present');
  if (v.deciderVerdict) parts.push(`decider said ${v.deciderVerdict.raw}`);
  if (v.note) parts.push(v.note);
  return `ccauto: ${parts.join('; ')}`;
}

// Translate a verdict into the hook's stdout JSON. `null` means print
// nothing: Claude Code then proceeds as if no hook existed, i.e. it shows
// the normal permission dialog. That is the fail-safe path for `ask`.
export function formatOutput(eventName, v) {
  const reason = reasonOf(v);

  if (eventName === 'PreToolUse') {
    // Unmatched, no danger, nothing to say: stay silent.
    if (v.action === 'ask' && !v.rule && !v.danger && !v.deciderVerdict) return null;
    return {
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: v.action,
        permissionDecisionReason: reason,
      },
    };
  }

  if (v.action === 'allow') {
    return {
      hookSpecificOutput: {
        hookEventName: 'PermissionRequest',
        decision: { behavior: 'allow' },
      },
    };
  }
  if (v.action === 'deny') {
    const detail = v.deciderVerdict?.reason ? `${reason}: ${v.deciderVerdict.reason}` : reason;
    return {
      hookSpecificOutput: {
        hookEventName: 'PermissionRequest',
        decision: { behavior: 'deny', message: detail },
      },
    };
  }
  return null;
}

// Full pipeline for one hook event: rules, then (if a rule or the fallback
// says so) the decider, then the output shape for the event that fired.
export async function decide(event, policy, { runDecider = askDecider } = {}) {
  const toolName = event.tool_name ?? '';
  const input = event.tool_input ?? {};
  let v = evaluate(policy, toolName, input);

  if (v.action === 'decider') {
    const name = v.decider ?? 'default';
    const command = policy.deciders?.[name]?.command;
    if (!command) {
      v = { ...v, action: 'ask', note: `decider "${name}" is not configured` };
    } else {
      const dv = await runDecider(command, event, {
        danger: v.danger,
        timeoutMs: (policy.deciderTimeoutSec ?? 45) * 1000,
      });
      v = { ...v, action: dv.action, deciderVerdict: dv, deciderName: name };
    }
  }

  const eventName = event.hook_event_name ?? 'PermissionRequest';
  return { verdict: v, output: formatOutput(eventName, v) };
}
