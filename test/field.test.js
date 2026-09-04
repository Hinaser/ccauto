// `field`: match one named input field instead of a whole subject, and the
// read-only database policy it exists to make writable.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { evaluate, loadPolicy, fieldValue } from '../lib/policy.js';

let cwd;

function writeConfig(obj) {
  fs.mkdirSync(path.join(cwd, '.ccauto'), { recursive: true });
  fs.writeFileSync(path.join(cwd, '.ccauto', 'config.json'), JSON.stringify(obj));
  return loadPolicy(cwd);
}

beforeEach(() => {
  process.env.CCAUTO_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'ccauto-home-'));
  cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'ccauto-cwd-'));
  delete process.env.CCAUTO_MODE;
});

// --- the selector --------------------------------------------------------

test('fieldValue walks a dotted path and stops at anything missing', () => {
  const input = { sql: 'SELECT 1', params: { query: 'x', n: 3, flag: false }, list: [1, 2] };
  assert.equal(fieldValue(input, 'sql'), 'SELECT 1');
  assert.equal(fieldValue(input, 'params.query'), 'x');
  assert.equal(fieldValue(input, 'params.n'), 3);
  assert.equal(fieldValue(input, 'params.flag'), false);
  assert.deepEqual(fieldValue(input, 'list'), [1, 2]);
  assert.equal(fieldValue(input, 'nope'), undefined);
  assert.equal(fieldValue(input, 'params.deep.deeper'), undefined);
  assert.equal(fieldValue(input, 'sql.length'), undefined, 'does not walk into a string');
  assert.equal(fieldValue(null, 'sql'), undefined);
});

test('a rule can match one field instead of the whole input', () => {
  const p = writeConfig({
    rules: [{ name: 'sql-read', tool: 'mcp__db__query', field: 'sql', match: '^\\s*select\\b', flags: 'i', action: 'allow' }],
  });
  assert.equal(evaluate(p, 'mcp__db__query', { sql: 'SELECT 1' }).action, 'allow');
  assert.equal(evaluate(p, 'mcp__db__query', { sql: 'DELETE FROM t' }).action, 'ask');
});

test('a field that is not there cannot match', () => {
  const p = writeConfig({
    rules: [{ name: 'any-sql', tool: 'mcp__db__*', field: 'sql', action: 'allow' }],
  });
  assert.equal(evaluate(p, 'mcp__db__query', { sql: 'anything at all' }).action, 'allow', 'no match: the field existing is enough');
  const v = evaluate(p, 'mcp__db__list_tables', { schema: 'public' });
  assert.equal(v.action, 'ask');
  assert.equal(v.rule, null);
});

test('a non-string field is matched as JSON', () => {
  const p = writeConfig({
    rules: [{ name: 'by-opts', tool: 'mcp__x__y', field: 'opts', match: '"force":true', action: 'deny' }],
  });
  assert.equal(evaluate(p, 'mcp__x__y', { opts: { force: true } }).action, 'deny');
  assert.equal(evaluate(p, 'mcp__x__y', { opts: { force: false } }).action, 'ask');
});

test('field beats regexing the JSON, which is what it is for', () => {
  // Escaping inside the serialised input is exactly what goes wrong by hand.
  const p = writeConfig({
    rules: [{ name: 'sql-read', tool: 'mcp__db__query', field: 'sql', match: '^select ', flags: 'i', action: 'allow' }],
  });
  assert.equal(evaluate(p, 'mcp__db__query', { sql: 'select "a\\b" from t' }).action, 'allow');
});

test('field and scope are mutually exclusive, and field must be a string', () => {
  assert.throws(
    () => writeConfig({ rules: [{ name: 'bad', tool: '*', field: 'sql', scope: 'input', match: 'x', action: 'allow' }] }),
    /use either field or scope/,
  );
  assert.throws(
    () => writeConfig({ rules: [{ name: 'bad', tool: '*', field: '', match: 'x', action: 'allow' }] }),
    /field must be a non-empty string/,
  );
  assert.throws(
    () => writeConfig({ rules: [{ name: 'bad', tool: '*', field: 3, match: 'x', action: 'allow' }] }),
    /field must be a non-empty string/,
  );
});

// --- the recipe it exists for -------------------------------------------

const DB_RULES = [
  {
    name: 'db-write-veto',
    tool: 'mcp__postgres__*|mcp__mysql__*|mcp__sqlite__*',
    field: 'sql',
    flags: 'i',
    match:
      '\\b(insert|update|delete|drop|truncate|alter|create|grant|revoke|replace|merge|upsert|vacuum|reindex|call|do|lock)\\b|select[\\s\\S]*\\binto\\b|pg_read_file|pg_write|lo_import|lo_export',
    action: 'ask',
  },
  {
    name: 'db-read-ok',
    tool: 'mcp__postgres__*|mcp__mysql__*|mcp__sqlite__*',
    field: 'sql',
    flags: 'i',
    match: '^\\s*\\(*\\s*(select|show|explain|describe|desc|with|pragma)\\b',
    action: 'allow',
  },
];

const withDb = () => writeConfig({ rules: DB_RULES });

test('read-only statements are approved', () => {
  const p = withDb();
  for (const sql of ['SELECT * FROM users', '   select 1', 'SHOW TABLES', 'EXPLAIN SELECT * FROM t', 'PRAGMA table_info(t)']) {
    assert.equal(evaluate(p, 'mcp__postgres__query', { sql }).action, 'allow', sql);
  }
});

test('mutating statements ask', () => {
  const p = withDb();
  for (const sql of ['DELETE FROM users', 'UPDATE users SET x = 1', 'DROP TABLE users', 'INSERT INTO t VALUES (1)', 'ALTER TABLE t ADD c int']) {
    assert.equal(evaluate(p, 'mcp__postgres__query', { sql }).action, 'ask', sql);
  }
});

test('statements that only look read-only still ask', () => {
  const p = withDb();
  const traps = [
    ['data-modifying CTE', 'WITH d AS (DELETE FROM users RETURNING *) SELECT * FROM d'],
    ['EXPLAIN ANALYZE executes it', 'EXPLAIN ANALYZE DELETE FROM users'],
    ['SELECT that writes a file', "SELECT * FROM u INTO OUTFILE '/tmp/x'"],
    ['SELECT INTO, which creates a table', 'SELECT * INTO archived FROM users'],
    ['second statement smuggled in', 'SELECT 1; DROP TABLE t'],
    ['SELECT that reads the filesystem', "SELECT pg_read_file('/etc/passwd')"],
  ];
  for (const [why, sql] of traps) {
    const v = evaluate(p, 'mcp__postgres__query', { sql });
    assert.equal(v.action, 'ask', why);
    assert.equal(v.rule.name, 'db-write-veto', why);
  }
});

test('the veto must be listed before the allowance', () => {
  // First match wins. Reversed, the traps carrying a danger word (DELETE,
  // DROP) are still caught by the danger check -- but the ones that do not
  // carry one get through, which is why the order is documented.
  const reversed = writeConfig({ rules: [DB_RULES[1], DB_RULES[0]] });
  for (const sql of ["SELECT * FROM u INTO OUTFILE '/tmp/x'", "SELECT pg_read_file('/etc/passwd')", 'SELECT * INTO archived FROM users']) {
    assert.equal(evaluate(reversed, 'mcp__postgres__query', { sql }).action, 'allow', `reversed lets this through: ${sql}`);
  }
  const correct = withDb();
  for (const sql of ["SELECT * FROM u INTO OUTFILE '/tmp/x'", "SELECT pg_read_file('/etc/passwd')", 'SELECT * INTO archived FROM users']) {
    assert.equal(evaluate(correct, 'mcp__postgres__query', { sql }).action, 'ask', sql);
  }
});

test('a database tool without a sql field is not silently approved', () => {
  const p = withDb();
  const v = evaluate(p, 'mcp__postgres__list_schemas', { db: 'main' });
  assert.equal(v.action, 'ask');
  assert.equal(v.rule, null);
});
