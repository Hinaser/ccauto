import fs from 'node:fs';
import path from 'node:path';
import { ccautoHome } from './policy.js';

export function logPath(policy) {
  return policy?.log?.file || path.join(ccautoHome(), 'log.jsonl');
}

// One previous generation is kept alongside the live file.
export function rotatedPath(file) {
  return `${file}.1`;
}

function maxBytesOf(policy) {
  const n = Number(policy?.log?.maxBytes);
  return Number.isFinite(n) && n > 0 ? n : 0; // 0 -> never rotate
}

// Keep the log from growing without bound: once it passes maxBytes the live
// file becomes <file>.1, replacing the previous generation, and a fresh file
// starts. Two generations is enough to answer "what did it just approve?"
// without turning into an archive nobody prunes.
export function rotateIfNeeded(policy, file = logPath(policy)) {
  const max = maxBytesOf(policy);
  if (!max) return false;
  let size;
  try {
    size = fs.statSync(file).size;
  } catch {
    return false; // no log yet
  }
  if (size < max) return false;
  try {
    fs.rmSync(rotatedPath(file), { force: true });
    fs.renameSync(file, rotatedPath(file));
    return true;
  } catch {
    return false;
  }
}

// Every hook invocation appends one line. This is the only window into what
// the hook did, since Claude Code shows nothing when a hook approves.
export function appendLog(policy, entry) {
  if (policy?.log?.enabled === false) return;
  try {
    const file = logPath(policy);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    rotateIfNeeded(policy, file);
    fs.appendFileSync(file, JSON.stringify(entry) + '\n');
  } catch {
    // never let logging break a permission decision
  }
}

// Read the last bytes of a file without loading the whole thing. The first
// line of the window is dropped unless we started at the beginning, since it
// is probably a fragment.
function tailLines(file, bytes) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const size = fs.fstatSync(fd).size;
    const from = Math.max(0, size - bytes);
    const buf = Buffer.alloc(size - from);
    fs.readSync(fd, buf, 0, buf.length, from);
    const lines = buf.toString('utf8').split(/\r?\n/).filter(Boolean);
    return from > 0 ? lines.slice(1) : lines;
  } catch {
    return [];
  } finally {
    if (fd !== undefined) try { fs.closeSync(fd); } catch {}
  }
}

const parse = (l) => {
  try {
    return JSON.parse(l);
  } catch {
    return { raw: l };
  }
};

export function readLog(policy, n = 20) {
  const file = logPath(policy);
  // Enough for n entries at any plausible size, without reading a large log.
  const window = Math.max(64 * 1024, n * 4096);
  let lines = tailLines(file, window);
  // Just after a rotation the live file is short; top up from the previous
  // generation so `ccauto log` does not appear to lose history.
  if (lines.length < n) {
    lines = [...tailLines(rotatedPath(file), window), ...lines];
  }
  return lines.slice(-n).map(parse);
}
