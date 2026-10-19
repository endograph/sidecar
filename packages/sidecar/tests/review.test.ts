import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

vi.mock("../src/git.js", async (original) => ({
  ...await original<typeof import("../src/git.js")>(),
  emptyTree: vi.fn(),
  git: vi.fn(),
  gitBytes: vi.fn(),
  gitCommonDir: vi.fn(),
  treeOf: vi.fn(),
}));
vi.mock("../src/state.js", async (original) => ({
  ...await original<typeof import("../src/state.js")>(),
  logSidecarEvent: vi.fn(),
}));

import { emptyTree, git, gitBytes, gitCommonDir, treeOf } from "../src/git.js";
import { logSidecarEvent, readSettings, writeSettings } from "../src/state.js";
import type { SidecarConfig } from "../src/config.js";
import {
  type Review,
  createReview,
  decideReview,
  findReview,
  listReviews,
  markPublished,
  markPublishing,
  markSuperseded,
  openReview,
  readReview,
  resetReview,
  reviewAttention,
} from "../src/review.js";

const config: SidecarConfig = {
  peer: "default", version: 1, path: "sidecar", remote: "https://bot:hunter2secret@example.com/notes.git", branch: "main",
  inbox: "sidecar-inbox/{user}/{random}", redaction: "secrets", resolve: "fork", review: "required", reviewTimeout: 3600,
};
let directory: string;
let root: string;
let numstat = "";

beforeEach(() => {
  vi.resetAllMocks();
  numstat = "1\t0\tnotes.md\0";
  directory = fs.mkdtempSync(path.join(os.tmpdir(), "sidecar-review-"));
  root = path.join(directory, "repo");
  fs.mkdirSync(path.join(root, "sidecar", ".git"), { recursive: true });
  vi.stubEnv("SIDECAR_STATE_DIR", path.join(directory, "state"));
  vi.mocked(gitCommonDir).mockImplementation((checkout) => path.join(checkout, ".git"));
  vi.mocked(emptyTree).mockReturnValue("empty-tree");
  vi.mocked(treeOf).mockReturnValue("tree-oid");
  vi.mocked(gitBytes).mockReturnValue({ status: 0, stdout: Buffer.from("plain text\n"), stderr: Buffer.alloc(0) });
  vi.mocked(git).mockImplementation((_repo, args) => {
    let stdout = "";
    if (args[0] === "diff-tree" && args.includes("--name-status")) stdout = "M\0notes.md\0A\0plans/q3.md\0";
    else if (args[0] === "diff-tree" && args.includes("--numstat")) stdout = numstat;
    else if (args[0] === "diff-tree") stdout = "diff --git a/notes.md b/notes.md\n+a new line\n";
    else if (args[0] === "ls-tree") stdout = ["100644 blob aaa\tnotes.md", "100644 blob bbb\tplans/q3.md", "160000 commit ccc\tvendor/lib"].join("\x00");
    return { status: 0, stdout, stderr: "" };
  });
});

afterEach(() => {
  vi.unstubAllEnvs();
  fs.rmSync(directory, { recursive: true, force: true });
});

function open(checkout = path.join(root, "sidecar")): Review {
  return createReview({ root, config, sidecarPath: checkout, base: "base-oid", head: "head-oid" });
}

function writeRun(review: Review, run: Record<string, unknown>, attempt = "a1"): void {
  fs.writeFileSync(path.join(review.dir, "attempt"), `${attempt}\n`, "utf8");
  fs.writeFileSync(path.join(review.dir, `run-${attempt}.json`), JSON.stringify({ attempt, ...run }), "utf8");
}

describe("opening a review", () => {
  test("writes an owner-only packet with the diff, changed paths, guidelines, and instructions", () => {
    fs.writeFileSync(path.join(root, ".sidecar-review"), "No customer names.\n", "utf8");
    const review = open();
    const { record } = review;

    expect(record).toMatchObject({
      family: fs.realpathSync(path.join(root, "sidecar", ".git")),
      base: "base-oid",
      head: "head-oid",
      tree: "tree-oid",
      files: [{ status: "M", path: "notes.md" }, { status: "A", path: "plans/q3.md" }],
      timeoutSeconds: 3600,
    });
    expect(git).toHaveBeenCalledWith(path.join(root, "sidecar"), expect.arrayContaining(["diff-tree", "--ignore-submodules=none", "-p", "base-oid", "head-oid"]));
    expect(fs.statSync(review.dir).mode & 0o777).toBe(0o700);
    for (const file of ["review.json", "diff.patch", "instructions.md", "guidelines.md"]) {
      expect(fs.statSync(path.join(review.dir, file)).mode & 0o777).toBe(0o600);
    }
    expect(fs.readFileSync(path.join(review.dir, "diff.patch"), "utf8")).toContain("+a new line");
    const instructions = fs.readFileSync(path.join(review.dir, "instructions.md"), "utf8");
    expect(instructions).toContain(`sidecar review approve ${record.id}`);
    expect(instructions).toContain(`sidecar review reject ${record.id} --reason`);
    expect(instructions).toContain("No customer names.");
    // The remote URL is quoted for context; its credentials are not.
    expect(instructions).not.toContain("hunter2secret");
    expect(review.state).toBe("pending");
  });

  test("puts the full content of files the diff cannot show into the packet", () => {
    numstat = "1\t0\tnotes.md\0-\t-\tplans/q3.md\0";
    vi.mocked(gitBytes).mockReturnValue({ status: 0, stdout: Buffer.from([0, 1, 2, 0x43]), stderr: Buffer.alloc(0) });
    const review = open();
    const opaque = review.record.files.find((file) => file.path === "plans/q3.md")!;
    expect(opaque.artifact).toBe(path.join("opaque", "0001"));
    expect(review.record.files.find((file) => file.path === "notes.md")!.artifact).toBeUndefined();
    expect(gitBytes).toHaveBeenCalledWith(path.join(root, "sidecar"), ["cat-file", "blob", "head-oid:plans/q3.md"]);
    expect(fs.readFileSync(path.join(review.dir, opaque.artifact!))).toEqual(Buffer.from([0, 1, 2, 0x43]));
    expect(fs.statSync(path.join(review.dir, opaque.artifact!)).mode & 0o777).toBe(0o600);
    const instructions = fs.readFileSync(path.join(review.dir, "instructions.md"), "utf8");
    expect(instructions).toContain("`opaque/0001` — plans/q3.md");
    expect(instructions).toContain("if you cannot, do not approve");
  });

  test("treats text that is not UTF-8 as content the diff cannot show", () => {
    vi.mocked(gitBytes).mockImplementation((_repo, args) => ({
      status: 0,
      stdout: String(args.at(-1)).endsWith("plans/q3.md") ? Buffer.from([0xf9, 0xec, 0xe5, 0xed]) : Buffer.from("plain\n"),
      stderr: Buffer.alloc(0),
    }));
    const review = open();
    expect(review.record.files.find((file) => file.path === "plans/q3.md")!.artifact).toBe(path.join("opaque", "0001"));
    expect(review.record.files.find((file) => file.path === "notes.md")!.artifact).toBeUndefined();
  });

  test("diffs against the empty tree when the head shares no history with the remote", () => {
    createReview({ root, config, sidecarPath: path.join(root, "sidecar"), head: "head-oid" });
    expect(git).toHaveBeenCalledWith(path.join(root, "sidecar"), expect.arrayContaining(["diff-tree", "-p", "empty-tree", "head-oid"]));
  });

  test("says so when the repository has no guidelines", () => {
    const review = open();
    expect(fs.existsSync(path.join(review.dir, "guidelines.md"))).toBe(false);
    expect(fs.readFileSync(path.join(review.dir, "instructions.md"), "utf8")).toContain("has no review guidelines");
  });

  test("reads a named peer's guidelines from its own file", () => {
    fs.writeFileSync(path.join(root, ".sidecar-review.notes"), "Notes only.\n", "utf8");
    fs.writeFileSync(path.join(root, ".sidecar-review"), "Default only.\n", "utf8");
    const review = createReview({ root, config: { ...config, peer: "notes" }, sidecarPath: path.join(root, "sidecar"), head: "head-oid" });
    expect(fs.readFileSync(path.join(review.dir, "guidelines.md"), "utf8")).toBe("Notes only.\n");
  });
});

describe("review state", () => {
  test("a verdict decides the state, and a rejection's reason stays out of the log", () => {
    const review = open();
    decideReview(review, "rejected", "plans/q3.md: an unreleased plan");
    const reread = readReview(review.record.id)!;
    expect(reread.state).toBe("rejected");
    expect(reread.verdict?.reason).toBe("plans/q3.md: an unreleased plan");
    expect(reviewAttention(reread)).toBe("rejected");
    expect(logSidecarEvent).toHaveBeenCalledWith("review-decision", { id: review.record.id, verdict: "rejected" });
    expect(JSON.stringify(vi.mocked(logSidecarEvent).mock.calls)).not.toContain("unreleased");
  });

  test("a person can override a rejection until the review is published", () => {
    const review = open();
    decideReview(review, "rejected");
    decideReview(review, "approved");
    expect(readReview(review.record.id)!.state).toBe("approved");
    markPublished(review, "published-oid");
    const published = readReview(review.record.id)!;
    expect(published.state).toBe("published");
    expect(() => decideReview(published, "rejected")).toThrow(/already published/);
  });

  test("a reviewer that exits nonzero without a verdict has failed", () => {
    const review = open();
    writeRun(review, { pid: process.pid, command: "reviewer", startedAt: "t", finishedAt: "t", exitCode: 2, signal: null });
    const reread = readReview(review.record.id)!;
    expect(reread.state).toBe("failed");
    expect(reviewAttention(reread)).toBe("reviewer exited 2 without a verdict");
  });

  test("a reviewer that exits zero without a verdict is a review still in progress", () => {
    writeSettings({ ...readSettings(), reviewer: "reviewer" });
    const review = open();
    writeRun(review, { pid: process.pid, command: "reviewer", startedAt: "t", finishedAt: "t", exitCode: 0, signal: null });
    const reread = readReview(review.record.id)!;
    expect(reread.state).toBe("pending");
    expect(reviewAttention(reread)).toBeUndefined();
  });

  test("a runner that died before finishing has failed", () => {
    const review = open();
    writeRun(review, { pid: 999_999, command: "reviewer", startedAt: "t" });
    const reread = readReview(review.record.id)!;
    expect(reread.state).toBe("failed");
    expect(reviewAttention(reread)).toBe("reviewer stopped without a verdict");
  });

  test("needs attention with no reviewer configured, or once open past its timeout", () => {
    const review = open();
    expect(reviewAttention(review)).toBe("no reviewer is configured on this machine");
    writeSettings({ ...readSettings(), reviewer: "reviewer" });
    const opened = Date.parse(review.record.createdAt);
    expect(reviewAttention(review, opened + 3599_000)).toBeUndefined();
    expect(reviewAttention(review, opened + 3601_000)).toBe("undecided for over 1h");
  });

  test("only the current attempt's runner counts", () => {
    const review = open();
    writeRun(review, { pid: process.pid, command: "reviewer", startedAt: "t", finishedAt: "t", exitCode: 0 }, "new");
    // The retired attempt's runner finishes late and badly; it is not the record read.
    fs.writeFileSync(path.join(review.dir, "run-old.json"), JSON.stringify({ attempt: "old", pid: 1, startedAt: "t", finishedAt: "t", exitCode: 7 }));
    expect(readReview(review.record.id)!.state).toBe("pending");
  });

  test("once publication has begun, a review can no longer be rejected or reset", () => {
    const review = open();
    decideReview(review, "approved");
    markPublishing(review, "sidecar-inbox/test/abc", "commit-oid");
    const reread = readReview(review.record.id)!;
    expect(reread.record.publishing).toEqual({ inbox: "sidecar-inbox/test/abc", commit: "commit-oid" });
    expect(() => decideReview(reread, "rejected")).toThrow(/already being published/);
    expect(() => resetReview(reread)).toThrow(/already being published/);
  });

  test("reset clears the verdict and run so the reviewer can take it again", () => {
    const review = open();
    writeRun(review, { pid: 999_999, command: "reviewer", startedAt: "t", finishedAt: "t", exitCode: 1 });
    decideReview(review, "rejected", "no");
    resetReview(review);
    const reread = readReview(review.record.id)!;
    expect(reread.state).toBe("pending");
    expect(reread.verdict).toBeUndefined();
    expect(reread.run).toBeUndefined();
  });
});

describe("finding reviews", () => {
  test("a family has one open review: the newest that is neither published nor superseded", () => {
    const checkout = path.join(root, "sidecar");
    const first = open();
    markSuperseded(first);
    const second = open();
    const elsewhere = path.join(directory, "other", "sidecar");
    fs.mkdirSync(path.join(elsewhere, ".git"), { recursive: true });
    const unrelated = open(elsewhere);

    expect(openReview(checkout)?.record.id).toBe(second.record.id);
    expect(openReview(elsewhere)?.record.id).toBe(unrelated.record.id);
    expect(listReviews(checkout).map((review) => review.record.id).sort()).toEqual([first.record.id, second.record.id].sort());
  });

  test("a sibling checkout of the same family shares its review", () => {
    const review = open();
    const sibling = path.join(directory, "sibling", "sidecar");
    vi.mocked(gitCommonDir).mockImplementation(() => path.join(root, "sidecar", ".git"));
    expect(openReview(sibling)?.record.id).toBe(review.record.id);
  });

  test("ids resolve by unambiguous prefix, and never as paths", () => {
    const review = open();
    expect(findReview(review.record.id.slice(0, 3)).record.id).toBe(review.record.id);
    expect(() => findReview("zz")).toThrow(/no review "zz"/);
    expect(readReview("../state")).toBeUndefined();
  });

  test("keeps only the ten newest closed reviews per family", () => {
    const checkout = path.join(root, "sidecar");
    for (let index = 0; index < 13; index += 1) markSuperseded(open());
    open();
    const reviews = listReviews(checkout);
    expect(reviews.filter((review) => review.state === "superseded")).toHaveLength(10);
    expect(reviews.filter((review) => review.state === "pending")).toHaveLength(1);
  });
});
