import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Register (or remove) the PermissionRequest hook in Claude Code's user
// settings, so every session loads it without --plugin-dir.

export function claudeConfigDir() {
  return process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
}

export function settingsPath() {
  return path.join(claudeConfigDir(), 'settings.json');
}

export function binPath() {
  return fileURLToPath(new URL('../bin/ccauto.js', import.meta.url)).replace(/\\/g, '/');
}

// Where is this copy of ccauto running from? A git checkout stays put, so
// recording its absolute path is fine. An installed package moves (npm
// upgrade, a node version switch under nvm/fnm), and npx's cache is deleted
// outright -- both would strand the path we wrote into settings.json.
export function installKind(bin = binPath()) {
  if (/\/_npx\//.test(bin)) return 'npx';
  if (/\/node_modules\//.test(bin)) return 'package';
  return 'checkout';
}

// Does a `ccauto` launcher exist on PATH? `npm i -g` puts one there, and
// calling it by name survives the package moving underneath us.
export function binOnPath(env = process.env) {
  const raw = env.PATH ?? env.Path ?? '';
  const names = process.platform === 'win32' ? ['ccauto.cmd', 'ccauto.exe', 'ccauto.ps1', 'ccauto'] : ['ccauto'];
  return raw
    .split(path.delimiter)
    .filter(Boolean)
    .some((dir) =>
      names.some((name) => {
        try {
          return fs.statSync(path.join(dir, name)).isFile();
        } catch {
          return false;
        }
      }),
    );
}

export function hookCommand(bin = binPath()) {
  if (installKind(bin) === 'package' && binOnPath()) return 'ccauto hook';
  return `node "${bin}" hook`;
}

// Recognise our own entries whatever form they were installed in:
// `node "<path>/bin/ccauto.js" hook` and a bare `ccauto hook` are both ours.
const MARKER = /(^|[/\\"'\s])ccauto(\.js)?["']?\s+hook\b/;

export function isOurs(hook) {
  return hook?.type === 'command' && typeof hook.command === 'string' && MARKER.test(hook.command);
}

export function readSettings(file = settingsPath()) {
  if (!fs.existsSync(file)) return { settings: {}, existed: false };
  const text = fs.readFileSync(file, 'utf8');
  if (!text.trim()) return { settings: {}, existed: true };
  let settings;
  try {
    settings = JSON.parse(text);
  } catch (e) {
    throw new Error(`${file} is not valid JSON (${e.message}); fix it by hand first, ccauto will not overwrite it`);
  }
  if (!settings || typeof settings !== 'object' || Array.isArray(settings)) {
    throw new Error(`${file}: top level must be an object`);
  }
  return { settings, existed: true };
}

function writeSettings(file, settings) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(settings, null, 2) + '\n');
}

const NPX_REFUSAL =
  'running under npx: the hook would point into npm\'s npx cache, which npm deletes later, ' +
  'leaving a dead entry in settings.json. Install it for real first:\n  npm install -g ccauto\n  ccauto install';

export function installStatus(file = settingsPath(), bin = binPath()) {
  try {
    const { settings } = readSettings(file);
    const groups = Array.isArray(settings.hooks?.PermissionRequest) ? settings.hooks.PermissionRequest : [];
    const ours = groups.flatMap((g) => g.hooks ?? []).filter(isOurs);
    return {
      file,
      kind: installKind(bin),
      installed: ours.length > 0,
      commands: ours.map((h) => h.command),
      stale: ours.some((h) => h.command !== hookCommand(bin)),
    };
  } catch (e) {
    return { file, kind: installKind(bin), installed: false, commands: [], stale: false, error: e.message };
  }
}

// Idempotent: adds our hook if missing, repoints it if this copy of ccauto
// moved or changed form, leaves everything else in the file untouched.
export function install({ file = settingsPath(), timeout = 60, bin = binPath() } = {}) {
  if (installKind(bin) === 'npx') throw new Error(NPX_REFUSAL);
  const { settings } = readSettings(file);
  const hooks = settings.hooks && typeof settings.hooks === 'object' ? settings.hooks : {};
  const groups = Array.isArray(hooks.PermissionRequest) ? hooks.PermissionRequest : [];
  const command = hookCommand(bin);

  const ours = groups.flatMap((g) => g.hooks ?? []).filter(isOurs);
  if (ours.length) {
    const stale = ours.filter((h) => h.command !== command);
    if (!stale.length) return { file, changed: false, command };
    for (const h of stale) h.command = command;
    settings.hooks = { ...hooks, PermissionRequest: groups };
    writeSettings(file, settings);
    return { file, changed: true, updated: true, command };
  }

  groups.push({ hooks: [{ type: 'command', command, timeout }] });
  settings.hooks = { ...hooks, PermissionRequest: groups };
  writeSettings(file, settings);
  return { file, changed: true, command };
}

export function uninstall({ file = settingsPath() } = {}) {
  const { settings, existed } = readSettings(file);
  if (!existed) return { file, changed: false, removed: 0 };
  const groups = settings.hooks?.PermissionRequest;
  if (!Array.isArray(groups)) return { file, changed: false, removed: 0 };

  let removed = 0;
  const kept = groups
    .map((g) => {
      const hs = (g.hooks ?? []).filter((h) => {
        if (isOurs(h)) {
          removed++;
          return false;
        }
        return true;
      });
      return { ...g, hooks: hs };
    })
    .filter((g) => g.hooks.length > 0);
  if (!removed) return { file, changed: false, removed: 0 };

  if (kept.length) settings.hooks.PermissionRequest = kept;
  else delete settings.hooks.PermissionRequest;
  if (Object.keys(settings.hooks).length === 0) delete settings.hooks;
  writeSettings(file, settings);
  return { file, changed: true, removed };
}
