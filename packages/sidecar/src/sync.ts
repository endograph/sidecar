// The sync engine: snapshot, inbox merging, conflict forking, checkout
// cloning and settling, the redaction clean filter wiring, and the fleet
// health heartbeat. Commands and the daemon drive this; it owns every write
// to the sidecar checkout and its remote.
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { paint } from "./color.js";
import { SidecarError, currentMachine, currentUser, nowIso, realpathOr, slug, utcTimestamp } from "./util.js";
import {
  branchExists,
  emptyTree,
  ensureClean,
  ensureCommitIdentity,
  familyPrimaryRoot,
  fetch,
  git,
  gitBytes,
  gitCommonDir,
  gitDir,
  gitRaw,
  hasAnyCommit,
  hasGitMetadata,
  isAncestor,
  isDirty,
  remoteRefExists,
  sidecarIdentity,
  treeOf,
} from "./git.js";
import { packageVersion, sidecarCliPath } from "./install.js";
import {
  DEFAULT_DEBOUNCE_SECONDS,
  DEFAULT_PEER,
  PUBLIC_REFS,
  type SidecarConfig,
  checkoutRandom,
  expandInbox,
  inboxPrefix,
  isStandalone,
  loadPeer,
  matchesInboxPrefix,
  peerConfigPath,
  peerFileName,
  readConfig,
  redactionModeConfigValue,
  remoteBranchName,
  requireSidecarCheckout,
  resolveSidecarPath,
  reviewRequired,
} from "./config.js";
import { clearReviewDue, logSidecarEvent, readSettings, writeReviewDue } from "./state.js";
import {
  type Review,
  type ReviewRecord,
  createReview,
  isOpen,
  launchReviewer,
  listReviews,
  markPublished,
  markPublishing,
  markSuperseded,
  openReview,
  reviewAttention,
} from "./review.js";
import { readRules, resolveFileRules, rulesFingerprint, type SidecarRules } from "./rules.js";
import {
  HEALTH_FILE,
  type HealthIdentity,
  type HealthOutcome,
  type HealthRecord,
  type HealthState,
  classifyHealthState,
  healthBranch,
  isHealthBranch,
  nextHealthRecord,
  parseHealthRecord,
  serializeHealthRecord,
  shouldPublishHealth,
} from "./health.js";
import {
  DEFAULT_REDACTION_MODE,
  type RedactionMode,
  countRedactionPlaceholders,
  redactText,
} from "./redaction.js";

/**
 * What a sync left undone on purpose. `held` is a review-gated peer whose
 * unpublished work is waiting on a review; `attention` says why a person is
 * needed, when one is. `reviewDue` is when the review floor lets the next
 * review open (epoch ms), for unpublished work that has none yet.
 */
export type SyncOutcome = { held?: { review: Review; attention?: string }; reviewDue?: number };

/**
 * A sync in two phases, local first. Runs inside the repo's sync lock —
 * callers hold it via withSyncLock.
 *
 * The local phase captures this checkout's edits and settles them across every
 * working copy on this machine, touching nothing but the shared object store.
 * The remote phase then trades the same work with the other machines. Running
 * them in that order is what makes local collaboration independent of the
 * network: by the time a push can fail, the sibling worktrees are already
 * current, so an unreachable remote or an expired credential no longer stops
 * two agents on one laptop from seeing each other's notes.
 */
export function syncProject(
  root: string,
  config: SidecarConfig,
  options: {
    snapshot: boolean;
    remote: boolean;
    message?: string;
    onStage?: (stage: string) => void;
    /** Holds a review-gated peer's next review to the review floor; see gateUnpublished. */
    reviewFloor?: boolean;
  },
): SyncOutcome {
  const stage = (name: string): void => options.onStage?.(name);

  stage("checkout");
  // Cloning, repairing through a missing family primary, and bootstrapping
  // an unborn repo may contact origin. Local-only sync requires an already
  // initialized checkout and leaves recovery to an explicit clone/full sync.
  const sidecarPath = options.remote
    ? ensureSidecarCheckout(root, config)
    : requireSidecarCheckout(root, config);
  if (!options.remote && !hasAnyCommit(sidecarPath)) {
    throw new SidecarError(`local sync requires an initialized sidecar checkout at ${sidecarPath}; run \`sidecar sync\` first`);
  }
  bindReviewPolicy(sidecarPath, config);
  const inbox = expandInbox(config, sidecarPath);
  ensureCommitIdentity(sidecarPath);
  ensureRedactionFilter(sidecarPath, config.redaction, config);
  ensureInboxBranch(sidecarPath, config, inbox);

  stage("snapshot");
  if (options.snapshot) {
    snapshot(sidecarPath, root, inbox, options.message, config.redaction, config);
  }

  // The local phase exists to bring sibling working copies current early, before
  // anything that can fail on the network. With no siblings there is nothing to
  // bring current, and the remote phase performs the same merge on its way past,
  // so a lone checkout — every standalone repo, and most others — skips it and
  // pays only the ref lookup. A local-only sync always runs it: there is no
  // second phase behind it to do the work.
  const siblings = siblingCheckouts(sidecarPath, config);
  if (siblings.length || !options.remote) {
    stage("merge-local");
    mergeInboxBranches(sidecarPath, config, { forkFiles: true, push: false, remote: false });
    stage("settle");
    settleCheckouts(sidecarPath, config, inbox, siblings);
  }
  if (!options.remote) return {};
  if (reviewRequired(config)) {
    return publishReviewed(root, sidecarPath, config, inbox, siblings, stage, options.reviewFloor ?? false);
  }

  stage("push-inbox");
  syncBranchBeforePush(sidecarPath, inbox, config);
  pushBranch(sidecarPath, inbox);
  stage("merge");
  mergeInboxBranches(sidecarPath, config, { forkFiles: true, push: true, remote: true });
  stage("settle-remote");
  settleCheckouts(sidecarPath, config, inbox, siblings);
  return {};
}

// ---------------------------------------------------------------------------
// Review-gated publishing
//
// A peer with `review = "required"` never pushes its own history: snapshots
// stay on this machine, and so does every intermediate state they recorded,
// including one a reviewer rejected. What leaves is one commit per approved
// review, whose tree is the tree the reviewer saw, on top of the public
// commit the review measured from. Everything the canonical merge combines is
// already public, so its push can carry nothing unreviewed either.
//
// The unit of review is the repo family's local main, not one checkout:
// sibling checkouts share it, settle onto it within seconds, unreviewed, and
// so publish exactly what it holds. Reviewing it once means a rejection holds
// every sibling, and two siblings never race the same content to the remote.
// Local main is never reset for a gated peer (see ensureMainBranch), and each
// publish is joined to it by a link merge (see linkPublished), which is what
// keeps later merges free of conflicts the edits never had.
//
// "Already public" means PUBLIC_REFS: the remote's branches as fetchPublic
// last saw them, inside withPublicGit. remotes/origin/* is local state any
// hook or tool can write, so a gated peer's public base, publish parents, and
// canonical merge inputs never come from it.
// ---------------------------------------------------------------------------

/**
 * Runs `fn` with git confined to what a reviewer saw. Anything this checkout's
 * own git setup can add to a published commit or push is switched off for the
 * duration, because none of it is in the packet:
 *
 * - identity: author and committer are sidecar's own, whatever config or
 *   environment says, and commits are never signed and always UTF-8;
 * - replacement objects: a `git replace` would make the packet show one blob
 *   while the published tree holds another;
 * - hooks, which can add files or message text to a commit, or forge refs;
 * - rerere, which can replay a recorded local resolution into a merge;
 * - configured push options, which reach the remote's hooks;
 * - attributes: they are read from the empty tree, so no `.gitattributes` —
 *   public, or pulled in by any include — selects a merge driver, filter, or
 *   line-ending conversion. Only sidecar's own `info/attributes` applies,
 *   whose redaction filter is pinned to its known command; drivers and
 *   filters defined in config are neutralized as well, in case.
 *
 * Settings travel as environment config, replacing any the caller had in
 * force (which would otherwise outrank them); sync is synchronous, so the
 * environment is this call's alone.
 */
function withPublicGit<T>(repo: string, fn: () => T): T {
  assertRedactionFilterIntact(repo);
  const { name, email } = sidecarIdentity();
  const overrides: Array<[string, string]> = [
    ["core.hooksPath", os.devNull],
    ["core.attributesFile", os.devNull],
    ["core.autocrlf", "false"],
    ["commit.gpgSign", "false"],
    ["tag.gpgSign", "false"],
    ["i18n.commitEncoding", "UTF-8"],
    ["rerere.enabled", "false"],
    ["rerere.autoUpdate", "false"],
    ["merge.renormalize", "false"],
    ["merge.default", "text"],
    ["push.pushOption", ""],
    ["push.followTags", "false"],
    ...neutralizedDrivers(repo),
  ];
  const env: Record<string, string | undefined> = {
    GIT_AUTHOR_NAME: name,
    GIT_AUTHOR_EMAIL: email,
    GIT_COMMITTER_NAME: name,
    GIT_COMMITTER_EMAIL: email,
    GIT_NO_REPLACE_OBJECTS: "1",
    GIT_ATTR_SOURCE: emptyTree(repo),
    GIT_CONFIG_PARAMETERS: undefined,
    GIT_CONFIG_COUNT: String(overrides.length),
  };
  overrides.forEach(([key, value], index) => {
    env[`GIT_CONFIG_KEY_${index}`] = key;
    env[`GIT_CONFIG_VALUE_${index}`] = value;
  });

  const saved = Object.fromEntries(Object.keys(env).map((key) => [key, process.env[key]]));
  const apply = (values: Record<string, string | undefined>): void => {
    for (const [key, value] of Object.entries(values)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  };
  apply(env);
  try {
    return fn();
  } finally {
    apply(saved);
  }
}

/** Overrides that turn every merge driver and filter in config, except redaction, into git's own no-ops. */
function neutralizedDrivers(repo: string): Array<[string, string]> {
  const keys = git(repo, ["config", "--name-only", "--get-regexp", "^(merge|filter)\\..+\\.(driver|clean|smudge|process)$"], { check: false })
    .stdout.split("\n").filter(Boolean);
  return keys.flatMap((key): Array<[string, string]> => {
    const [section, ...rest] = key.split(".");
    const driver = rest.slice(0, -1).join(".");
    if (section === "merge") return [[`merge.${driver}.driver`, "git merge-file --marker-size=%L %A %O %B"]];
    if (driver === REDACTION_FILTER_NAME) return [];
    return [[`filter.${driver}.clean`, "cat"], [`filter.${driver}.smudge`, "cat"], [`filter.${driver}.process`, ""], [`filter.${driver}.required`, "false"]];
  });
}

/**
 * Fails closed when a process filter is in force under the redaction filter's
 * name: git would run it instead of the pinned clean command, and environment
 * config cannot unset a key. ensureRedactionFilter removes one from repo
 * config, so one still visible came from somewhere else — an include.
 */
function assertRedactionFilterIntact(repo: string): void {
  if (git(repo, ["config", "--get-all", `filter.${REDACTION_FILTER_NAME}.process`], { check: false }).status === 0) {
    throw new SidecarError(`filter.${REDACTION_FILTER_NAME}.process is configured; remove it — a review-gated peer publishes only through sidecar's own redaction filter`);
  }
}

/**
 * Refuses a push that `remote.origin.pushurl` would send somewhere other than
 * the remote's own URL. URL rewrites (`url.*.insteadOf`) stay honored: they
 * are how people route a host through the transport that authenticates.
 */
function assertPublishDestination(repo: string): void {
  const pushUrl = git(repo, ["config", "--get-all", "remote.origin.pushurl"], { check: false }).stdout.trim();
  if (!pushUrl) return;
  const url = git(repo, ["config", "--get", "remote.origin.url"], { check: false }).stdout.trim();
  if (pushUrl !== url) {
    throw new SidecarError("remote.origin.pushurl sends this sidecar's pushes somewhere other than its remote; a review-gated peer publishes only to its remote — unset it");
  }
}

/** Refreshes the remote's branches, into origin/* for local use and PUBLIC_REFS. Call inside withPublicGit. */
function fetchPublic(repo: string): void {
  git(repo, ["fetch", "--quiet", "--prune", "--no-tags", "origin", "+refs/heads/*:refs/remotes/origin/*", `+refs/heads/*:${PUBLIC_REFS}*`]);
}

function publicRef(branch: string): string {
  return `${PUBLIC_REFS}${branch}`;
}

/**
 * Brings the public refs current for a caller outside the publish path —
 * refresh, deciding what deleting a checkout would lose.
 */
export function refreshPublicRefs(repo: string): void {
  withPublicGit(repo, () => fetchPublic(repo));
}

/** The remote's tip of `branch` as last fetched, if it has one. */
function publicTip(repo: string, branch: string): string | undefined {
  return git(repo, ["rev-parse", "--verify", "--quiet", publicRef(branch)], { check: false }).stdout.trim() || undefined;
}

/** Whether the remote, as last fetched, has `commit` on any branch. */
function isPublic(repo: string, commit: string): boolean {
  return Boolean(git(repo, ["for-each-ref", "--contains", commit, "--format=%(refname)", PUBLIC_REFS]).stdout.trim());
}

function publishReviewed(
  root: string,
  sidecarPath: string,
  config: SidecarConfig,
  inbox: string,
  siblings: string[],
  stage: (name: string) => void,
  reviewFloor: boolean,
): SyncOutcome {
  stage("fetch");
  withPublicGit(sidecarPath, () => {
    fetchPublic(sidecarPath);
    // An emptied remote, or one this existing checkout predates: start main
    // there the gated way, so reviews have a public base to measure from.
    if (!publicTip(sidecarPath, config.branch)) bootstrapReviewedMain(sidecarPath, config);
    stage("publish");
    const open = openReview(sidecarPath);
    if (open?.state === "approved") publishApprovedReview(sidecarPath, config, inbox, open);
  });
  stage("merge");
  withPublicGit(sidecarPath, () => mergeFetchedInboxes(sidecarPath, config, { forkFiles: true }));
  // Takes the remote's new main into local main, and this checkout's latest
  // snapshot with it, so the review below sees the whole family.
  stage("merge-local");
  mergeInboxBranches(sidecarPath, config, { forkFiles: true, push: false, remote: false });
  stage("settle-remote");
  settleCheckouts(sidecarPath, config, inbox, siblings);
  stage("review");
  // Inside withPublicGit so the packet shows the blobs an approval would
  // publish; the reviewer starts outside it, in the caller's environment.
  const gate = withPublicGit(sidecarPath, () => gateUnpublished(root, sidecarPath, config, reviewFloor));
  if (!gate) return {};
  if ("due" in gate) return { reviewDue: gate.due };
  if (gate.launch) launchReviewer(gate.review);
  return { held: { review: gate.review, attention: reviewAttention(gate.review) } };
}

/**
 * Opens, keeps, or retires the family's review so that it covers what local
 * main holds and the remote does not. One review is open at a time: work that
 * lands while one is undecided waits for the next, which batches review the
 * way the debounce batches pushes. Returns the review holding publication, if
 * any, and whether its reviewer should be launched — or, under the review
 * floor, when the next review may open.
 *
 * The floor: with `floor`, a review opens no sooner than the peer's debounce
 * after the family's previous one opened or launched. Without it, an approval
 * — whose sync runs this gate straight after publishing — opened the next
 * review at once, so under steady editing reviewers ran back to back, each
 * one's approval launching the next. Held to the floor, they run at most once
 * per remote round trip however they are triggered, and each covers whatever
 * accumulated in the meantime. A held review is recorded as due (see
 * writeReviewDue) so the daemon comes back for it when nothing else will.
 * Commands someone ran by hand skip the floor: they asked for it now.
 */
function gateUnpublished(
  root: string,
  sidecarPath: string,
  config: SidecarConfig,
  floor: boolean,
): { review: Review; launch: boolean } | { due: number } | undefined {
  const configPath = peerConfigPath(root, config.peer);
  const result = gateReview(root, sidecarPath, config, floor);
  if (result && "due" in result) writeReviewDue(configPath, result.due);
  else clearReviewDue(configPath);
  return result;
}

function gateReview(
  root: string,
  sidecarPath: string,
  config: SidecarConfig,
  floor: boolean,
): { review: Review; launch: boolean } | { due: number } | undefined {
  const head = git(sidecarPath, ["rev-parse", `refs/heads/${config.branch}`]).stdout.trim();
  const headTree = treeOf(sidecarPath, head);
  const publicMain = publicTip(sidecarPath, config.branch);
  // ensureMainBranch joins local main to the remote's, so this always finds
  // one. Failing that, nothing here has a public base to publish onto.
  const base = publicMain && git(sidecarPath, ["merge-base", head, publicMain], { check: false }).stdout.trim();
  if (!base) throw new SidecarError(`local ${config.branch} shares no history with the remote's; nothing is reviewed or published until it does`);
  const open = openReview(sidecarPath);
  const hasReviewer = Boolean(readSettings().reviewer);

  if (treeOf(sidecarPath, base) === headTree) {
    // Whatever an undecided review was waiting to publish is gone or already
    // public. An approval still publishes: it was given, and its tree is safe.
    if (open && open.state !== "approved") markSuperseded(open);
    return undefined;
  }
  if (open?.state === "pending" || open?.state === "approved") {
    // Each review launches its reviewer once. One configured after the review
    // opened takes it from here.
    return { review: open, launch: open.state === "pending" && !open.record.launchedAt && hasReviewer };
  }
  if (open) {
    // Rejected or failed: it holds until the content changes, and the change
    // is what the next review sees.
    if (open.record.tree === headTree) return { review: open, launch: false };
    markSuperseded(open);
  }
  if (floor) {
    const due = reviewFloorEndsAt(sidecarPath, config);
    if (due > Date.now()) {
      console.log(`the next review opens in ${Math.ceil((due - Date.now()) / 1000)}s; reviews open at most once per debounce`);
      return { due };
    }
  }
  const review = createReview({ root, config, sidecarPath, base, head });
  console.log(`opened review ${paint("brand", review.record.id)} for ${review.record.files.length} changed file(s)`);
  return { review, launch: hasReviewer };
}

/** When the family's previous review opened or launched, whichever was later, plus the peer's debounce (epoch ms). */
function reviewFloorEndsAt(sidecarPath: string, config: SidecarConfig): number {
  const previous = listReviews(sidecarPath)[0];
  if (!previous) return 0;
  const { createdAt, launchedAt } = previous.record;
  const started = Math.max(Date.parse(createdAt), launchedAt ? Date.parse(launchedAt) : 0);
  return started + (config.debounce ?? DEFAULT_DEBOUNCE_SECONDS) * 1000;
}

/**
 * Publishes an approved review as one new commit on this checkout's inbox
 * branch, then joins it to local main. Call inside withPublicGit.
 */
function publishApprovedReview(sidecarPath: string, config: SidecarConfig, inbox: string, review: Review): void {
  const { record } = review;
  // A sync that recorded its commit and then died — in this checkout or a
  // sibling — left the one commit this review may publish. Push that again,
  // to the inbox it was cut for, rather than cutting a second one.
  const target = record.publishing ?? { inbox, commit: cutPublishCommit(sidecarPath, config, inbox, record) };
  const protectRef = publishingRef(record.id);
  if (!isPublic(sidecarPath, target.commit)) {
    // The commit's parents must already be on the remote: anything else would
    // push their history along with it. A remote rewritten since the commit
    // was cut can drop one, so this holds for a resumed publish too.
    const parents = git(sidecarPath, ["rev-list", "--parents", "-n", "1", target.commit]).stdout.trim().split(" ").slice(1);
    if (!parents.every((parent) => isPublic(sidecarPath, parent))) {
      markSuperseded(review);
      git(sidecarPath, ["update-ref", "-d", protectRef], { check: false });
      console.log(`review ${paint("brand", record.id)} was measured from a commit the remote does not have; reviewing again`);
      return;
    }
    assertPublishDestination(sidecarPath);
    if (!record.publishing) {
      // Reachable from a ref before it is recorded, so gc cannot prune the
      // one commit a resumed publish would push.
      git(sidecarPath, ["update-ref", protectRef, target.commit]);
      markPublishing(review, target.inbox, target.commit);
    }
    // Never forced: the family is the inbox's only writer, so a rejection
    // means something is wrong, and overwriting would hide it.
    const push = git(sidecarPath, ["push", "--no-follow-tags", "origin", `${target.commit}:refs/heads/${target.inbox}`], { check: false });
    if (push.status !== 0) {
      throw new SidecarError(push.stderr.trim() || `could not publish review ${record.id} to ${target.inbox}`);
    }
    fetchPublic(sidecarPath);
    console.log(`published review ${paint("brand", record.id)} to ${paint("brand", target.inbox)}`);
  }
  linkPublished(sidecarPath, config, review, target.commit);
  markPublished(review, target.commit);
  git(sidecarPath, ["update-ref", "-d", protectRef], { check: false });
}

/** Keeps a review's prepared publish commit reachable until it is published or retired. Never pushed or fetched. */
function publishingRef(id: string): string {
  return `refs/sidecar-publishing/${id}`;
}

/**
 * Retires a review and opens a new one of the same change, with its own
 * reviewer launch. The retired review is closed, so its reviewer — still
 * running, perhaps — can no longer decide anything. Call under the peer's
 * sync lock.
 */
export function retryReview(review: Review): Review {
  const { record } = review;
  if (!isOpen(review)) throw new SidecarError(`review ${record.id} is already ${review.state}`);
  if (record.publishing) throw new SidecarError(`review ${record.id} is already being published`);
  // An approval is a decision, not a reviewer that broke; retrying would
  // quietly withdraw it.
  if (review.state === "approved") throw new SidecarError(`review ${record.id} is approved and publishes on the next sync`);
  const config = loadPeer(record.root, record.peer).config;
  const sidecarPath = requireSidecarCheckout(record.root, config);
  // Retired first: a retry that dies partway leaves no review open, and the
  // next sync opens one of whatever local main holds — never two.
  markSuperseded(review);
  const fresh = withPublicGit(sidecarPath, () =>
    createReview({ root: record.root, config, sidecarPath, base: record.base, head: record.head }));
  launchReviewer(fresh);
  return fresh;
}

/**
 * The reviewed tree as a commit: first parent the public commit the review
 * was measured from, second the inbox's previously published tip (unless the
 * base already contains it) so the push is a fast-forward. Write times for
 * last-writer-wins travel as carried trailers, since the snapshots that
 * recorded them stay behind.
 */
function cutPublishCommit(sidecarPath: string, config: SidecarConfig, inbox: string, record: ReviewRecord): string {
  const previous = publicTip(sidecarPath, inbox);
  const parents = [record.base, ...(previous && !isAncestor(sidecarPath, previous, record.base) ? [previous] : [])];
  const body = [
    "sidecar publish",
    "",
    `source: ${currentMachine()}`,
    `inbox: ${inbox}`,
    `review: ${record.id}`,
    ...publishedWriteTrailers(sidecarPath, config, record),
  ];
  return git(sidecarPath, [
    "commit-tree",
    record.tree,
    ...parents.flatMap((parent) => ["-p", parent]),
    "-m",
    body.join("\n"),
  ]).stdout.trim();
}

/**
 * Carried last-writer-wins clocks for the reviewed paths that resolve by lww.
 * The write events live in local snapshot trailers the remote never sees;
 * without these every published path would read as written at publish time.
 */
function publishedWriteTrailers(repo: string, config: SidecarConfig, record: ReviewRecord): string[] {
  const defaults = { resolve: config.resolve, redaction: config.redaction };
  const paths = record.files
    .map((file) => file.path)
    .filter((filePath) => resolveFileRules(config.rules, filePath, defaults).resolve === "lww");
  if (paths.length > WRITTEN_TRAILER_LIMIT) return [];
  // Nothing read out of a local commit message passes into a published one:
  // those messages are unreviewed, and a source or a clock can carry any text
  // shaped like one. Each path's write is this review's own, a token no other
  // write shares; its time is the recorded one, bounded to a plausible clock.
  const now = Math.floor(Date.now() / 1000);
  return paths.map((filePath) => {
    const { time } = lastWriteEvent(repo, record.head, filePath);
    return lwwWrittenTrailer(filePath, { time: Math.min(Math.max(0, time), now), source: `review-${record.id}` });
  });
}

/**
 * Joins the published commit to the local history it was cut from.
 *
 * The publish commit's parent is the public base, so on its own git would see
 * no relation between it and the local main it reproduces — and merging the
 * remote's main back in would measure every edit made since from that base,
 * turning each file touched after the approval into a conflict. A merge with
 * the "ours" strategy records that local main already contains the published
 * state without changing a file. Local main only grows, so the reviewed head
 * is in it; the link is never pushed, and every sibling inherits it when it
 * settles onto main.
 */
function linkPublished(sidecarPath: string, config: SidecarConfig, review: Review, published: string): void {
  const main = `refs/heads/${config.branch}`;
  if (isAncestor(sidecarPath, published, main)) return;
  // A main rebuilt from scratch no longer holds what was reviewed; claiming it
  // contains the published state would be a false merge that drops content.
  if (!isAncestor(sidecarPath, review.record.head, main)) {
    logSidecarEvent("review-link-skip", { sidecarPath, id: review.record.id });
    return;
  }
  withScratchWorktree(sidecarPath, config, "HEAD", (worktree) => {
    git(worktree, ["switch", config.branch]);
    git(worktree, ["merge", "--no-ff", "-s", "ours", "-m", `sidecar: link published review ${review.record.id}`, published]);
  });
}

/**
 * The canonical merge for a review-gated peer: the remote's main plus every
 * inbox as the remote has it. Local inbox branches never enter it — they hold
 * unpublished snapshots — so the merge result, and the push of it, is built
 * from public commits alone.
 */
export function mergePublishedInboxes(sidecarPath: string, config: SidecarConfig, options: { forkFiles: boolean }): number {
  return withPublicGit(sidecarPath, () => {
    fetchPublic(sidecarPath);
    return mergeFetchedInboxes(sidecarPath, config, options);
  });
}

/** mergePublishedInboxes over the public refs as already fetched. Call inside withPublicGit. */
function mergeFetchedInboxes(sidecarPath: string, config: SidecarConfig, options: { forkFiles: boolean }): number {
  if (!publicTip(sidecarPath, config.branch)) return 0;
  const publicMain = publicRef(config.branch);
  if (publishedInboxBranches(sidecarPath, config).every((ref) => isAncestor(sidecarPath, ref, publicMain))) {
    console.log("no published inbox branches to merge");
    return 0;
  }
  assertPublishDestination(sidecarPath);
  return withScratchWorktree(sidecarPath, config, publicMain, (worktree) => {
    // Config can differ by worktree (includeIf gitdir), so check here too.
    assertRedactionFilterIntact(worktree);
    const maxAttempts = 3;
    for (let attempt = 1; ; attempt += 1) {
      if (attempt > 1) {
        fetchPublic(sidecarPath);
        git(worktree, ["reset", "--hard", publicMain]);
      }
      const pending = publishedInboxBranches(worktree, config).filter((ref) => !isAncestor(worktree, ref, "HEAD"));
      if (!pending.length) {
        console.log("no published inbox branches to merge");
        return 0;
      }
      const merged: string[] = [];
      for (const ref of pending) {
        console.log(`merging ${paint("brand", remoteBranchName(ref))}`);
        if (mergeInboxBranch(worktree, config, ref, options)) merged.push(ref);
      }
      const push = git(worktree, ["push", "--no-follow-tags", "origin", `HEAD:refs/heads/${config.branch}`], { check: false });
      if (push.status !== 0) {
        if (attempt >= maxAttempts) throw new SidecarError(push.stderr.trim() || `could not push ${config.branch}`);
        console.log(`push of ${config.branch} was rejected; refetching and retrying`);
        continue;
      }
      // A push does not move the public refs, and the gate measures from
      // them: without this, it would see what was just merged as unpublished.
      fetchPublic(sidecarPath);
      console.log(`pushed ${config.branch}`);
      console.log(`merged ${merged.length} inbox branch(es)`);
      return merged.length;
    }
  });
}

/** Every inbox branch as the remote has it, including this checkout's own, as public refs. */
function publishedInboxBranches(repo: string, config: SidecarConfig): string[] {
  const prefix = inboxPrefix(config);
  return git(repo, ["for-each-ref", "--format=%(refname)", PUBLIC_REFS])
    .stdout.split(/\r?\n/)
    .map((ref) => ref.trim())
    .filter((ref) => ref && matchesInboxPrefix(prefix, ref.slice(PUBLIC_REFS.length)))
    .sort();
}

/**
 * Brings this checkout and its siblings up to the main branch as it now stands.
 *
 * Propagation is the cheap half of a sync and deliberately carries no debounce
 * of its own: the objects are already in the shared store, so each sibling is
 * one fast-forward and a working-tree write from current. It runs as the tail
 * of whichever phase advanced the branch, which is to say exactly as often as
 * there is something to move.
 *
 * Siblings are best effort. One mid-edit is dirty and gets skipped — its own
 * watcher reconciles it moments later — and no sibling may fail the sync that
 * is only doing it a favour.
 */
export function settleCheckouts(
  sidecarPath: string,
  config: SidecarConfig,
  inbox: string,
  siblings: string[],
): void {
  refreshInboxFromMain(sidecarPath, config, inbox);

  let settled = 0;
  for (const sibling of siblings) {
    try {
      // A dirty checkout or its failing required filter belongs to that
      // sibling's next sync. Never rebind its policy to get this sync through.
      if (isDirty(sibling)) continue;
      if (git(sibling, ["merge", "--ff-only", config.branch], { check: false }).status === 0) settled += 1;
    } catch (error) {
      logSidecarEvent("settle-skip", {
        sidecarPath: sibling,
        // Git's message can quote a path nobody has reviewed yet.
        ...(reviewRequired(config) ? {} : { message: error instanceof Error ? error.message : String(error) }),
      });
    }
  }
  if (settled) logSidecarEvent("settle", { sidecarPath, siblings: settled });
}

/**
 * The other working copies of this sidecar on this machine.
 *
 * Asked of git rather than of the instance registry: the worktree list is the
 * authoritative set, it needs no bookkeeping to stay true, and it is right even
 * where the registry is unavailable.
 */
function siblingCheckouts(sidecarPath: string, config: SidecarConfig): string[] {
  const result = git(sidecarPath, ["worktree", "list", "--porcelain"], { check: false });
  if (result.status !== 0) return [];
  const self = realpathOr(sidecarPath);
  const prefix = inboxPrefix(config);

  // Only a checkout parked on an inbox branch is sidecar's. That rules out the
  // detached merge scratch worktree, one mid-switch on the main branch, and — in
  // a standalone repo, where the sidecar is the user's own repo — the user's own
  // worktrees, whatever branch they hold. Narrowing here rather than at the
  // point of use keeps the count honest: it is what decides whether the local
  // phase is worth running at all, and worktrees it would never settle used to
  // buy a whole merge pass that settled nothing.
  //
  // The listing already names each branch, so this costs no extra git call. A
  // detached worktree has no branch line and so is never collected.
  const siblings: string[] = [];
  let checkout = "";
  for (const line of result.stdout.split(/\r?\n/)) {
    if (line.startsWith("worktree ")) {
      checkout = line.slice("worktree ".length).trim();
    } else if (line.startsWith("branch ")) {
      const branch = line.slice("branch ".length).trim().replace(/^refs\/heads\//, "");
      if (checkout && realpathOr(checkout) !== self && matchesInboxPrefix(prefix, branch)) {
        siblings.push(checkout);
      }
    }
  }
  return siblings;
}

// ---------------------------------------------------------------------------
// Fleet health
//
// See health.ts for why this is a heartbeat on its own branch namespace rather
// than an alert file on the main branch. What lives here is the git side of it:
// a publish path that shares as little as possible with the sync path it
// reports on, so a broken clean filter or a wedged checkout can still be
// announced by the machine it broke on.
// ---------------------------------------------------------------------------

/**
 * The branch this checkout reports on — per checkout rather than per machine,
 * matching the inbox, because two clones of a project on one laptop are two
 * things that can fail independently.
 */
function healthBranchFor(sidecarPath: string): string {
  return healthBranch(slug(currentUser()), checkoutRandom(sidecarPath));
}

/**
 * Publishes what a sync attempt turned out to be.
 *
 * Never throws. A heartbeat that could fail the sync it is reporting on would
 * be worse than no heartbeat at all — the same rule `logSidecarEvent` follows,
 * and the reason the failure path can call this before rethrowing.
 */
export function reportSyncHealth(root: string, config: SidecarConfig, outcome: HealthOutcome): void {
  try {
    const sidecarPath = resolveSidecarPath(root, config);
    // No checkout means no refs to publish through. The failure is real, but
    // it's in the local log and there is nowhere to say so from.
    if (!hasGitMetadata(sidecarPath)) return;

    // The previous record is read inside withPublicGit too: what it carries
    // forward must be the blob the remote has, not a local replacement.
    withPublicGit(sidecarPath, () => publishHealth(root, config, sidecarPath, outcome));
  } catch (error) {
    logSidecarEvent("failure", {
      command: "health",
      root,
      message: reviewRequired(config)
        ? "could not publish health"
        : `could not publish health: ${error instanceof Error ? error.message : String(error)}`,
    });
  }
}

function publishHealth(root: string, config: SidecarConfig, sidecarPath: string, outcome: HealthOutcome): void {
  const branch = healthBranchFor(sidecarPath);
  const gated = reviewRequired(config);
  // A gated peer reads the remote's own record, as fetchPublic saw it. A
  // completed sync fetched after its last push; a failed one may not have
  // fetched at all, so it does here — and when it cannot, the push below
  // most likely cannot either.
  if (gated && outcome.status === "failed") {
    try { fetchPublic(sidecarPath); } catch { /* offline: as last fetched */ }
  }
  const previous = readHealthRecordAt(sidecarPath, gated ? publicRef(branch) : `origin/${branch}`);
  const identity: HealthIdentity = {
    machine: currentMachine(),
    root,
    peer: config.peer === DEFAULT_PEER ? undefined : config.peer,
    inbox: expandInbox(config, sidecarPath),
    version: packageVersion(),
  };
  const record = nextHealthRecord(previous, identity, outcome, nowIso());
  if (!shouldPublishHealth(previous, record)) return;
  if (gated) assertPublishDestination(sidecarPath);
  publishHealthRecord(sidecarPath, branch, record);
  logSidecarEvent("health", {
    branch,
    status: record.status,
    stage: record.stage,
    consecutiveFailures: record.consecutiveFailures,
  });
}

/**
 * Writes the heartbeat with plumbing, deliberately touching nothing the sync
 * path uses: no working tree, no index, no branch checkout, and — because
 * `hash-object --stdin` has no path to key an attribute off — no clean filter.
 * That is what lets a machine whose `git add` fails still report why.
 *
 * Each heartbeat is a fresh root commit, force-pushed. History of a liveness
 * ping has no value worth the unbounded growth, and being the branch's only
 * writer means a force push can never lose someone else's work.
 */
function publishHealthRecord(sidecarPath: string, branch: string, record: HealthRecord): void {
  const blob = git(sidecarPath, ["hash-object", "-w", "--stdin"], {
    input: serializeHealthRecord(record),
  }).stdout.trim();
  const tree = git(sidecarPath, ["mktree"], {
    input: `100644 blob ${blob}\t${HEALTH_FILE}\n`,
  }).stdout.trim();
  // Identity comes from withPublicGit's environment rather than repo config,
  // so publishing doesn't depend on a config write having succeeded first.
  const commit = git(sidecarPath, ["commit-tree", tree, "-m", `health: ${record.status} — ${record.machine}`]).stdout.trim();
  git(sidecarPath, ["push", "--no-follow-tags", "--force", "origin", `${commit}:refs/heads/${branch}`]);
}

/** Reads a heartbeat straight out of a ref; `git show` on a blob is unfiltered. */
function readHealthRecordAt(sidecarPath: string, ref: string): HealthRecord | undefined {
  const result = git(sidecarPath, ["show", `${ref}:${HEALTH_FILE}`], { check: false });
  if (result.status !== 0) return undefined;
  return parseHealthRecord(result.stdout);
}

type FleetHealthEntry = {
  branch: string;
  self: boolean;
  state: HealthState;
  record: HealthRecord;
};

/** Every checkout's last word about itself, worst first. */
export function readFleetHealth(sidecarPath: string): FleetHealthEntry[] {
  const self = healthBranchFor(sidecarPath);
  const refs = git(sidecarPath, ["branch", "-r", "--format=%(refname:short)"])
    .stdout.split(/\r?\n/)
    .map((ref) => ref.trim())
    .filter((ref) => ref && ref !== "origin/HEAD" && isHealthBranch(ref));

  const entries: FleetHealthEntry[] = [];
  for (const ref of refs) {
    const record = readHealthRecordAt(sidecarPath, ref);
    // A health branch this version can't read is a branch, not a machine —
    // counting it would put an unexplainable row in the fleet view.
    if (!record) continue;
    const branch = remoteBranchName(ref);
    entries.push({ branch, self: branch === self, state: classifyHealthState(record), record });
  }

  // Worst first: the point of the view is the machine that needs you.
  const rank: Record<HealthState, number> = { failed: 0, stale: 1, ok: 2 };
  return entries.sort(
    (left, right) =>
      rank[left.state] - rank[right.state] ||
      left.record.machine.localeCompare(right.record.machine) ||
      left.branch.localeCompare(right.branch),
  );
}

export function mergeInboxBranches(
  sidecarPath: string,
  config: SidecarConfig,
  options: { forkFiles: boolean; push: boolean; remote: boolean },
): number {
  // No clean checkout required: the merge runs in a scratch worktree, and a
  // sync's snapshot has already captured what this one is merging. An edit
  // landing since is the next sync's to capture — failing this one for it
  // meant a sync could never finish while someone kept typing.
  ensureCommitIdentity(sidecarPath);

  // Most syncs have no merge work. Detect that from refs alone, before paying
  // for a worktree checkout — asking exactly what the merge loop would ask, so
  // the two cannot disagree: is any inbox branch still outside local main? A
  // local merge sees only what this machine holds and does not fetch; a remote
  // one fetches first, so the same question also covers the other machines.
  if (options.remote) fetch(sidecarPath, false);
  // A main that lacks the remote's latest is work too, merge or not: bringing
  // it current is ensureMainBranch's job, inside the worktree below.
  if (!hasPendingInboxWork(sidecarPath, config) && mainContainsRemote(sidecarPath, config)) {
    // Nothing to merge, but the local phase advances main before the remote
    // phase runs, so main is routinely owed to the remote with no merge behind
    // it. Sending a branch needs no checkout — and so needs no worktree. A
    // rejected push means another machine moved main and this is a real
    // reconcile after all, so fall through and do it properly.
    if (options.push && !mainMatchesRemote(sidecarPath, config)) {
      const push = git(sidecarPath, ["push", "--no-follow-tags", "origin", `refs/heads/${config.branch}:refs/heads/${config.branch}`], {
        check: false,
      });
      if (push.status === 0) {
        console.log(`pushed ${config.branch}`);
        return 0;
      }
      console.log(`push of ${config.branch} was rejected; refetching and retrying`);
    } else {
      console.log("no inbox branches to merge");
      return 0;
    }
  }

  // Merging switches branches, which rewrites working-tree files from
  // committed (redacted) blobs. The user's checkout keeps the unredacted
  // originals, so the branch dance happens in a throwaway linked worktree
  // and the checkout never leaves the inbox branch.
  // No commits means no worktree to protect (`worktree add` refuses an
  // unborn HEAD), and nothing to rewrite either — but the merge runs in the
  // checkout itself, so it must hold nothing uncaptured.
  if (!hasAnyCommit(sidecarPath)) {
    ensureClean(sidecarPath);
    return mergeInboxBranchesAt(sidecarPath, config, options);
  }
  // A checkout parked on the main branch would block the worktree from
  // switching to it. Sidecar owns this checkout's branch, so move back to the
  // inbox branch rather than merging in place and rewriting the user's files —
  // once nothing uncommitted rides along.
  if (git(sidecarPath, ["branch", "--show-current"]).stdout.trim() === config.branch) {
    ensureClean(sidecarPath);
    ensureInboxBranch(sidecarPath, config, expandInbox(config, sidecarPath));
  }
  return withScratchWorktree(sidecarPath, config, "HEAD", (worktree) => mergeInboxBranchesAt(worktree, config, options));
}

/**
 * Runs `fn` in a throwaway linked worktree detached at `start`, with this
 * checkout's redaction policy bound to it. Merges happen there so the user's
 * checkout never switches branches.
 */
function withScratchWorktree<T>(sidecarPath: string, config: SidecarConfig, start: string, fn: (worktree: string) => T): T {
  // A deterministic path (rather than mkdtemp) lets a new sync reclaim the
  // worktree a killed sync left behind; a stale registration would otherwise
  // block `git switch <main>` in every future merge. The sync lock prevents
  // two live syncs from colliding on it.
  const scratch = path.join(
    os.tmpdir(),
    `sidecar-merge-${crypto.createHash("sha1").update(sidecarPath).digest("hex").slice(0, 12)}`,
  );
  const worktree = path.join(scratch, "checkout");
  git(sidecarPath, ["worktree", "remove", "--force", worktree], { check: false });
  fs.rmSync(scratch, { recursive: true, force: true });
  git(sidecarPath, ["worktree", "prune", "--expire", "now"], { check: false });
  try {
    git(sidecarPath, ["worktree", "add", "--detach", worktree, start]);
    ensureRedactionFilter(worktree, config.redaction, config);
    return fn(worktree);
  } finally {
    git(sidecarPath, ["worktree", "remove", "--force", worktree], { check: false });
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}

function mainMatchesRemote(repo: string, config: SidecarConfig): boolean {
  const localRef = `refs/heads/${config.branch}`;
  const remoteRef = `refs/remotes/origin/${config.branch}`;
  const refs = new Map(
    git(repo, ["for-each-ref", "--format=%(refname) %(objectname)", localRef, remoteRef])
      .stdout.split(/\r?\n/)
      .filter(Boolean)
      .map((line) => line.split(" ", 2) as [string, string]),
  );
  const local = refs.get(localRef);
  const remote = refs.get(remoteRef);
  return local !== undefined && local === remote;
}

/** Whether local main already holds everything the remote's main does. */
function mainContainsRemote(repo: string, config: SidecarConfig): boolean {
  if (!remoteRefExists(repo, config.branch) || !branchExists(repo, config.branch)) return true;
  return isAncestor(repo, `origin/${config.branch}`, `refs/heads/${config.branch}`);
}

/** Whether any inbox branch still sits outside the local main branch. */
function hasPendingInboxWork(repo: string, config: SidecarConfig): boolean {
  const main = `refs/heads/${config.branch}`;
  return pendingInboxBranches(repo, config).some((branch) => !isAncestor(repo, branch, main));
}

function mergeInboxBranchesAt(
  sidecarPath: string,
  config: SidecarConfig,
  options: { forkFiles: boolean; push: boolean },
): number {
  // Two machines can merge and push concurrently; the loser's push of the
  // main branch is rejected. Each attempt refetches, lets ensureMainBranch
  // reconcile with whatever the winner pushed, and re-merges what's still
  // pending, so a lost race heals instead of wedging every later sync.
  const maxAttempts = 3;
  for (let attempt = 1; ; attempt += 1) {
    // The wrapper fetched just before the first attempt; refetch on retries
    // to pick up whatever the winning machine pushed.
    if (attempt > 1) fetch(sidecarPath, false);
    ensureMainBranch(sidecarPath, config);

    const inboxBranches = pendingInboxBranches(sidecarPath, config).filter(
      (remoteBranch) => !isAncestor(sidecarPath, remoteBranch, "HEAD"),
    );
    // Nothing left to merge is not the same as nothing left to do: the local
    // phase merges into main before the remote phase runs, so by here the work
    // is routinely already in main and still owed to the remote.
    const mainOwedToRemote = options.push && !mainMatchesRemote(sidecarPath, config);
    if (!inboxBranches.length && !mainOwedToRemote && attempt === 1) {
      console.log("no inbox branches to merge");
      return 0;
    }

    const merged: string[] = [];
    for (const remoteBranch of inboxBranches) {
      console.log(`merging ${paint("brand", remoteBranch)}`);
      if (mergeInboxBranch(sidecarPath, config, remoteBranch, options)) merged.push(remoteBranch);
    }

    if (options.push) {
      const push = git(
        sidecarPath,
        ["push", "--no-follow-tags", "-u", "origin", `HEAD:refs/heads/${config.branch}`],
        { check: false },
      );
      if (push.status !== 0) {
        if (attempt >= maxAttempts) {
          throw new SidecarError(push.stderr.trim() || `could not push ${config.branch}`);
        }
        console.log(`push of ${config.branch} was rejected; refetching and retrying`);
        continue;
      }
      console.log(`pushed ${config.branch}`);
    }

    console.log(`merged ${merged.length} inbox branch(es)`);
    return merged.length;
  }
}

/** Merge into the current branch, applying path policy before any commit. */
export function mergeInboxBranch(
  repo: string,
  config: SidecarConfig,
  remoteBranch: string,
  options: { forkFiles: boolean },
): boolean {
  if (isAncestor(repo, remoteBranch, "HEAD")) return false;
  // --no-ff prevents a fast-forward from bypassing --no-commit. Disabling
  // rename detection makes path rules apply consistently to delete/add pairs.
  try {
    const result = git(repo, ["merge", "--no-ff", "--no-commit", "-Xno-renames", remoteBranch], { check: false });
    if (result.status !== 0 && !hasUnmergedPaths(repo)) {
      throw new SidecarError(result.stderr.trim() || `merge failed for ${remoteBranch}`);
    }
    resolveMergeConflicts(repo, config, remoteBranch, options);
    return true;
  } catch (error) {
    // Inbox reconciliation can run in the live checkout. Never leave Git's
    // provisional content merge for a later snapshot to commit accidentally.
    try { git(repo, ["merge", "--abort"], { check: false }); } catch { /* preserve the original failure */ }
    throw error;
  }
}

/** Apply whole-file LWW even to Git-clean merges, resolve forks, and commit once. */
export function resolveMergeConflicts(
  repo: string,
  config: SidecarConfig,
  remoteBranch: string,
  options: { forkFiles: boolean },
): void {
  const paths = Object.keys(unmergedPaths(repo));
  const forkPaths = paths.filter((filePath) => resolveFileRules(config.rules, filePath, {
    resolve: config.resolve, redaction: config.redaction,
  }).resolve === "fork");

  // Refuse before modifying any path when a fork needs explicit permission.
  if (forkPaths.length && !options.forkFiles) {
    git(repo, ["merge", "--abort"], { check: false });
    throw new SidecarError(`merge conflict in ${remoteBranch}; rerun with --fork-files`);
  }
  const lwwEnabled = config.resolve === "lww" || config.rules?.some((rule) => rule.resolve === "lww");
  const writes = lwwEnabled ? mergeWrittenPaths(repo, remoteBranch) : undefined;
  const lwwPaths = writes ? [...new Set([...paths, ...writes.ours, ...writes.theirs])].filter((filePath) =>
    resolveFileRules(config.rules, filePath, { resolve: config.resolve, redaction: config.redaction }).resolve === "lww",
  ) : [];
  const written = lwwPaths.length ? resolveLastWriterWins(repo, config.branch, remoteBranch, lwwPaths, writes) : [];
  if (forkPaths.length) forkConflicts(repo, remoteBranch, forkPaths);
  if (hasUnmergedPaths(repo)) throw new SidecarError("per-path resolution did not clear all unmerged paths");

  const suffix = forkPaths.length ? " with forked conflict files" : lwwPaths.length ? ", last writer wins" : "";
  git(repo, ["commit", "-m", [`Merge ${remoteBranch}${suffix}`, ...written].join("\n\n")]);
}

// Net tree differences miss explicit revert writes and newer writes that
// happen to produce identical blobs. Include paths written anywhere in both
// histories since the common ancestor, including deletions and merge edits.
type MergeWrites = { base: string; ours: Set<string>; theirs: Set<string> };
function mergeWrittenPaths(repo: string, remoteBranch: string): MergeWrites {
  const base = git(repo, ["merge-base", "HEAD", remoteBranch]).stdout.trim();
  if (!base) throw new SidecarError(`could not find common history with ${remoteBranch}`);
  const paths = (ref: string): Set<string> => new Set(git(repo, ["log", "--format=", "--name-only", "-z", "--no-renames", "--diff-merges=first-parent", `${base}..${ref}`])
    .stdout.split("\0").filter(Boolean));
  return { base, ours: paths("HEAD"), theirs: paths(remoteBranch) };
}

/**
 * The family primary's own sidecar checkout, created if it does not exist yet.
 *
 * Creating it is the point: a secondary is as likely to run `sidecar clone`
 * first as the primary is — a fresh jj workspace does exactly that through
 * postinstall — and the worktree it needs has to hang off something. A primary
 * that declares no sidecar, or a different one, is not ours to populate.
 */
export function familySidecarCheckout(root: string, config: SidecarConfig): string | undefined {
  const primary = familyPrimaryRoot(root);
  if (!primary) return undefined;

  // The same peer at the primary: a family shares one clone per peer, and a
  // primary that declares this peer with another remote is not ours to populate.
  let primaryConfig: SidecarConfig;
  try {
    primaryConfig = readConfig(peerConfigPath(primary, config.peer));
  } catch {
    return undefined;
  }
  if (!sharesFamilyCheckout(primaryConfig, config)) return undefined;

  const primaryPath = resolveSidecarPath(primary, primaryConfig);
  if (path.resolve(primaryPath) === path.resolve(primary)) return undefined;
  if (!hasGitMetadata(primaryPath)) cloneOrUpdate(primary, primaryConfig, true);
  return hasGitMetadata(primaryPath) ? primaryPath : undefined;
}

/**
 * Reconnects a linked checkout whose worktree pointer went stale, which is what
 * moving the repo on disk does to every linked worktree — git's own included.
 * Repair needs the new path spelled out; the argument-less form does not find
 * it.
 */
function repairLinkedCheckout(root: string, config: SidecarConfig, sidecarPath: string): void {
  if (git(sidecarPath, ["rev-parse", "--git-dir"], { check: false }).status === 0) return;

  const primaryPath = familySidecarCheckout(root, config);
  if (primaryPath && git(primaryPath, ["worktree", "repair", sidecarPath], { check: false }).status === 0) {
    logSidecarEvent("checkout-repair", { root, sidecarPath });
    return;
  }
  // Unrepairable here: a moved repo breaks the working copy this checkout hangs
  // off before it breaks the checkout, and that has to be fixed first. Say so —
  // every git call from here reports something else as the problem.
  throw new SidecarError(
    `sidecar checkout at ${sidecarPath} is not a usable Git checkout; if this repo moved, repair it there first (\`git worktree repair\`), or delete the checkout and run \`sidecar clone\``,
  );
}

/**
 * A secondary checkout that never joined its repo family's shared Git store: a
 * full clone from before family linking worked, or from a jj workspace whose
 * default workspace could not be resolved. A clone's `.git` is a directory; a
 * linked worktree's is a file.
 *
 * This is a diagnosis, not a fault, and nothing acts on it unasked. An
 * independent clone syncs correctly — it just trades with its siblings through
 * the remote instead of the object store they already share, so it is slower
 * and needs the network to settle. `sidecar refresh` converts it, destructively,
 * when the user asks.
 */
export function checkoutIsUnlinkedFromFamily(
  root: string,
  config: SidecarConfig,
  sidecarPath: string,
): boolean {
  if (isStandalone(config)) return false;
  try {
    if (!fs.statSync(path.join(sidecarPath, ".git")).isDirectory()) return false;
  } catch {
    return false;
  }

  const primary = familyPrimaryRoot(root);
  if (!primary) return false;
  try {
    return sharesFamilyCheckout(readConfig(peerConfigPath(primary, config.peer)), config);
  } catch {
    return false;
  }
}

/**
 * Whether a working copy may share the family primary's checkout. A shared
 * store's local history is every sharer's to publish, so a peer that requires
 * review never shares one with a peer that does not: see bindReviewPolicy.
 */
function sharesFamilyCheckout(primaryConfig: SidecarConfig, config: SidecarConfig): boolean {
  return primaryConfig.remote === config.remote && reviewRequired(primaryConfig) === reviewRequired(config);
}

const REVIEW_POLICY_KEY = "sidecar.review";

/**
 * Binds a checkout's shared store to review, or refuses a peer that would
 * publish it unreviewed. Sibling checkouts share one store, local inbox
 * branches and local main included, and an ungated sync merges and pushes
 * all of it — so once a gated peer has used a store, the store says so, and
 * every peer that writes through it must be gated too. A family whose
 * policies drift apart after linking fails closed here, on whichever side
 * syncs first. Call before anything is snapshotted, merged, or pushed.
 */
export function bindReviewPolicy(sidecarPath: string, config: SidecarConfig): void {
  const bound = git(sidecarPath, ["config", "--local", "--get", REVIEW_POLICY_KEY], { check: false }).stdout.trim();
  if (reviewRequired(config)) {
    if (bound !== "required") git(sidecarPath, ["config", "--local", REVIEW_POLICY_KEY, "required"]);
    return;
  }
  if (bound === "required") {
    throw new SidecarError(
      `${sidecarPath} holds work from a peer that requires review, and this peer would publish it unreviewed; set review = "required" in this repo's ${peerFileName(config.peer)} too — or, to publish that work without review, \`git -C ${sidecarPath} config --unset ${REVIEW_POLICY_KEY}\``,
    );
  }
}

export function cloneOrUpdate(
  root: string,
  config: SidecarConfig,
  bootstrapMain: boolean,
  options?: { checkoutId?: string },
): void {
  const sidecarPath = resolveSidecarPath(root, config);
  if (fs.existsSync(sidecarPath) && !hasGitMetadata(sidecarPath)) {
    if (fs.readdirSync(sidecarPath).length) {
      throw new SidecarError(`${sidecarPath} exists and is not an empty Git repo`);
    }
    fs.rmdirSync(sidecarPath);
  }

  if (!fs.existsSync(sidecarPath)) {
    const primaryPath = familySidecarCheckout(root, config);
    // Detached, because the inbox branch is named after this worktree's own git
    // dir — which does not exist until the worktree does. ensureInboxBranch
    // below puts it on its branch.
    if (primaryPath) git(primaryPath, ["worktree", "add", "--detach", sidecarPath]);
    else gitRaw(["clone", "--", config.remote, sidecarPath]);
  } else if (hasGitMetadata(sidecarPath)) {
    const existing = git(sidecarPath, ["remote", "get-url", "origin"], { check: false });
    if (existing.status !== 0) {
      git(sidecarPath, ["remote", "add", "origin", config.remote]);
    } else if (existing.stdout.trim() !== config.remote) {
      // A standalone sidecar syncs to "this repo's origin" by definition; the
      // URL in the committed .sidecar is just how the machine that wrote it
      // reached the same repo. A clone made over another scheme (ssh vs
      // https) is not a conflict — origin wins.
      if (!isStandalone(config)) {
        throw new SidecarError(`sidecar origin is ${existing.stdout.trim()}; expected ${config.remote}`);
      }
      console.log(
        `using origin ${paint("brand", existing.stdout.trim())} ${paint("quiet", `(.sidecar says ${config.remote})`)}`,
      );
    }
    fetch(sidecarPath, true);
  } else {
    throw new SidecarError(`${sidecarPath} is not usable as a sidecar checkout`);
  }

  // Before expandInbox below, which reads the id to name the inbox branch. A
  // refresh passes the id of the checkout it just replaced so the rebuilt one
  // claims the same inbox instead of stranding it on the remote.
  if (options?.checkoutId) {
    fs.writeFileSync(path.join(gitDir(sidecarPath), "sidecar-id"), `${options.checkoutId}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
  }

  ensureCommitIdentity(sidecarPath);
  ensureRedactionFilter(sidecarPath, config.redaction, config);
  bindReviewPolicy(sidecarPath, config);
  if (bootstrapMain) bootstrapMainBranch(sidecarPath, config);

  const inbox = expandInbox(config, sidecarPath);
  ensureInboxBranch(sidecarPath, config, inbox);
  console.log(`sidecar checkout ready at ${paint("brand", sidecarPath)}`);
}

export function bootstrapMainBranch(repo: string, config: SidecarConfig): void {
  if (remoteRefExists(repo, config.branch)) return;

  if (reviewRequired(config)) {
    withPublicGit(repo, () => bootstrapReviewedMain(repo, config));
    return;
  }
  if (hasAnyCommit(repo)) {
    const current = git(repo, ["branch", "--show-current"]).stdout.trim();
    if (current !== config.branch) {
      if (branchExists(repo, config.branch)) {
        git(repo, ["switch", config.branch]);
      } else {
        git(repo, ["switch", "-c", config.branch]);
      }
    }
    pushBranch(repo, config.branch);
    return;
  }

  git(repo, ["switch", "--orphan", config.branch]);
  // A standalone repo is the user's own; seeding it with a scratchpad README
  // would be putting our furniture in their house. An empty commit is enough
  // to give the branch a root.
  if (isStandalone(config)) {
    git(repo, ["commit", "--allow-empty", "-m", "Initialize sidecar"]);
    pushBranch(repo, config.branch);
    return;
  }
  fs.writeFileSync(
    path.join(repo, "README.md"),
    `# Sidecar

Scratch space for a code repository: plans, notes, and agent context.
This is a plain git repo you own — read it, edit it, clone it anywhere.
Kept in sync by [sidecar](https://github.com/endograph/sidecar).
`,
    "utf8",
  );
  git(repo, ["add", "README.md"]);
  git(repo, ["commit", "-m", "Initialize sidecar"]);
  pushBranch(repo, config.branch);
}

/**
 * Starts the remote's main for a review-gated peer. Whatever the checkout
 * holds — history, or files staged in an unborn repo — would publish
 * unreviewed through an ordinary first commit, so the remote gets a root
 * commit of the empty tree, made with plumbing that reads neither HEAD nor the
 * index. Existing local history is linked to it the way a publish is (see
 * linkPublished); the next sync then reviews everything the checkout holds as
 * one change from nothing. Call inside withPublicGit.
 */
function bootstrapReviewedMain(repo: string, config: SidecarConfig): void {
  assertPublishDestination(repo);
  const root = git(repo, ["commit-tree", emptyTree(repo), "-m", "Initialize sidecar"]).stdout.trim();
  git(repo, ["push", "--no-follow-tags", "origin", `${root}:refs/heads/${config.branch}`]);
  fetchPublic(repo);
  console.log(`started ${config.branch} on the remote empty; this checkout's content is published through review`);
  const ref = `refs/heads/${config.branch}`;
  // Unborn: local main starts at the public root. Nothing staged is touched;
  // it reaches the inbox at the next snapshot and is reviewed from there.
  if (!hasAnyCommit(repo)) {
    git(repo, ["update-ref", ref, root]);
    return;
  }
  const local = git(repo, ["rev-parse", "--verify", "--quiet", ref], { check: false }).stdout.trim()
    || git(repo, ["rev-parse", "HEAD"]).stdout.trim();
  // A merge commit of local main's own tree: no file changes, whether or not
  // main is checked out anywhere.
  const link = git(repo, ["commit-tree", treeOf(repo, local), "-p", local, "-p", root, "-m", "sidecar: link the remote's initial main"]).stdout.trim();
  git(repo, ["update-ref", ref, link]);
}

export function ensureMainBranch(repo: string, config: SidecarConfig): void {
  if (branchExists(repo, config.branch)) {
    git(repo, ["switch", config.branch]);
  } else if (remoteRefExists(repo, config.branch)) {
    git(repo, ["switch", "-c", config.branch, "--track", `origin/${config.branch}`]);
  } else if (hasAnyCommit(repo)) {
    git(repo, ["switch", "-c", config.branch]);
  } else {
    bootstrapMainBranch(repo, config);
    return;
  }

  if (!remoteRefExists(repo, config.branch)) return;
  const remoteBranch = `origin/${config.branch}`;
  // One symmetric-difference walk tells us both ancestry directions. The
  // left count is commits unique to HEAD; the right count is commits unique
  // to the remote branch.
  const [localOnly, remoteOnly] = git(repo, ["rev-list", "--left-right", "--count", `HEAD...${remoteBranch}`])
    .stdout.trim()
    .split(/\s+/)
    .map(Number);
  if (remoteOnly === 0) return;
  if (localOnly === 0) {
    git(repo, ["merge", "--ff-only", remoteBranch]);
    return;
  }
  // A review-gated peer's local main is this machine's whole view: the
  // remote's main with every unpublished local merge on top, including the
  // link that joins each published commit to the history it was cut from
  // (see linkPublished). Resetting it would discard those links, so it takes
  // the remote's side in as a merge instead.
  if (reviewRequired(config)) {
    if (git(repo, ["merge-base", "HEAD", remoteBranch], { check: false }).status !== 0) {
      // The remote's main was started over. Join it the way bootstrap does: a
      // commit of local main's own tree, so nothing local is lost and the
      // next review measures everything here from the new public base.
      const link = git(repo, ["commit-tree", treeOf(repo, "HEAD"), "-p", "HEAD", "-p", remoteBranch, "-m", `sidecar: link the remote's new ${config.branch}`]).stdout.trim();
      git(repo, ["merge", "--ff-only", link]);
      console.log(`${remoteBranch} was started over; local ${config.branch} is joined to it and reviewed from there`);
      return;
    }
    mergeInboxBranch(repo, config, remoteBranch, { forkFiles: true });
    return;
  }
  // Diverged: another machine won a push race. Local commits beyond the
  // remote are only sidecar-generated inbox merges, so the remote side wins
  // and any still-pending inbox branches get re-merged on top of it.
  // This reset is the one destructive step in a sync, so park the discarded
  // tip under refs/sidecar-discarded/ first. It costs one ref write, never
  // leaves the machine (pushes and fetches only touch refs/heads/*), and
  // turns "gone" into "findable" if that invariant ever fails to hold.
  // The tip's own hash in the name keeps two same-second resets from
  // overwriting each other: a collision then requires the same tip, where
  // both writes record the same thing anyway.
  const tip = git(repo, ["rev-parse", "--short", "HEAD"]).stdout.trim();
  const discarded = `refs/sidecar-discarded/${config.branch}/${utcTimestamp()}-${tip}`;
  git(repo, ["update-ref", discarded, "HEAD"], { check: false });
  console.log(`${config.branch} diverged from ${remoteBranch}; old tip kept at ${paint("brand", discarded)}`);
  git(repo, ["reset", "--hard", remoteBranch]);
}

export function ensureInboxBranch(repo: string, config: SidecarConfig, inbox: string): void {
  const current = git(repo, ["branch", "--show-current"]).stdout.trim();
  if (current === inbox) return;

  if (branchExists(repo, inbox)) {
    git(repo, ["switch", inbox]);
    return;
  }

  if (remoteRefExists(repo, inbox)) {
    git(repo, ["switch", "-c", inbox, "--track", `origin/${inbox}`]);
    return;
  }

  // A standalone checkout is the user's live working tree, and a dotfiles
  // repo routinely sits ahead of its origin. Fork its inbox from HEAD:
  // creating a branch in place never rewrites files, where starting from an
  // older origin/<main> rolls the tree back to the pushed state — or refuses
  // to overwrite dirty files and kills init halfway. Anything HEAD is missing
  // comes back through the first inbox merge.
  if (isStandalone(config) && hasAnyCommit(repo)) {
    git(repo, ["switch", "-c", inbox]);
    return;
  }

  if (remoteRefExists(repo, config.branch)) {
    git(repo, ["switch", "-c", inbox, `origin/${config.branch}`]);
    return;
  }

  if (branchExists(repo, config.branch)) {
    git(repo, ["switch", "-c", inbox, config.branch]);
    return;
  }

  if (hasAnyCommit(repo)) {
    git(repo, ["switch", "-c", inbox]);
    return;
  }

  bootstrapMainBranch(repo, config);
  git(repo, ["switch", "-c", inbox, config.branch]);
}

export function ensureSidecarCheckout(root: string, config: SidecarConfig): string {
  const sidecarPath = resolveSidecarPath(root, config);
  if (!hasGitMetadata(sidecarPath)) {
    cloneOrUpdate(root, config, true);
  } else {
    repairLinkedCheckout(root, config, sidecarPath);
  }
  return requireSidecarCheckout(root, config);
}

export function snapshot(
  repo: string,
  mainRoot: string,
  inbox: string,
  message = "sidecar snapshot",
  redactionMode: RedactionMode = DEFAULT_REDACTION_MODE,
  policy?: RedactionPolicy,
): boolean {
  // A failed or manual merge can leave cleanly merged content in the index.
  // Never turn that partial operation into an automatic snapshot, even if a
  // previous attempt to abort it failed.
  if (fs.existsSync(path.join(gitDir(repo), "MERGE_HEAD"))) {
    throw new SidecarError("cannot snapshot an unfinished merge; resolve or abort it before syncing");
  }
  // A filter change (new mode, moved node/CLI) doesn't invalidate git's stat
  // cache, so already-committed files would keep their old redaction state
  // forever; renormalize forces every tracked file back through the filter.
  // Deletions are staged first: renormalize stats every path still in the
  // index, and a tracked file gone from the working tree would fail it.
  const rewired = ensureRedactionFilter(repo, redactionMode, policy);
  // Filter config is shared by linked worktrees and may be repaired by merge
  // or init before this snapshot. Record the applied semantics beside each
  // checkout's index, only after it has staged and committed successfully.
  const revisionPath = path.join(gitDir(repo), "sidecar-redaction-revision");
  const revision = `${REDACTION_FILTER_REVISION}:${redactionMode}:${rulesFingerprint(policy?.rules)}`;
  let appliedRevision = "";
  try { appliedRevision = fs.readFileSync(revisionPath, "utf8"); } catch { /* first snapshot */ }
  git(repo, ["add", "-A"]);
  if ((rewired || appliedRevision !== revision) && hasAnyCommit(repo)) {
    git(repo, ["add", "--renormalize", "."]);
  }
  if (git(repo, ["diff", "--cached", "--quiet"], { check: false }).status === 0) {
    fs.writeFileSync(revisionPath, revision, "utf8");
    console.log("no sidecar changes to snapshot");
    return false;
  }
  const staged = git(repo, ["diff", "--cached", "--name-only", "-z", "--diff-filter=d"])
    .stdout.split("\0")
    .filter(Boolean);

  const source = currentMachine();
  const body = [message, "", `source: ${source}`];
  // main-head pins a snapshot to the code it was taken against. Standalone has
  // no separate code repo — mainRoot is this repo — so the trailer would just
  // record the commit this snapshot is about to sit on.
  if (path.resolve(repo) !== path.resolve(mainRoot)) {
    const mainHead = git(mainRoot, ["rev-parse", "--short", "HEAD"], { check: false });
    body.push(`main-head: ${mainHead.status === 0 ? mainHead.stdout.trim() : "unborn"}`);
  }
  body.push(`inbox: ${inbox}`);
  // When each file last changed, for last-writer-wins: a snapshot commits a
  // whole debounce window of edits at once, so its own time can run minutes
  // late for any one of them, and the merge needs the write, not the commit.
  body.push(...writtenTrailers(repo, staged));
  git(repo, ["commit", "-m", body.join("\n")]);
  fs.writeFileSync(revisionPath, revision, "utf8");
  console.log(`committed sidecar snapshot to ${paint("brand", inbox)}`);
  reportRedactions(repo, staged, redactionMode, policy?.rules);
  return true;
}

const WRITTEN_TRAILER = "written:";
// Past this many paths the trailers stop and the commit time stands in: a
// build cache's snapshot can touch thousands, and a message that long serves
// nobody.
const WRITTEN_TRAILER_LIMIT = 500;

/**
 * One `written: <unix seconds> <path>` line per staged file, from its mtime.
 * Deleted paths are not in `staged` — there is no file left to ask — and a
 * path with a newline could not be read back, so both fall back to the
 * commit time at the merge.
 */
function writtenTrailers(repo: string, staged: string[]): string[] {
  if (staged.length > WRITTEN_TRAILER_LIMIT) return [];
  const trailers: string[] = [];
  for (const relPath of staged) {
    if (relPath.includes("\n")) continue;
    try {
      const seconds = Math.floor(fs.lstatSync(path.join(repo, relPath)).mtimeMs / 1000);
      if (seconds > 0) trailers.push(`${WRITTEN_TRAILER} ${seconds} ${relPath}`);
    } catch {
      // Gone between staging and now; the commit time stands in.
    }
  }
  return trailers;
}

// Surfaces what the clean filter changed in this snapshot, so redaction is
// never silent: false positives are only reviewable if the user knows they
// happened.
function reportRedactions(repo: string, staged: string[], mode: RedactionMode, rules?: SidecarRules): void {
  let files = 0;
  let items = 0;
  for (const relPath of staged) {
    const delta = fileRedactionDelta(path.join(repo, relPath), mode, { rules, relativePath: relPath });
    if (!delta) continue;
    files += 1;
    items += delta.items;
  }
  if (!files) return;
  console.log(
    `redacted ${items} item(s) in ${files} file(s); review with \`sidecar redactions\``,
  );
  logSidecarEvent("redaction", { files, items });
}

// What redaction changes for one file, or undefined when it leaves the file
// alone (binary, non-UTF-8, or nothing matched).
export function fileRedactionDelta(
  filePath: string,
  mode: RedactionMode,
  policy?: { rules?: SidecarRules; relativePath: string },
): { text: string; redacted: string; items: number } | undefined {
  let data: Buffer;
  try {
    data = fs.readFileSync(filePath);
  } catch {
    return undefined;
  }
  const text = decodeUtf8Text(data);
  if (text === undefined) return undefined;
  const effectiveMode = policy
    ? resolveFileRules(policy.rules, policy.relativePath, { resolve: "fork", redaction: mode }).redaction
    : mode;
  const redacted = redactText(text, effectiveMode);
  if (redacted === text) return undefined;
  const items = Math.max(
    1,
    countRedactionPlaceholders(redacted) - countRedactionPlaceholders(text),
  );
  return { text, redacted, items };
}

const REDACTION_FILTER_NAME = "sidecar-redact";
// Bump when filter semantics change without changing the command, so Git's
// cached blobs are reprocessed too. Revision 2 adds per-path peer rules.
const REDACTION_FILTER_REVISION = "2";
const REDACTION_POLICY_FILE = "sidecar-redaction-policy";
export type RedactionPolicy = { rules?: SidecarRules; rulesPath?: string };

type BoundRedactionPolicy = {
  mode: RedactionMode;
  rulesPath?: string;
  fingerprint: string;
};

// The shared Git config cannot embed a host rules path or mode: sibling
// worktrees may have different policies. Bind each index to its own explicit
// host path in Git metadata; the filter never searches the synced content.
export function checkoutRedactionPolicy(repo: string): { mode: RedactionMode; rules: SidecarRules } {
  const policyPath = path.join(gitDir(repo), REDACTION_POLICY_FILE);
  let bound: BoundRedactionPolicy;
  try {
    bound = JSON.parse(fs.readFileSync(policyPath, "utf8"));
  } catch {
    throw new SidecarError("missing or invalid checkout redaction policy; run `sidecar sync`");
  }
  if (!bound || typeof bound !== "object" || typeof bound.fingerprint !== "string" ||
      (bound.rulesPath !== undefined && (typeof bound.rulesPath !== "string" || !path.isAbsolute(bound.rulesPath)))) {
    throw new SidecarError("invalid checkout redaction policy; run `sidecar sync`");
  }
  const mode = redactionModeConfigValue(bound.mode, "checkout redaction mode");
  const rules = bound.rulesPath ? readRules(bound.rulesPath) : [];
  if (rulesFingerprint(rules) !== bound.fingerprint) {
    throw new SidecarError("sidecar rules changed during this operation; run `sidecar sync` to apply them");
  }
  return { mode, rules };
}

// Redaction happens in a git clean filter, so secrets never reach committed
// blobs while the working tree keeps the user's original text. `required`
// makes staging fail closed if the filter command can't run.
// Returns true when it had to (re)write any part of the wiring — the signal
// that staged content may predate the current filter and needs renormalizing.
export function ensureRedactionFilter(
  repo: string,
  mode: RedactionMode = DEFAULT_REDACTION_MODE,
  policy?: RedactionPolicy,
): boolean {
  const fingerprint = rulesFingerprint(policy?.rules);
  if (policy?.rules?.length && !policy.rulesPath) {
    throw new SidecarError("path redaction rules require an explicit host rules file");
  }
  const rulesPath = policy?.rulesPath ? path.resolve(policy.rulesPath) : undefined;
  // Validate even for default none and before replacing the binding. A host
  // edit after config loading cannot silently weaken this operation's policy.
  if (rulesPath && rulesFingerprint(readRules(rulesPath)) !== fingerprint) {
    throw new SidecarError("sidecar rules changed during this operation; run `sidecar sync` to apply them");
  }
  const policyPath = path.join(gitDir(repo), REDACTION_POLICY_FILE);
  const bound = JSON.stringify({ mode, rulesPath, fingerprint } satisfies BoundRedactionPolicy);
  let previous = "";
  try { previous = fs.readFileSync(policyPath, "utf8"); } catch { /* first binding */ }
  const policyChanged = previous !== bound;
  if (policyChanged) fs.writeFileSync(policyPath, bound, { encoding: "utf8", mode: 0o600 });
  // %f is shell-quoted by Git itself, including whitespace and metacharacters.
  // Always run the filter: another checkout or a path rule can require
  // redaction even when this peer's default is none.
  const command = `${filterCommandQuote(process.execPath)} ${filterCommandQuote(sidecarCliPath())} redact --checkout-policy --path %f`;
  const wanted: Array<[string, string]> = [
    [`filter.${REDACTION_FILTER_NAME}.clean`, command],
    [`filter.${REDACTION_FILTER_NAME}.revision`, REDACTION_FILTER_REVISION],
    // `required` applies to both directions, so checkout needs an identity
    // smudge command to succeed.
    [`filter.${REDACTION_FILTER_NAME}.smudge`, "cat"],
    [`filter.${REDACTION_FILTER_NAME}.required`, "true"],
  ];
  // Git prefers a process filter over clean/smudge, so one configured under
  // this name would replace redaction outright; it is removed, never kept.
  const processKey = `filter.${REDACTION_FILTER_NAME}.process`;
  // info/attributes lives in the shared git dir; the worktree-local git dir
  // differs from it inside linked worktrees (which merging uses).
  const attributesPath = path.join(gitCommonDir(repo), "info", "attributes");
  const line = `* filter=${REDACTION_FILTER_NAME}`;

  // The command embeds absolute paths that go stale when node or the CLI
  // moves, so every caller re-checks. Verify every piece, not just the clean
  // command — a partial write (killed daemon) or a lost attributes file must
  // fail closed by repairing, never by early-exiting.
  const configured = git(repo, ["config", "--get-regexp", `^filter\\.${REDACTION_FILTER_NAME}\\.`], {
    check: false,
  });
  const current = new Map(
    configured.stdout
      .split("\n")
      .filter(Boolean)
      .map((entry) => {
        const space = entry.indexOf(" ");
        return [entry.slice(0, space), entry.slice(space + 1)] as [string, string];
      }),
  );
  const configOk = wanted.every(([key, value]) => current.get(key) === value) && !current.has(processKey);
  let attributes = "";
  try {
    attributes = fs.readFileSync(attributesPath, "utf8");
  } catch {
    // Missing attributes file: created by the append below.
  }
  const attributesOk = attributes.split(/\r?\n/).includes(line);
  if (configOk && attributesOk) return policyChanged;

  for (const [key, value] of wanted) {
    git(repo, ["config", key, value]);
  }
  git(repo, ["config", "--unset-all", processKey], { check: false });
  if (!attributesOk) {
    fs.mkdirSync(path.dirname(attributesPath), { recursive: true });
    fs.appendFileSync(
      attributesPath,
      attributes && !attributes.endsWith("\n") ? `\n${line}\n` : `${line}\n`,
      "utf8",
    );
  }
  return true;
}

// The inverse of ensureRedactionFilter, for the one case where the checkout
// outlives sidecar's interest in it.
export function removeRedactionFilter(repo: string): void {
  git(repo, ["config", "--remove-section", `filter.${REDACTION_FILTER_NAME}`], { check: false });
  fs.rmSync(path.join(gitDir(repo), "sidecar-redaction-revision"), { force: true });
  fs.rmSync(path.join(gitDir(repo), REDACTION_POLICY_FILE), { force: true });

  const attributesPath = path.join(gitCommonDir(repo), "info", "attributes");
  const line = `* filter=${REDACTION_FILTER_NAME}`;
  let contents: string;
  try {
    contents = fs.readFileSync(attributesPath, "utf8");
  } catch {
    return;
  }
  const lines = contents.split(/\r?\n/);
  const kept = lines.filter((entry) => entry !== line);
  if (kept.length === lines.length) return;
  if (kept.every((entry) => !entry.trim())) {
    fs.rmSync(attributesPath, { force: true });
  } else {
    fs.writeFileSync(attributesPath, `${kept.join("\n").replace(/\s+$/g, "")}\n`, "utf8");
  }
}

// Git runs filter commands through sh; double quotes keep paths with spaces
// intact.
function filterCommandQuote(value: string): string {
  return `"${value.replace(/([\\"$`])/g, "\\$1")}"`;
}

export function redactBuffer(data: Buffer, mode: RedactionMode): Buffer {
  const text = decodeUtf8Text(data);
  if (text === undefined) return data;
  const redacted = redactText(text, mode);
  return redacted === text ? data : Buffer.from(redacted, "utf8");
}

function decodeUtf8Text(data: Buffer): string | undefined {
  if (data.includes(0)) return undefined;
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(data);
  } catch {
    return undefined;
  }
}

export function syncBranchBeforePush(repo: string, branch: string, config: SidecarConfig): void {
  fetch(repo, true, false);
  if (!remoteRefExists(repo, branch)) return;

  const remoteBranch = `origin/${branch}`;
  if (isAncestor(repo, remoteBranch, "HEAD")) return;

  if (isDirty(repo)) {
    throw new SidecarError(
      `${remoteBranch} has commits not in local ${branch}, and the sidecar checkout has uncommitted changes`,
      { reason: "dirty-checkout" },
    );
  }

  if (isAncestor(repo, "HEAD", remoteBranch)) {
    git(repo, ["merge", "--ff-only", remoteBranch]);
    return;
  }

  // Rebasing can combine clean hunks before canonical merging ever sees the
  // file. Reconcile divergent inbox tips with the same whole-file policy.
  mergeInboxBranch(repo, { ...config, branch }, remoteBranch, { forkFiles: true });

}

/**
 * Fast-forwards this checkout's inbox to main, the one step of a sync that
 * writes the user's files. A checkout holding edits no sync has captured is
 * left where it is: they landed after this sync's snapshot, the next sync
 * snapshots them onto the inbox as it stands, and its merge reconciles that
 * with main. Moving the tree under them instead would bet the user's
 * unredacted originals on git's overwrite check, which compares through the
 * clean filter and so can count an original as already committed.
 */
function refreshInboxFromMain(repo: string, config: SidecarConfig, inbox: string): void {
  if (!branchExists(repo, inbox) || !branchExists(repo, config.branch)) return;
  if (isDirty(repo)) {
    logSidecarEvent("settle-deferred", { sidecarPath: repo });
    return;
  }
  git(repo, ["switch", inbox]);
  const result = git(repo, ["merge", "--ff-only", config.branch], { check: false });
  if (result.status === 0) return;
  // An edit that landed between the check and the merge can stop it, and is
  // deferred the same way. A checkout still clean means the merge
  // failed for a reason of its own.
  if (isDirty(repo)) {
    logSidecarEvent("settle-deferred", { sidecarPath: repo });
    return;
  }
  throw new SidecarError(result.stderr.trim() || `could not fast-forward ${inbox} to ${config.branch}`);
}

export function pushBranch(repo: string, branch: string): void {
  git(repo, ["push", "--no-follow-tags", "-u", "origin", `HEAD:refs/heads/${branch}`]);
  console.log(`pushed ${paint("brand", branch)}`);
}

export function forkConflicts(repo: string, remoteBranch: string, selectedPaths?: string[]): void {
  const conflicts = selectConflictPaths(unmergedEntries(repo), selectedPaths);
  if (!Object.keys(conflicts).length) {
    throw new SidecarError("merge reported conflicts, but no unmerged paths were found");
  }

  const timestamp = utcTimestamp();
  const branch = remoteBranchName(remoteBranch) || remoteBranch;
  const branchLabel = slug(branch);
  const manifestLabel = fileLabel(branch);
  const manifest: ConflictManifest = {
    timestamp,
    resolved_by: "fork-files",
    source_branch: branch,
    paths: [],
  };

  // Read every expected version before removing any original. A deleted side
  // has no index entry; an unreadable existing entry is an error, never a
  // deletion that can be silently skipped.
  const prepared = Object.entries(conflicts).sort(([left], [right]) => left.localeCompare(right)).map(
    ([conflictPath, stages]) => ({
      conflictPath,
      stages,
      blobs: Object.fromEntries([2, 3].filter((stage) => stages[stage]).map((stage) => {
        const entry = stages[stage];
        if (!["100644", "100755", "120000"].includes(entry.mode)) {
          throw new SidecarError(`cannot fork unsupported mode ${entry.mode} for ${conflictPath}`);
        }
        const blob = showStage(repo, stage, conflictPath);
        if (blob === undefined) throw new SidecarError(`could not read conflict stage ${stage} for ${conflictPath}`);
        return [stage, blob];
      })),
    }),
  );

  for (const { conflictPath, stages, blobs } of prepared) {
    const versions: ConflictVersion[] = [];
    for (const [stage, label] of [
      [2, "main"],
      [3, branchLabel],
    ] as const) {
      const blob = blobs[stage];
      if (blob === undefined) continue;
      const { oid, mode } = stages[stage];
      const outPath = forkPath(conflictPath, label, oid);
      const fullOut = path.join(repo, outPath);
      fs.mkdirSync(path.dirname(fullOut), { recursive: true });
      // Replace an old fork without following a symlink, and preserve the
      // index mode so executable files and symlink versions stay usable.
      fs.rmSync(fullOut, { force: true });
      if (mode === "120000") fs.symlinkSync(blob.toString("utf8"), fullOut);
      else {
        fs.writeFileSync(fullOut, blob);
        fs.chmodSync(fullOut, mode === "100755" ? 0o755 : 0o644);
      }
      git(repo, ["add", "--", `:(literal)${outPath}`]);
      versions.push({
        stage,
        label,
        oid,
        path: outPath,
        sha256: crypto.createHash("sha256").update(blob).digest("hex"),
      });
    }

    git(repo, ["rm", "-f", "--", `:(literal)${conflictPath}`]);

    manifest.paths.push({ path: conflictPath, versions });
  }

  const manifestDir = path.join(repo, ".sidecar-conflicts");
  fs.mkdirSync(manifestDir, { recursive: true });
  const manifestPath = path.join(manifestDir, `${timestamp}-${manifestLabel}-fork-files.json`);
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  git(repo, ["add", "--", `:(literal)${path.relative(repo, manifestPath)}`]);
  if (Object.keys(selectConflictPaths(unmergedPaths(repo), selectedPaths)).length) {
    throw new SidecarError("fork-files did not clear all unmerged paths");
  }
}

type ConflictManifest = {
  timestamp: string;
  resolved_by: "fork-files";
  source_branch: string;
  paths: Array<{ path: string; versions: ConflictVersion[] }>;
};

/** Select an entire parent entry for every LWW path; never keep merged content. */
export function resolveLastWriterWins(
  repo: string,
  canonicalBranch: string,
  remoteBranch: string,
  selectedPaths = Object.keys(unmergedPaths(repo)),
  writes = mergeWrittenPaths(repo, remoteBranch),
): string[] {
  const timestamp = utcTimestamp();
  const branch = remoteBranchName(remoteBranch) || remoteBranch;
  const manifest: LastWriterManifest = { timestamp, resolved_by: "lww", source_branch: branch, paths: [] };
  const selections = [...new Set(selectedPaths)].sort().map((filePath) => {
    const ours = treeEntry(repo, "HEAD", filePath);
    const theirs = treeEntry(repo, remoteBranch, filePath);
    const oursWrite = lastWriteEvent(repo, "HEAD", filePath);
    const theirsWrite = lastWriteEvent(repo, remoteBranch, filePath);
    const baseWrite = lastWriteEvent(repo, writes.base, filePath);
    const oursAt = oursWrite.time;
    const theirsAt = theirsWrite.time;
    // A stable entry tie-break converges independently of inbox enumeration.
    // Deletion wins a same-time tie; otherwise compare mode and object id.
    // A one-sided write is a causal update, even when its file mtime was
    // copied from an older source. Clocks arbitrate only concurrent writes.
    // Compare the accepted source event, not every historical edit: a merge
    // may have discarded a write while keeping the base version unchanged.
    const oursChanged = oursWrite.source !== baseWrite.source;
    const theirsChanged = theirsWrite.source !== baseWrite.source;
    const incoming = oursChanged !== theirsChanged ? theirsChanged
      : theirsAt > oursAt || (theirsAt === oursAt && entryKey(theirs) > entryKey(ours));
    // Reverts still compete: compare source events to the base, and complete
    // parent entries to each other (including modes and absence).
    const conflict = oursChanged && theirsChanged && entryKey(ours) !== entryKey(theirs);
    return { filePath, ours, theirs, incoming, conflict, winner: incoming ? theirs : ours, write: incoming ? theirsWrite : oursWrite };
  });
  // Independently selected files cannot occupy both an ancestor path and its
  // descendant. Fail before changing the index rather than erase a winner.
  const selected = new Set(selections.map((entry) => entry.filePath));
  const indexed = new Set(git(repo, ["ls-files", "-z"]).stdout.split("\0").filter(Boolean));
  const present = new Set([
    ...[...indexed].filter((filePath) => !selected.has(filePath)),
    ...selections.filter((entry) => entry.winner).map((entry) => entry.filePath),
  ]);
  for (const filePath of present) {
    for (let parent = path.posix.dirname(filePath); parent !== "."; parent = path.posix.dirname(parent)) {
      if (present.has(parent)) throw new SidecarError(`last-writer-wins selected incompatible file and directory paths: ${parent}, ${filePath}`);
    }
  }
  // Remove winning deletions before restoring files, so directory/file
  // transitions can be materialized without following old symlinks.
  for (const selection of selections.filter((entry) => !entry.winner)) {
    // A clean file-to-directory merge may already have removed this leaf.
    // Even a literal parent pathspec would match its indexed descendants;
    // remove only a leaf that is actually present as an exact index entry.
    if (indexed.has(selection.filePath)) {
      git(repo, ["rm", "-f", "--ignore-unmatch", "--", `:(literal)${selection.filePath}`]);
    }
  }
  const written: string[] = [];
  for (const { filePath, ours, theirs, incoming, conflict, winner, write } of selections) {
    if (winner) {
      git(repo, ["restore", `--source=${incoming ? remoteBranch : "HEAD"}`, "--staged", "--worktree", "--", `:(literal)${filePath}`]);
      // Reapply this checkout's configured redaction to the selected complete
      // version; restoring an index entry alone bypasses Git's clean filter.
      git(repo, ["add", "--renormalize", "--", `:(literal)${filePath}`]);
    }
    // Applying a causal update (or accepting identical versions) loses no
    // competing content. Keep its write provenance, but don't report a conflict.
    if (conflict) manifest.paths.push({ path: filePath, kept: incoming ? branch : canonicalBranch, kept_at: write.time,
      dropped: incoming ? canonicalBranch : branch, dropped_oid: (incoming ? ours : theirs)?.oid ?? null });
    written.push(lwwWrittenTrailer(filePath, write));
  }
  if (manifest.paths.length) {
    const manifestDir = path.join(repo, ".sidecar-conflicts");
    fs.mkdirSync(manifestDir, { recursive: true });
    const manifestPath = path.join(manifestDir, `${timestamp}-${fileLabel(branch)}-lww.json`);
    fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
    git(repo, ["add", "--", `:(literal)${path.relative(repo, manifestPath)}`]);
  }
  if (Object.keys(selectConflictPaths(unmergedPaths(repo), selectedPaths)).length) {
    throw new SidecarError("last-writer-wins did not clear all unmerged paths");
  }
  console.log(`selected ${selections.length} complete file version(s) by last writer`);
  return written;
}

type TreeEntry = { mode: string; oid: string };
function entryKey(entry: TreeEntry | undefined): string {
  return entry ? `${entry.mode}:${entry.oid}` : "~deleted";
}
function treeEntry(repo: string, ref: string, filePath: string): TreeEntry | undefined {
  const records = gitBytes(repo, ["--literal-pathspecs", "ls-tree", "-z", "--full-tree", ref, "--", filePath]).stdout.toString("utf8").split("\0");
  for (const record of records) {
    const separator = record.indexOf("\t");
    if (separator < 0 || record.slice(separator + 1) !== filePath) continue;
    const [mode, type, oid] = record.slice(0, separator).split(" ");
    if (type === "tree") return undefined;
    if (type !== "blob" || !["100644", "100755", "120000"].includes(mode)) {
      throw new SidecarError(`cannot select unsupported Git entry ${mode} for ${filePath}`);
    }
    return { mode, oid };
  }
  return undefined;
}

function lwwTrailerPrefix(filePath: string): string {
  return `sidecar-lww-${crypto.createHash("sha256").update(filePath).digest("hex")}:`;
}
type WriteEvent = { time: number; source: string };
function lwwWrittenTrailer(filePath: string, write: WriteEvent): string {
  return `${lwwTrailerPrefix(filePath)} ${write.time} ${write.source || "-"}`;
}

function selectConflictPaths<T>(conflicts: Record<string, T>, selectedPaths?: string[]): Record<string, T> {
  if (!selectedPaths) return conflicts;
  const selected = new Set(selectedPaths);
  return Object.fromEntries(Object.entries(conflicts).filter(([filePath]) => selected.has(filePath)));
}

type LastWriterManifest = {
  timestamp: string;
  resolved_by: "lww";
  source_branch: string;
  paths: Array<{ path: string; kept: string; kept_at: number; dropped: string; dropped_oid: string | null }>;
};

/**
 * When the path was last written on `ref`: the change time its snapshot
 * recorded, or the time of the last commit touching it when that commit
 * recorded none — a deletion, a snapshot too large for trailers, a commit
 * made by hand. 0 when no commit on the ref touched the path.
 */
export function lastWriteAt(repo: string, ref: string, filePath: string): number {
  return lastWriteEvent(repo, ref, filePath).time;
}
function lastWriteEvent(repo: string, ref: string, filePath: string): WriteEvent {
  // First-parent history follows the selected tree rather than a discarded
  // incoming version. Merge trailers carry the original clock, not the time
  // at which Sidecar happened to synthesize the merge commit.
  const format = "--format=%H%n%ct%n%B";
  const result = git(repo, ["log", "--first-parent", "-1", format, ref, "--", `:(literal)${filePath}`]);
  const [writeCommit = "", committed = "", ...body] = result.stdout.split("\n");
  const prefix = lwwTrailerPrefix(filePath);
  // Git can omit a merge from path history when it kept our identical blob.
  // Search its explicit clock separately, then compare ancestry instead of
  // commit dates (which can be skewed or intentionally backdated).
  const metadata = git(repo, ["log", "--first-parent", "-1", "--fixed-strings", `--grep=${prefix}`, format, ref]);
  const [metadataCommit = "", , ...metadataBody] = metadata.stdout.split("\n");
  if (metadataCommit && (!writeCommit || isAncestor(repo, writeCommit, metadataCommit))) {
    const carried = recordedLwwEvent(metadataBody, prefix);
    if (carried !== undefined) return carried;
  }
  const carried = recordedLwwEvent(body, prefix);
  if (carried !== undefined) return carried;
  const suffix = ` ${filePath}`;
  for (const line of body) {
    if (!line.startsWith(WRITTEN_TRAILER) || !line.endsWith(suffix)) continue;
    const seconds = Number(line.slice(WRITTEN_TRAILER.length, -suffix.length).trim());
    if (Number.isInteger(seconds) && seconds > 0) return { time: seconds, source: writeCommit };
  }
  return { time: Number(committed.trim()) || 0, source: writeCommit };
}
function recordedLwwEvent(body: string[], prefix: string): WriteEvent | undefined {
  const line = body.find((entry) => entry.startsWith(`${prefix} `));
  if (!line) return undefined;
  const [timestamp, source] = line.slice(prefix.length).trim().split(/\s+/);
  const time = Number(timestamp);
  return Number.isInteger(time) && time >= 0 && source ? { time, source: source === "-" ? "" : source } : undefined;
}

type ConflictVersion = {
  stage: number;
  label: string;
  oid: string;
  path: string;
  sha256: string;
};

export function forkPath(conflictPath: string, label: string, oid: string): string {
  const parsed = path.parse(conflictPath);
  const shortOid = oid ? oid.slice(0, 7) : "missing";
  const safeLabel = fileLabel(label);
  const forkName = parsed.ext
    ? `${parsed.name}.conflict.${safeLabel}.${shortOid}${parsed.ext}`
    : `${parsed.name}.conflict.${safeLabel}.${shortOid}`;
  return path.join(parsed.dir, forkName);
}

export function fileLabel(value: string): string {
  return slug(value).replaceAll("/", "-");
}

type UnmergedEntry = { mode: string; oid: string };

function unmergedEntries(repo: string): Record<string, Record<number, UnmergedEntry>> {
  const result = gitBytes(repo, ["ls-files", "-u", "-z"]);
  // Git emits literal pathname bytes with -z. Reject invalid UTF-8 rather
  // than resolve a different path after lossy decoding.
  let output: string;
  try {
    output = new TextDecoder("utf-8", { fatal: true }).decode(result.stdout);
  } catch {
    throw new SidecarError("cannot resolve conflict paths that are not valid UTF-8");
  }
  const paths: Record<string, Record<number, UnmergedEntry>> = Object.create(null);
  for (const record of output.split("\0")) {
    if (!record) continue;
    const separator = record.indexOf("\t");
    const meta = record.slice(0, separator);
    const rawPath = record.slice(separator + 1);
    const [mode, oid, stageText] = meta.split(" ");
    const stage = Number(stageText);
    if (separator < 0 || !rawPath || !mode || !oid || ![1, 2, 3].includes(stage)) {
      throw new SidecarError("invalid unmerged index entry");
    }
    paths[rawPath] ??= {};
    paths[rawPath][stage] = { mode, oid };
  }
  return paths;
}

export function unmergedPaths(repo: string): Record<string, Record<number, string>> {
  return Object.fromEntries(Object.entries(unmergedEntries(repo)).map(([filePath, stages]) => [
    filePath,
    Object.fromEntries(Object.entries(stages).map(([stage, entry]) => [stage, entry.oid])),
  ]));
}

export function hasUnmergedPaths(repo: string): boolean {
  return Object.keys(unmergedPaths(repo)).length > 0;
}

export function showStage(repo: string, stage: number, conflictPath: string): Buffer | undefined {
  const result = gitBytes(repo, ["show", `:${stage}:${conflictPath}`], { check: false });
  return result.status === 0 ? result.stdout : undefined;
}

/**
 * Every inbox branch this checkout can reach, local heads as well as
 * remote-tracking refs.
 *
 * The local half is what lets checkouts sharing a clone see each other without
 * the remote: a sibling worktree's snapshot is committed here the moment it is
 * taken, so its branch is readable — and fresher than origin — before any push
 * happens. A name held in both places is listed once, local first, for the same
 * reason.
 */
export function pendingInboxBranches(repo: string, config: SidecarConfig): string[] {
  const prefix = inboxPrefix(config);
  const refs = git(repo, [
    "for-each-ref",
    "--format=%(refname)",
    "refs/heads/",
    "refs/remotes/origin/",
  ])
    .stdout.split(/\r?\n/)
    .map((ref) => ref.trim())
    .filter(Boolean);
  const local = refs
    .filter((ref) => ref.startsWith("refs/heads/"))
    .map((ref) => ref.slice("refs/heads/".length))
    .filter((branch) => matchesInboxPrefix(prefix, branch));
  const claimed = new Set(local);
  const remote = refs
    .filter((ref) => ref.startsWith("refs/remotes/origin/"))
    .map((ref) => ref.slice("refs/remotes/".length))
    .filter((ref) => {
      const branch = remoteBranchName(ref);
      return ref !== "origin/HEAD" && matchesInboxPrefix(prefix, branch) && !claimed.has(branch);
    });
  return [...local, ...remote].sort();
}
