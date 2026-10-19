# Review before publishing

[Redaction](redaction.md) catches secrets that look like secrets. It can't
tell that a paragraph names a customer, describes an unreleased plan, or
quotes a private conversation. A peer with review turned on publishes nothing
until a reviewer — usually a coding agent, sometimes you — approves exactly
what would leave the machine.

Review is opt-in per peer. Sync on this machine is unaffected: sibling
checkouts still see each other's edits within seconds. Only publishing to the
remote waits for review.

## Turning it on

In the peer's committed config:

```toml
review = "required"
review-timeout = "1h"   # optional; how long a review may sit undecided (default 1h)
```

Or `sidecar init <remote> --review required [--review-timeout 30m]`.

Then tell this machine who reviews:

```sh
sidecar review reviewer "claude-sidecar"   # any shell command, quoted as one argument
sidecar review reviewer                     # show it
sidecar review reviewer --unset
```

The policy is committed, and the reviewer command is machine-local. A command
written in `.sidecar` would be one that any clone of the repo could make your
daemon run. Each person picks their own reviewer: Claude, Codex, a script, or
none at all. With no reviewer configured, reviews wait for
`sidecar review approve` and are flagged as needing attention.

Optional guidance for reviewers goes in `.sidecar-review` (or
`.sidecar-review.<peer>`), beside the config, in plain prose:

```markdown
This sidecar is shared with contractors. Nothing about customers by name,
pricing, or hiring.
```

It's policy, like the [rules file](rules.md): in a nested sidecar it lives in
the host repo, outside the synced content, and changes go through the same
review as `.sidecar`.

## What a reviewer gets

When a sync finds unpublished changes, it opens a review and starts the
reviewer in the background. The sync doesn't wait for it. The reviewer runs
through `/bin/sh -c` in the review's packet directory, with:

| variable | value |
|---|---|
| `SIDECAR_REVIEW_ID` | the review's id |
| `SIDECAR_REVIEW_DIR` | the packet directory (also the working directory) |
| `SIDECAR_REVIEW_PROMPT` | `instructions.md`: what to look for and how to decide |
| `SIDECAR_REVIEW_DIFF` | `diff.patch`: the change exactly as it would be published |
| `SIDECAR_REVIEW_ROOT`, `SIDECAR_REVIEW_PEER`, `SIDECAR_REVIEW_CONFIG` | which repo and peer |

The packet also holds `review.json` (changed paths, metadata) and
`guidelines.md` when the repo has guidance. A file the diff can't show — a
binary, text that isn't UTF-8, or one whose attributes turn diffs off — has
its complete new content under `opaque/`, and the instructions list each one:
nothing publishes that isn't in the packet. The diff is of committed content,
so it is already redacted: secrets redaction caught appear as `<API_KEY>`
placeholders, never as values. Packets live in sidecar's state dir and only
your user can read them.

## Deciding

A review is decided by command, never by the reviewer's exit status:

```sh
sidecar review approve <id>
sidecar review reject <id> --reason "plans/q3.md: unreleased pricing"
```

Approving publishes at once (`--no-sync` leaves it to the next sync).
Rejecting holds publishing until the flagged content changes. The next sync
then opens a fresh review of the new state. Approving a rejected review
overrides the rejection. The id can be omitted when the repo has exactly one
open review.

Decisions wait for the peer's sync lock, so a verdict can never change under a
sync that is acting on it. Once a sync has begun publishing an approved review,
it can no longer be rejected.

The exit status says only whether the reviewer itself worked:

- **Exit 0 with a verdict:** decided.
- **Exit 0 without one:** the review moved somewhere else, such as a thread or
  a person. It stays open until someone runs `approve` or `reject`.
- **Nonzero:** the reviewer broke. The review needs attention;
  `sidecar review retry` retires it and opens a new review of the same change
  with a fresh run of the reviewer. A reviewer still working on the old review
  can no longer decide it.

That middle case is what makes discussion possible. A reviewer can open a
thread in your agent tool with the packet, exit, and let the agent there
decide with you, running the same two commands when you agree.

### Example reviewers

The simplest has the agent read the packet and print a verdict, and a script
turns that into the command. The agent needs no permission to run anything:

```sh
#!/bin/sh
# claude-sidecar — or swap `claude -p` for `codex exec`
verdict=$(claude -p "$(cat "$SIDECAR_REVIEW_PROMPT")

Do not run any commands. Read diff.patch, then end your reply with one line:
APPROVE, or REJECT: <file and what kind of content, without repeating it>" | tail -n 1)
case "$verdict" in
  APPROVE) exec sidecar review approve "$SIDECAR_REVIEW_ID" ;;
  REJECT:*) exec sidecar review reject "$SIDECAR_REVIEW_ID" --reason "${verdict#REJECT: }" ;;
  *) exit 0 ;;  # undecided: leave it open for a person
esac
```

A reviewer that hands off instead:

```sh
#!/bin/sh
# Open a conversation about the review, then leave it to whoever is in it.
my-agent-tool new-thread --title "sidecar review $SIDECAR_REVIEW_ID" \
  --message "$(cat "$SIDECAR_REVIEW_PROMPT")" --cwd "$SIDECAR_REVIEW_DIR"
```

## Needs attention

A review needs attention when it:

- was rejected
- has a reviewer that failed, never started, or stopped without a verdict
- has no reviewer on this machine
- has stayed undecided for longer than `review-timeout`

Attention changes nothing about what's published. It makes the hold visible:
`sidecar sync` and `sidecar status` say why, and the
[health heartbeat](commands.md#fleet-health) reports
`publishing held, review needs attention` to every machine. The heartbeat
carries the state only, never a rejection's reason: the reason describes what
was sensitive. For the same reason a gated peer's failure heartbeat names the
stage that failed but not git's message, which can quote unreviewed file names.
Nor does the log, the daemon's included: run the command by hand on that machine
to see the details.

```sh
sidecar review                   # this repo's reviews, newest first
sidecar review show <id>         # state, reason, changed files, and the diff
```

## What gets published

A gated peer never pushes its own history. Snapshots stay on this machine,
along with every intermediate state they recorded, including one that was
rejected and then fixed. What leaves is one commit per approved review, whose
tree is exactly what the reviewer saw. Its parent is the public commit the
review was measured from, so the canonical merge combines only commits the
remote already has. Its push can't carry anything unreviewed either.

Reviews belong to the repo family, not to one checkout. Linked checkouts of a
repo share one clone and one local `main` (see
[One machine, many working copies](sync.md#one-machine-many-working-copies)),
so they share one review of what that `main` holds. A rejection holds every
sibling, and two siblings never race the same content to the remote. So every
working copy sharing that clone must require review: a working copy with review
off gets its own clone, and one whose config changes after linking refuses to
sync through the shared clone rather than publish what its siblings hold. One
review is open at a time. Edits made while it's open wait for the next one,
which covers everything after what was approved.

When the remote has no `main` yet, it starts as an empty commit, never as the
checkout's history or anything staged in it, and the first review covers
everything the checkout holds. When the remote's `main` was started over, local
`main` is joined to the new one the same way, and the next review again covers
everything the checkout holds.

Nothing else rides along. Everything sidecar publishes — review commits, the
canonical merge, the health heartbeat — is built with this checkout's own git
setup switched off, because none of it is in the packet:

- commits carry `user@host`, the identity the heartbeat already shows, never
  the checkout's configured or environment git identity; they are never
  signed and always UTF-8
- hooks and rerere don't run; attributes come only from sidecar's own
  redaction setting, so no `.gitattributes` can select a merge driver, filter,
  or line-ending conversion, and drivers defined in config are replaced by
  git's own
- replacement objects (`git replace`) are ignored, so the packet shows the
  blobs that are really published
- what counts as already on the remote comes from sidecar's own fetch
  (`refs/sidecar-public/`), never from `origin/*` refs that other tools can
  write
- pushes never follow tags, send no configured push options, and are refused
  while `remote.origin.pushurl` points somewhere else
- last-writer-wins clocks are generated by sidecar, never copied from local
  commit messages

Local merges still use your hooks and drivers; whatever they produce lands in
local `main` and is reviewed like any other change.

Local `main` is never reset for a gated peer. Each published commit is joined
to it by a local link merge that records "this is what was published". That
link keeps your later edits from conflicting with your own published ones. It
changes no file and is never pushed.

## Limits worth knowing

- **Every machine syncing the peer needs a sidecar that knows about review.**
  Current versions refuse config keys they don't recognize. Versions from
  before review existed silently ignore `review = "required"` and push as
  usual. Update every machine before turning it on.
- **An agent's judgment is not a guarantee.** Review adds a reader who
  understands context. It doesn't prove nothing sensitive gets through, and a
  reviewer can be wrong in either direction.
- **The reviewer sees the redacted diff, not your working tree.** That keeps
  caught secrets away from it. It also means what redaction rewrote shows up
  as placeholders.
- **Turning review off publishes local history.** A clone a gated peer has used
  remembers it, and sync refuses until you confirm with
  `git -C <checkout> config --unset sidecar.review`. The next sync then pushes
  as an ungated peer does, including snapshots that review kept local. Turning
  it off is a decision about everything still on this machine.
- **Anything published earlier stays in the remote's history.** Review gates
  what's published from now on.
- **In [standalone mode](standalone.md), every writer controls the policy**,
  including turning review off.
- **Review guards against mistakes, not against someone at the keyboard.**
  Anyone who can run commands as you can push directly, edit `.sidecar`,
  approve a review, or change the records in the state dir.
- **Some metadata publishes without review.** The health heartbeat (machine
  `user@host`, the checkout's absolute path, peer, inbox name, sidecar
  version, sync status and timestamps) and the empty initial commit of a new
  remote are sidecar's own and go out before any review.
- **Reviewers must read the whole packet.** Files listed under `opaque/` are
  part of what an approval publishes; `diff.patch` alone does not show them.
- **Pushes follow your git's routing for the remote.** `url.*.insteadOf`
  rewrites still apply — they are how many setups authenticate — so they
  decide where "the remote" is.
- **Path names must be UTF-8.** A changed path that isn't fails the review
  rather than publishing unseen.
