# Redaction

A sidecar auto-pushes scratchpad files to a shared remote, and scratchpads
are exactly where pasted API keys, connection strings, and personal data end
up. Redaction strips those before they leave the machine — without touching
your local files.

For credentials that scripts need at runtime, prefer environment variables
whose values stay outside the synced checkout. The [agent guide](agents.md#use-environment-variables-without-syncing-their-values)
shows how to share setup instructions without sharing the credentials.

## How it works

Redaction runs as a git *clean filter* in the sidecar checkout: content is
rewritten as it is staged, so the commits and the remote only ever contain
redacted text, while the working tree keeps your original. Matches are
replaced with placeholders like `<API_KEY>`, `<TOKEN>`, `<SECRET>`,
`<EMAIL>`:

```
local file:    OPENAI_API_KEY=sk-abc123...
pushed file:   OPENAI_API_KEY=<API_KEY>
```

The filter is `required`, so it fails closed: if it can't run, staging
errors instead of silently pushing cleartext. Binary and non-UTF-8 files
pass through untouched.

What it catches: known token formats (OpenAI, Anthropic, GitHub, AWS, Slack,
JWTs), PEM private key blocks, `Authorization` headers, URL credentials
(`postgres://user:secret@host`), assignments to sensitive-looking keys
(`password`, `pwd`, `*_TOKEN`, `api_key`, ...), and — depending on the mode
below — emails, phone numbers, SSNs, and credit card numbers.

### Shell expansions

A shell expansion reads a variable; it doesn't assign one. `${PWD:t}`,
`${PASSWORD:0:3}`, `${TOKEN:?unset}`, and `$TOKEN:foo` are left alone, even
though the name looks sensitive and the `:` looks like `key: value`. So is an
assignment whose whole value refers to something else — `$GH_TOKEN`,
`${GH_TOKEN}`, or a command such as `$(gh auth token)`. The value is
fetched when the line runs, and isn't written in the file to strip.

The one part of an expansion that can hold a literal secret is the word of a
default, assign, or alternate (`:-`, `:=`, `:+`, and the forms without `:`).
Under a sensitive name, that word is replaced and the braces kept:

```
local file:    psql "${DB_PASSWORD:-hunter2}"
pushed file:   psql "${DB_PASSWORD:-<SECRET>}"
```

A word that is itself a reference (`${DB_PASSWORD:-$FALLBACK}`) passes
through. `$PWD` and `$OLDPWD` are the shell's working directory, so their
defaults always pass through. Outside an expansion, `PWD` is still a password
key: ODBC connection strings write `UID=sa;PWD=...;`.

## Reviewing what gets redacted

Pattern-based detection has false positives, so redaction is never silent:

- Every sync that redacted something says so:
  `redacted 2 item(s) in 1 file(s); review with `sidecar redactions`...`
- `sidecar redactions` shows a per-file diff of your local content against
  what is (or will be) pushed. It is recomputed on demand from your working
  files, so it is always exact and current.
- A `redaction` event with counts (never content) lands in the machine log
  (`sidecar tail`).
- On a peer with [`review = "required"`](review.md), the review packet lists
  every added line that carries a placeholder. The reviewer is asked to reject
  any placeholder that replaced something other than a credential, or that
  leaves the file broken.

## Modes

Set `redaction` in `.sidecar` (or `sidecar init --redaction <mode>`).
Override the mode for matching paths in the peer's [rules file](rules.md).
Comments and in-file markers do not override redaction policy.

| mode | effect |
|---|---|
| `secrets+pii` | everything above — credentials *and* emails, phone numbers, SSNs, card numbers |
| `secrets` | credentials only; PII passes through — most false positives live in the PII rules, so this is the default |
| `none` | no redaction at all; files are pushed exactly as written |

Changing the mode re-runs every tracked file through the filter on the next
sync, so the whole tree converges to the new mode — `none → secrets+pii`
re-redacts everything, `secrets+pii → none` re-commits your originals.
Upgrading to a version whose filter behaves differently (the in-file bypass
removal, or the shell expansion fix) also reprocesses tracked files on the
next snapshot, including files whose contents did not change.

The mode governs your files. Two things sidecar generates about itself are
always redacted at the `secrets` level whatever the mode says: the machine-level
log (`sidecar tail`) and the failure messages in a
[health heartbeat](commands.md#fleet-health). Both quote git verbatim, and git
quotes remote URLs — which carry tokens. Turning redaction off is a decision
about your notes, not an instruction to publish your own credentials.

## False positives break other machines, not yours

A false positive is more than a cosmetic placeholder. The machine that wrote
the file keeps its original, so its author sees nothing wrong. Every other
machine receives the published blob, placeholder included, as its working
copy, so the file is damaged there:

```
on the author's machine:
  [[ -n "$sub" && "${PWD:t}" != "$sub" ]] && where+=" %F{cyan}${${PWD:t}//\%/%%}%f"
pushed, and so on every other machine:
  [[ -n "$sub" && "${PWD:<SECRET>" != "$sub" ]] && where+=" %F{cyan}${${PWD:<SECRET>"
```

That was a real incident in a dotfiles sidecar (before the
[shell expansion](#shell-expansions) fix): the line stopped parsing, so every
interactive shell on the other machines errored out. A review approved it,
because the reviewer saw `<SECRET>` and took it for redaction doing its job.
The same is true of real secrets in shell files: `export GITHUB_TOKEN=<TOKEN>`
doesn't parse either.

To limit the damage:

- Run `sidecar redactions` after adding or editing config, scripts, or
  dotfiles. It shows exactly what other machines will get.
- When a redaction is wrong, rewrite the line, or turn redaction off for that
  path with a [rule](rules.md) (`redaction = "none"`). Only do that for
  content you would publish verbatim. Fix it on the author's machine: once it
  publishes the corrected file, the others get it on their next sync, and
  editing a damaged copy elsewhere only adds a competing version.
- Upgrade every machine together after a redaction fix. An older filter on
  another machine still applies the old patterns when it commits the file
  again.

## Limits worth knowing

- **Redaction is one-way, and multi-machine syncs deliver redacted text.**
  The secret never leaves the machine that wrote it, so when *another*
  machine edits the same file, the version that syncs back to you contains
  the placeholders, replacing your local original. Files you only edit from
  one machine are never affected. Keep real secrets out of files you edit
  from multiple machines.
- **Anything already pushed is in the remote's history.** Switching to a
  stricter mode redacts future pushes; it cannot rewrite what an earlier
  mode already published.
- **Pattern matching isn't understanding.** A secret inside an odd format
  (a quoted string under a non-sensitive key, a YAML block scalar, an
  unquoted value with spaces) can slip through. Treat redaction as a strong
  safety net for a private remote, not as permission to paste production
  credentials into a scratchpad.
