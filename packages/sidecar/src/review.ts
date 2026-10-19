// The review gate: what a review-gated peer may publish, and who said so.
//
// A peer with `review = "required"` never pushes its own history. The engine
// (sync.ts) publishes one commit per approved review, whose tree is exactly
// the tree the reviewer saw. This module owns the reviews themselves: their
// records, the packet a reviewer reads, the background runner around the
// configured reviewer command, and the state a review is in.
//
// Everything here is machine-local. A packet holds a diff of content that has
// not been cleared to leave this machine, so it lives in the state dir, owner
// readable only, and nothing about it reaches the remote except the commit an
// approval publishes.
//
// A review's files each have one writer. The sync and the decision commands
// write under the peer's sync lock, so a verdict can never change while a sync
// is acting on it. A review launches its reviewer at most once; a retry opens
// a new review, so a reviewer that outlives its review can only ever decide
// one that is closed:
//   review.json   the sync: opened, launched, publishing, published, superseded
//   verdict.json  `sidecar review approve|reject`
//   run.json      the runner, around the reviewer command
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";

import { SidecarError, nowIso, realpathOr } from "./util.js";
import { git, gitBytes, gitCommonDir, treeOf } from "./git.js";
import { GLOBAL_EXEC_ENV, SKIP_LOCAL_EXEC_ENV, sidecarCliPath } from "./install.js";
import {
  DEFAULT_PEER,
  LOCAL_SYNC_ENV,
  PEER_ENV,
  SOFT_SYNC_ENV,
  type SidecarConfig,
  keepFailuresPrivate,
  peerConfigPath,
  reviewTimeoutSeconds,
} from "./config.js";
import { logSidecarEvent, readSettings, sidecarStateDir } from "./state.js";
import { redactText } from "./redaction.js";

const REVIEW_SCHEMA = 1;
/** Closed reviews kept per family, newest first; older packets are deleted. */
const KEEP_CLOSED_REVIEWS = 10;
/** Review ids: generated hex, so never a path outside the reviews dir. */
const ID_PATTERN = /^[0-9a-f]+$/;
/** How long a launched runner has to record itself before the review counts as failed. */
const LAUNCH_GRACE_SECONDS = 60;

function newId(): string {
  return crypto.randomBytes(4).toString("hex");
}

/**
 * One changed path. `artifact` names the packet file holding its complete
 * published content when the diff cannot show it (see writeOpaqueArtifacts),
 * so nothing publishes unseen.
 */
export type ReviewFile = { status: string; path: string; artifact?: string };

export type ReviewRecord = {
  schema: number;
  id: string;
  /**
   * The repo family's shared git dir. Sibling checkouts share one clone and
   * one local main, so they share one review: see the review-gated section of
   * sync.ts.
   */
  family: string;
  root: string;
  peer: string;
  /**
   * The public commit the diff is measured from — the newest remote main
   * commit the reviewed head contains. Always present: a gated peer's local
   * main is joined to the remote's main before anything is reviewed.
   */
  base: string;
  /** Local main when the review opened. */
  head: string;
  /** The tree an approval publishes: the head's, pinned at review time. */
  tree: string;
  files: ReviewFile[];
  createdAt: string;
  timeoutSeconds: number;
  /** When the sync started this review's one runner. */
  launchedAt?: string;
  /**
   * The commit this review publishes and where, recorded before the push so a
   * sync that dies mid-publish — or a sibling resuming after it — pushes that
   * same commit rather than cutting a second one.
   */
  publishing?: { inbox: string; commit: string };
  publishedAt?: string;
  publishedCommit?: string;
  supersededAt?: string;
};

export type ReviewVerdict = { verdict: "approved" | "rejected"; reason?: string; decidedAt: string };

type ReviewRun = {
  pid: number;
  command: string;
  startedAt: string;
  finishedAt?: string;
  exitCode?: number | null;
  signal?: string | null;
};

export type ReviewState = "pending" | "approved" | "rejected" | "failed" | "published" | "superseded";

export type Review = {
  record: ReviewRecord;
  verdict?: ReviewVerdict;
  run?: ReviewRun;
  state: ReviewState;
  dir: string;
};

// ---------------------------------------------------------------------------
// Records
// ---------------------------------------------------------------------------

function reviewsDir(): string {
  return path.join(sidecarStateDir(), "reviews");
}

function reviewDir(id: string): string {
  return path.join(reviewsDir(), id);
}

function writePrivateFile(filePath: string, text: string): void {
  const temporary = `${filePath}.${crypto.randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temporary, text, { encoding: "utf8", mode: 0o600 });
    fs.renameSync(temporary, filePath);
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}

function writePrivateJson(filePath: string, value: unknown): void {
  writePrivateFile(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function readJson<T>(filePath: string): T | undefined {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8")) as T;
  } catch {
    return undefined;
  }
}

export function readReview(id: string): Review | undefined {
  // A packet holds unreviewed content, so any failure near one is private.
  keepFailuresPrivate();
  if (!ID_PATTERN.test(id)) return undefined;
  const dir = reviewDir(id);
  const record = readJson<ReviewRecord>(path.join(dir, "review.json"));
  if (!record || record.id !== id) return undefined;
  const verdict = readJson<ReviewVerdict>(path.join(dir, "verdict.json"));
  const run = readJson<ReviewRun>(runPath(dir));
  return { record, verdict, run, state: reviewState(record, verdict, run), dir };
}

function runPath(dir: string): string {
  return path.join(dir, "run.json");
}

/** The key a checkout's reviews are filed under: its family's shared git dir. */
function reviewFamily(sidecarPath: string): string {
  return realpathOr(gitCommonDir(sidecarPath));
}

/** Every review on this machine, newest first, optionally for one checkout's family. */
export function listReviews(sidecarPath?: string): Review[] {
  let ids: string[];
  try {
    ids = fs.readdirSync(reviewsDir());
  } catch {
    return [];
  }
  const family = sidecarPath === undefined ? undefined : reviewFamily(sidecarPath);
  return ids
    .map(readReview)
    .filter((review): review is Review => review !== undefined)
    .filter((review) => family === undefined || review.record.family === family)
    .sort((left, right) => right.record.createdAt.localeCompare(left.record.createdAt) || right.record.id.localeCompare(left.record.id));
}

/** A review found by its id or an unambiguous prefix of it. */
export function findReview(idOrPrefix: string): Review {
  const exact = readReview(idOrPrefix);
  if (exact) return exact;
  const matches = listReviews().filter((review) => review.record.id.startsWith(idOrPrefix));
  if (matches.length === 1) return matches[0];
  if (matches.length > 1) throw new SidecarError(`review id ${JSON.stringify(idOrPrefix)} is ambiguous; use more of it`);
  throw new SidecarError(`no review ${JSON.stringify(idOrPrefix)} on this machine`);
}

export function isOpen(review: Review): boolean {
  return review.state !== "published" && review.state !== "superseded";
}

function assertOpen(review: Review): void {
  if (!isOpen(review)) throw new SidecarError(`review ${review.record.id} is already ${review.state}`);
}

/** The one review a checkout's family may have open at a time. */
export function openReview(sidecarPath: string): Review | undefined {
  return listReviews(sidecarPath).find(isOpen);
}

function reviewState(record: ReviewRecord, verdict?: ReviewVerdict, run?: ReviewRun): ReviewState {
  if (record.publishedAt) return "published";
  if (record.supersededAt) return "superseded";
  if (verdict) return verdict.verdict;
  if (run?.finishedAt && run.exitCode !== 0) return "failed";
  // A runner that died without finishing never recorded an exit; it is as
  // failed as one that exited nonzero. So is one that never started: the
  // review launches only once, so nothing else will.
  if (run && !run.finishedAt && !pidAlive(run.pid)) return "failed";
  if (!run && record.launchedAt && (Date.now() - Date.parse(record.launchedAt)) / 1000 > LAUNCH_GRACE_SECONDS) return "failed";
  return "pending";
}

function pidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * Why a review is waiting on a person rather than on its reviewer, or
 * undefined while it is simply in progress. A rejection, a reviewer that
 * failed, no reviewer at all, and a review open past its timeout all hold the
 * peer's publishing the same way; this is what makes them visible.
 */
export function reviewAttention(review: Review, now = Date.now()): string | undefined {
  if (review.state === "rejected") return "rejected";
  if (review.state === "failed") {
    const run = review.run;
    if (!run) return "reviewer never started";
    if (run.finishedAt) {
      return run.signal ? `reviewer stopped by ${run.signal} without a verdict` : `reviewer exited ${run.exitCode} without a verdict`;
    }
    return "reviewer stopped without a verdict";
  }
  if (review.state !== "pending") return undefined;
  if (!review.record.launchedAt && !readSettings().reviewer) return "no reviewer is configured on this machine";
  const age = (now - Date.parse(review.record.createdAt)) / 1000;
  if (age > review.record.timeoutSeconds) return `undecided for over ${formatDuration(review.record.timeoutSeconds)}`;
  return undefined;
}

function formatDuration(seconds: number): string {
  if (seconds >= 3600 && seconds % 3600 === 0) return `${seconds / 3600}h`;
  if (seconds >= 60 && seconds % 60 === 0) return `${seconds / 60}m`;
  return `${Math.round(seconds)}s`;
}

// ---------------------------------------------------------------------------
// Opening a review
// ---------------------------------------------------------------------------

/** The committed guidance for a peer's reviewer, beside its config like the rules file. */
export function peerReviewGuidelinesFileName(name: string): string {
  return name === DEFAULT_PEER ? ".sidecar-review" : `.sidecar-review.${name}`;
}

export function peerReviewGuidelinesPath(root: string, name: string): string {
  return path.join(root, peerReviewGuidelinesFileName(name));
}

function readGuidelines(root: string, peer: string): string | undefined {
  try {
    const text = fs.readFileSync(peerReviewGuidelinesPath(root, peer), "utf8").trim();
    return text || undefined;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    // Guidance the reviewer was meant to apply and cannot read is not the
    // same as no guidance; fail the sync rather than review without it.
    throw new SidecarError(
      `could not read ${peerReviewGuidelinesPath(root, peer)}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

// What the packet enumerates is what an approval publishes, so it comes from
// plumbing and spells out every option porcelain would take from config: a
// `diff.ignoreSubmodules` or a rename heuristic must never hide a changed path.
const PACKET_DIFF_OPTIONS = ["-r", "--no-renames", "--ignore-submodules=none"];

/**
 * Writes the record and packet for a review of `base..head`. The packet is
 * what a reviewer reads: the diff exactly as it would be published (committed
 * blobs, so already redacted), the changed paths, the repo's guidelines, and
 * instructions that say how to decide.
 */
export function createReview(options: { root: string; config: SidecarConfig; sidecarPath: string; base: string; head: string }): Review {
  const { root, config, sidecarPath, base, head } = options;
  const guidelines = readGuidelines(root, config.peer);
  const id = newId();
  const dir = reviewDir(id);
  fs.mkdirSync(reviewsDir(), { recursive: true, mode: 0o700 });
  fs.mkdirSync(dir, { mode: 0o700 });

  const fields = git(sidecarPath, ["diff-tree", ...PACKET_DIFF_OPTIONS, "--name-status", "-z", base, head]).stdout.split("\0").filter(Boolean);
  const files: ReviewFile[] = [];
  for (let index = 0; index + 1 < fields.length; index += 2) files.push({ status: fields[index], path: fields[index + 1] });
  writeOpaqueArtifacts(sidecarPath, dir, base, head, files);
  const diff = git(sidecarPath, ["diff-tree", ...PACKET_DIFF_OPTIONS, "-p", "--no-color", "--no-ext-diff", "--no-textconv", base, head]).stdout;

  const record: ReviewRecord = {
    schema: REVIEW_SCHEMA,
    id,
    family: reviewFamily(sidecarPath),
    root,
    peer: config.peer,
    base,
    head,
    tree: treeOf(sidecarPath, head),
    files,
    createdAt: nowIso(),
    timeoutSeconds: reviewTimeoutSeconds(config),
  };
  writePrivateFile(path.join(dir, "diff.patch"), diff);
  if (guidelines) writePrivateFile(path.join(dir, "guidelines.md"), `${guidelines}\n`);
  writePrivateFile(path.join(dir, "instructions.md"), reviewInstructions(record, config, guidelines));
  // The record last: a directory without one is not yet a review, so a crash
  // mid-packet leaves nothing a sync would wait on.
  writePrivateJson(path.join(dir, "review.json"), record);
  logSidecarEvent("review-open", { id, root, peer: config.peer, files: files.length });
  pruneClosedReviews(sidecarPath);
  return { record, state: "pending", dir };
}

/**
 * Git shows a binary — or a file whose attributes say `-diff` — as "Binary
 * files differ", and text that is not UTF-8 reaches the packet garbled, so
 * the diff alone would let either publish unseen. Each such file's complete
 * new content goes into the packet instead, as the committed blob: exactly
 * the bytes an approval publishes. Sets `artifact` on those files.
 */
function writeOpaqueArtifacts(repo: string, dir: string, from: string, head: string, files: ReviewFile[]): void {
  const binary = new Set(
    git(repo, ["diff-tree", ...PACKET_DIFF_OPTIONS, "--numstat", "-z", from, head])
      .stdout.split("\0")
      .filter((entry) => entry.startsWith("-\t-\t"))
      .map((entry) => entry.slice("-\t-\t".length)),
  );
  // Entry types from the tree itself: a gitlink names a commit in another
  // repository, which this one need not hold, and the patch already shows it.
  const blobs = new Set(
    git(repo, ["ls-tree", "-r", "-z", "--full-tree", head])
      .stdout.split("\0")
      .filter((entry) => entry.split(" ")[1] === "blob")
      .map((entry) => entry.slice(entry.indexOf("\t") + 1)),
  );
  const utf8 = new TextDecoder("utf-8", { fatal: true });
  const isText = (blob: Buffer): boolean => {
    try {
      utf8.decode(blob);
      return true;
    } catch {
      return false;
    }
  };
  let count = 0;
  for (const file of files) {
    if (file.status === "D" || !blobs.has(file.path)) continue;
    const blob = gitBytes(repo, ["cat-file", "blob", `${head}:${file.path}`]).stdout;
    if (!binary.has(file.path) && isText(blob)) continue;
    count += 1;
    file.artifact = path.join("opaque", String(count).padStart(4, "0"));
    fs.mkdirSync(path.join(dir, "opaque"), { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(dir, file.artifact), blob, { mode: 0o600 });
  }
}

function updateRecord(review: Review, change: Partial<ReviewRecord>): void {
  const record = { ...review.record, ...change };
  writePrivateJson(path.join(review.dir, "review.json"), record);
  review.record = record;
}

export function markPublishing(review: Review, inbox: string, commit: string): void {
  updateRecord(review, { publishing: { inbox, commit } });
}

export function markPublished(review: Review, commit: string): void {
  updateRecord(review, { publishedAt: nowIso(), publishedCommit: commit });
  logSidecarEvent("review-published", { id: review.record.id, commit });
}

export function markSuperseded(review: Review): void {
  updateRecord(review, { supersededAt: nowIso() });
  logSidecarEvent("review-superseded", { id: review.record.id });
}

// Closed packets hold diffs nobody needs any more; keep a short history for
// `sidecar review` and delete the rest.
function pruneClosedReviews(sidecarPath: string): void {
  const closed = listReviews(sidecarPath).filter((review) => !isOpen(review));
  for (const review of closed.slice(KEEP_CLOSED_REVIEWS)) {
    fs.rmSync(review.dir, { recursive: true, force: true });
  }
}

/** Removes the reviews of families whose clone is gone; deinit's half of the packets. */
export function pruneOrphanedReviews(): void {
  for (const review of listReviews()) {
    if (!fs.existsSync(review.record.family)) fs.rmSync(review.dir, { recursive: true, force: true });
  }
}

function opaqueSection(record: ReviewRecord): string {
  const opaque = record.files.filter((file) => file.artifact);
  if (!opaque.length) return "";
  return `
These files' content does not appear faithfully in \`diff.patch\` (binary, not
UTF-8, or diffs turned off). Their complete new content, as it would be
published, is in the packet.
Inspect each one; if you cannot, do not approve:

${opaque.map((file) => `- \`${file.artifact}\` — ${file.path}`).join("\n")}
`;
}

function reviewInstructions(record: ReviewRecord, config: SidecarConfig, guidelines: string | undefined): string {
  return `# Sidecar publish review ${record.id}

A sidecar is a scratchpad repository that syncs automatically to a shared Git
remote (${redactText(config.remote)}). This machine wants to publish the change in
\`diff.patch\`. Everyone with access to that remote can read what you approve,
and it stays in the remote's history.

Decide whether anything in the change should not leave this machine. This is
not a code review: ignore quality, style, and correctness.

Secret redaction has already run. Values it caught appear as placeholders such
as \`<API_KEY>\`, \`<TOKEN>\`, or \`<SECRET>\`; they are not leaks. Look for what
pattern matching misses:

- credentials in unusual formats, or ones split across lines
- personal data about real people: contact details, health, finances, private conversations
- confidential material: customer names and data, unreleased plans, internal-only details
- anything the repository's guidelines below rule out

## Files

All in this directory (\`$SIDECAR_REVIEW_DIR\`):

- \`diff.patch\` — the change exactly as it would be published
- \`review.json\` — the repository, peer, and changed paths
${guidelines ? "- `guidelines.md` — this repository's guidelines, repeated below\n" : ""}${opaqueSection(record)}
## Guidelines

${guidelines ?? "This repository has no review guidelines (`.sidecar-review` beside its `.sidecar`)."}

## Decide

Approve, and the change is published on the next sync:

    sidecar review approve ${record.id}

Reject, saying which file and what kind of content. Do not repeat the
sensitive value itself:

    sidecar review reject ${record.id} --reason "<file: what kind of content>"

If you are unsure, or a person should weigh in, do neither: leave the review
open and raise it with them. Nothing is published until someone approves, and
they decide with the same two commands.
`;
}

// ---------------------------------------------------------------------------
// Running the reviewer
// ---------------------------------------------------------------------------

/** This machine's reviewer command, or a failure that says how to set one. */
export function configuredReviewer(): string {
  const command = readSettings().reviewer;
  if (!command) throw new SidecarError("no reviewer is configured; set one with `sidecar review reviewer <command>`");
  return command;
}

/**
 * Starts the runner for a review in the background and returns at once. A
 * review takes minutes; the sync that opened it holds the sync lock and must
 * not wait for one. Call under that lock: the launch is recorded first, so no
 * later sync launches a second runner for the same review.
 */
export function launchReviewer(review: Review): void {
  updateRecord(review, { launchedAt: nowIso() });
  const child = spawn(process.execPath, [sidecarCliPath(), "review", "run", review.record.id], {
    cwd: review.dir,
    detached: true,
    stdio: "ignore",
    // This exact install runs the review it opened: the packet format is its.
    env: { ...process.env, [SKIP_LOCAL_EXEC_ENV]: "1" },
  });
  child.unref();
  logSidecarEvent("review-launch", { id: review.record.id });
}

/**
 * The runner: runs the configured reviewer to completion and records how it
 * ended. The verdict is not the exit status — a reviewer decides through
 * `sidecar review approve|reject`, now or after a discussion that outlives it.
 * A zero exit without a verdict is a review still in progress somewhere else;
 * a nonzero one is a reviewer that broke.
 */
export function runReviewer(idOrPrefix: string): number {
  const review = findReview(idOrPrefix);
  const { id } = review.record;
  assertOpen(review);
  if (review.run) throw new SidecarError(`review ${id}'s reviewer already ran; \`sidecar review retry ${id}\` opens a new review of the same change`);
  const command = configuredReviewer();

  const file = runPath(review.dir);
  const run: ReviewRun = { pid: process.pid, command, startedAt: nowIso() };
  writePrivateJson(file, run);
  const log = fs.openSync(path.join(review.dir, "reviewer.log"), "a", 0o600);
  let result;
  try {
    result = spawnSync("/bin/sh", ["-c", command], {
      cwd: review.dir,
      stdio: ["ignore", log, log],
      env: reviewerEnv(review),
    });
  } finally {
    fs.closeSync(log);
  }
  const finished: ReviewRun = { ...run, finishedAt: nowIso(), exitCode: result.status, signal: result.signal };
  writePrivateJson(file, finished);
  logSidecarEvent("review-run", { id, exitCode: result.status, signal: result.signal });
  return 0;
}

function reviewerEnv(review: Review): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  // The runner inherits the requests a daemon made of the sync that opened
  // the review. A reviewer that runs `sidecar` must get a plain one.
  for (const name of [PEER_ENV, SOFT_SYNC_ENV, LOCAL_SYNC_ENV, SKIP_LOCAL_EXEC_ENV, GLOBAL_EXEC_ENV]) delete env[name];
  const { record } = review;
  return {
    ...env,
    SIDECAR_REVIEW_ID: record.id,
    SIDECAR_REVIEW_DIR: review.dir,
    SIDECAR_REVIEW_PROMPT: path.join(review.dir, "instructions.md"),
    SIDECAR_REVIEW_DIFF: path.join(review.dir, "diff.patch"),
    SIDECAR_REVIEW_ROOT: record.root,
    SIDECAR_REVIEW_PEER: record.peer,
    SIDECAR_REVIEW_CONFIG: peerConfigPath(record.root, record.peer),
  };
}

// ---------------------------------------------------------------------------
// Deciding
// ---------------------------------------------------------------------------

export function decideReview(review: Review, verdict: ReviewVerdict["verdict"], reason?: string): void {
  assertOpen(review);
  // Publication has begun: the commit may already be on the remote, so a
  // rejection now would claim something it cannot deliver.
  if (review.record.publishing && verdict === "rejected") {
    throw new SidecarError(`review ${review.record.id} is already being published; it can no longer be rejected`);
  }
  const record: ReviewVerdict = { verdict, ...(reason ? { reason } : {}), decidedAt: nowIso() };
  writePrivateJson(path.join(review.dir, "verdict.json"), record);
  review.verdict = record;
  review.state = verdict;
  // Never the reason: it describes what was sensitive, and the log is
  // something people paste into bug reports.
  logSidecarEvent("review-decision", { id: review.record.id, verdict });
}

