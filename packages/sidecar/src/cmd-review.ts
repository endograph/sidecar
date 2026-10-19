// `sidecar review`: list, show, and decide the reviews that gate a peer's
// publishing, set this machine's reviewer, and — as `review run` — the
// background runner a sync starts. The records and runner live in review.ts;
// the publishing they gate lives in sync.ts.
import fs from "node:fs";
import path from "node:path";

import { type Role, paint } from "./color.js";
import { SidecarError, parseOptions } from "./util.js";
import { hasGitMetadata } from "./git.js";
import { type Peer, loadPeer, loadPeers, resolveSidecarPath, reviewRequired, selectedPeer } from "./config.js";
import { readSettings, withSyncLock, writeSettings } from "./state.js";
import {
  type Review,
  configuredReviewer,
  decideReview,
  findReview,
  isOpen,
  listReviews,
  openReview,
  readReview,
  reviewAttention,
  runReviewer,
} from "./review.js";
import { retryReview } from "./sync.js";
import { syncPeer } from "./cmd-sync.js";
import { announcePeer, formatRelativeTime, labelLine } from "./ui.js";

const USAGE = "usage: sidecar review [list|show|approve|reject|retry|reviewer] [id] [--reason text] [--no-sync] [--json] [--peer name]";
// "reviewer:" is the longest label.
const LABEL_WIDTH = "reviewer:".length;

export function cmdReview(args: string[]): number {
  const [subcommand = "list", ...rest] = args[0]?.startsWith("-") ? ["list", ...args] : args;
  switch (subcommand) {
    case "list":
      return listCommand(rest);
    case "show":
      return showCommand(rest);
    case "approve":
    case "reject":
      return decideCommand(subcommand, rest);
    case "retry":
      return retryCommand(rest);
    case "reviewer":
      return reviewerCommand(rest);
    case "run":
      return runCommand(rest);
    default:
      throw new SidecarError(`unknown review command ${JSON.stringify(subcommand)}; ${USAGE}`);
  }
}

function listCommand(args: string[]): number {
  const parsed = parseOptions(args, { boolean: new Set(["--json"]), value: new Set(["--peer"]) });
  if (parsed.positional.length) throw new SidecarError(USAGE);
  const peers = loadPeers(selectedPeer(parsed));
  if (parsed.flags.has("--json")) {
    console.log(JSON.stringify(peers.map((peer) => ({
      peer: peer.name,
      required: reviewRequired(peer.config),
      reviews: peerReviews(peer).map(reviewPayload),
    })), null, 2));
    return 0;
  }
  for (const peer of peers) {
    announcePeer(peer, peers);
    if (!reviewRequired(peer.config)) {
      console.log(paint("quiet", "review is off for this peer; turn it on with review = \"required\" in its config"));
      continue;
    }
    const reviews = peerReviews(peer);
    if (!reviews.length) {
      console.log(paint("quiet", "no reviews yet; the next sync with unpublished changes opens one"));
      continue;
    }
    for (const review of reviews) printReviewRow(review);
  }
  return 0;
}

function peerReviews(peer: Peer): Review[] {
  const sidecarPath = resolveSidecarPath(peer.root, peer.config);
  return hasGitMetadata(sidecarPath) ? listReviews(sidecarPath) : [];
}

function printReviewRow(review: Review): void {
  const attention = reviewAttention(review);
  const age = formatRelativeTime(review.record.createdAt) ?? review.record.createdAt;
  const text = `${review.record.id}  ${review.state.padEnd(10)}  ${age}, ${review.record.files.length} file(s)`;
  if (attention) console.log(`${paint("attn", text)}  needs attention: ${attention}`);
  else console.log(isOpen(review) ? text : paint("quiet", text));
}

function reviewPayload(review: Review): Record<string, unknown> {
  return {
    id: review.record.id,
    state: review.state,
    attention: reviewAttention(review),
    createdAt: review.record.createdAt,
    files: review.record.files,
    reason: review.verdict?.reason,
    decidedAt: review.verdict?.decidedAt,
    publishedAt: review.record.publishedAt,
    publishedCommit: review.record.publishedCommit,
    dir: review.dir,
  };
}

function showCommand(args: string[]): number {
  const parsed = parseOptions(args, { boolean: new Set(["--json"]), value: new Set(["--peer"]) });
  if (parsed.positional.length > 1) throw new SidecarError(USAGE);
  const review = selectReview(parsed.positional[0], selectedPeer(parsed));
  if (parsed.flags.has("--json")) {
    console.log(JSON.stringify(reviewPayload(review), null, 2));
    return 0;
  }
  const { record } = review;
  const line = (label: string, value: string, role?: Role): void => labelLine(LABEL_WIDTH, label, value, role);
  const attention = reviewAttention(review);
  line("review", record.id, "brand");
  line("state", attention ? `${review.state} — needs attention: ${attention}` : review.state, attention ? "attn" : undefined);
  line("repo", record.root, "repo");
  if (record.peer !== "default") line("peer", record.peer);
  line("opened", formatRelativeTime(record.createdAt) ?? record.createdAt);
  if (review.verdict) line("decided", `${review.verdict.verdict} ${formatRelativeTime(review.verdict.decidedAt) ?? review.verdict.decidedAt}`);
  if (review.verdict?.reason) line("reason", review.verdict.reason);
  if (review.run) line("reviewer", review.run.command, "quiet");
  line("packet", review.dir, "quiet");
  console.log("");
  for (const file of record.files) {
    console.log(`  ${file.status}  ${file.path}${file.artifact ? paint("quiet", `  (not in the diff; full content: ${path.join(review.dir, file.artifact)})`) : ""}`);
  }
  console.log("");
  process.stdout.write(fs.readFileSync(path.join(review.dir, "diff.patch"), "utf8"));
  if (isOpen(review)) {
    console.log("");
    console.log(paint("quiet", `decide with \`sidecar review approve ${record.id}\` or \`sidecar review reject ${record.id} --reason "..."\``));
  }
  return 0;
}

function decideCommand(verdict: "approve" | "reject", args: string[]): number {
  const parsed = parseOptions(args, { boolean: new Set(["--no-sync"]), value: new Set(["--reason", "--peer"]) });
  if (parsed.positional.length > 1) throw new SidecarError(USAGE);
  const selected = selectReview(parsed.positional[0], selectedPeer(parsed));
  const reason = parsed.values.get("--reason")?.trim() || undefined;
  const { id } = selected.record;
  withLockedReview(selected, (review) => decideReview(review, verdict === "approve" ? "approved" : "rejected", reason));

  if (verdict === "reject") {
    console.log(`rejected review ${paint("brand", id)}; nothing it covers is published`);
    console.log("change the files it flags and the next sync opens a new review, or approve it to override");
    return 0;
  }
  console.log(`approved review ${paint("brand", id)}`);
  if (parsed.flags.has("--no-sync")) {
    console.log("it publishes on the next sync");
    return 0;
  }
  // Publishing now rather than at the daemon's next round trip, which can be
  // ten minutes away. The sync that opened this review may still hold the
  // lock — a fast reviewer approves from inside it — so wait for it.
  const peer = loadPeer(selected.record.root, selected.record.peer);
  syncPeer(peer, { lock: "wait", remote: true, snapshot: true });
  return 0;
}

function retryCommand(args: string[]): number {
  const parsed = parseOptions(args, { boolean: new Set(), value: new Set(["--peer"]) });
  if (parsed.positional.length > 1) throw new SidecarError(USAGE);
  configuredReviewer();
  const selected = selectReview(parsed.positional[0], selectedPeer(parsed));
  // A new review rather than the old one reopened: whatever the old review's
  // reviewer still does, it can only decide a review that is closed.
  const fresh = withLockedReview(selected, retryReview);
  console.log(`retired review ${paint("brand", selected.record.id)}; review ${paint("brand", fresh.record.id)} covers the same change, and its reviewer is running`);
  return 0;
}

/**
 * Runs `fn` on a fresh read of the review under the sync lock of the peer it
 * gates: a sync acts on the verdict it reads, so no verdict may change while
 * one runs. A reviewer often decides while the sync that launched it still
 * holds that lock, so this waits for it.
 */
function withLockedReview<T>(selected: Review, fn: (review: Review) => T): T {
  const { id, root, peer } = selected.record;
  let result: T | undefined;
  withSyncLock(root, peer, "wait", () => {
    const review = readReview(id);
    if (!review) throw new SidecarError(`review ${id} is gone`);
    result = fn(review);
  });
  return result as T;
}

function reviewerCommand(args: string[]): number {
  const settings = readSettings();
  if (!args.length) {
    console.log(settings.reviewer ?? paint("quiet", "no reviewer configured"));
    return 0;
  }
  if (args.length === 1 && args[0] === "--unset") {
    writeSettings({ ...settings, reviewer: undefined });
    console.log("reviewer unset; reviews now wait for `sidecar review approve`");
    return 0;
  }
  // The one argument is the whole shell command, quoted as the shell will
  // run it. Rejoining several would lose their quoting.
  if (args.length !== 1) {
    throw new SidecarError("usage: sidecar review reviewer [\"<command>\"|--unset]; quote the command as one argument");
  }
  const command = args[0].trim();
  if (!command) throw new SidecarError("the reviewer command is empty");
  writeSettings({ ...settings, reviewer: command });
  console.log(`reviewer set to ${paint("brand", command)}`);
  return 0;
}

function runCommand(args: string[]): number {
  if (args.length !== 1) throw new SidecarError("usage: sidecar review run <id>");
  return runReviewer(args[0]);
}

/**
 * The review a command means: the id given, or — when there is exactly one —
 * the open review of the repo the command runs in.
 */
function selectReview(id: string | undefined, peer: string | undefined): Review {
  if (id) return findReview(id);
  const open = loadPeers(peer)
    .map((candidate) => resolveSidecarPath(candidate.root, candidate.config))
    .filter(hasGitMetadata)
    .map(openReview)
    .filter((review): review is Review => review !== undefined);
  if (open.length === 1) return open[0];
  if (!open.length) throw new SidecarError("no open review here; pass a review id (`sidecar review` lists them)");
  throw new SidecarError(`more than one open review here (${open.map((review) => review.record.id).join(", ")}); pass the id`);
}
