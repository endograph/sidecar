import { beforeEach, describe, expect, test, vi } from "vitest";

vi.mock("../src/git.js", async (original) => ({
  ...await original<typeof import("../src/git.js")>(),
  branchExists: vi.fn(),
  git: vi.fn(),
  isDirty: vi.fn(),
}));
vi.mock("../src/state.js", async (original) => ({
  ...await original<typeof import("../src/state.js")>(),
  logSidecarEvent: vi.fn(),
}));

import { branchExists, git, isDirty } from "../src/git.js";
import { logSidecarEvent } from "../src/state.js";
import { settleCheckouts } from "../src/sync.js";
import type { SidecarConfig } from "../src/config.js";

const config: SidecarConfig = {
  remote: "unused", path: "sidecar", branch: "main", inbox: "sidecar-inbox/{user}/{random}",
  resolve: "fork", redaction: "secrets", peer: "default",
};

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(branchExists).mockReturnValue(false);
  vi.mocked(git).mockReturnValue({ status: 0, stdout: "", stderr: "" });
});

describe("best-effort sibling settling", () => {
  test("skips a sibling whose dirty check fails and continues without changing its policy", () => {
    vi.mocked(isDirty).mockImplementation((repo) => {
      if (repo === "bad-policy") throw new Error("sidecar redaction rules changed; run sidecar sync");
      return repo === "mid-edit";
    });

    expect(() => settleCheckouts("current", config, "inbox", ["bad-policy", "healthy", "mid-edit", "also-healthy"])).not.toThrow();

    expect(vi.mocked(isDirty).mock.calls.map(([repo]) => repo)).toEqual(["bad-policy", "healthy", "mid-edit", "also-healthy"]);
    expect(vi.mocked(git).mock.calls).toEqual([
      ["healthy", ["merge", "--ff-only", "main"], { check: false }],
      ["also-healthy", ["merge", "--ff-only", "main"], { check: false }],
    ]);
    expect(logSidecarEvent).toHaveBeenCalledWith("settle-skip", {
      sidecarPath: "bad-policy", message: "sidecar redaction rules changed; run sidecar sync",
    });
    expect(logSidecarEvent).toHaveBeenCalledWith("settle", { sidecarPath: "current", siblings: 2 });
  });

  test("continues after a sibling merge throws", () => {
    vi.mocked(git).mockImplementation((repo) => {
      if (repo === "gone") throw new Error("working directory is gone");
      return { status: 0, stdout: "", stderr: "" };
    });
    expect(() => settleCheckouts("current", config, "inbox", ["gone", "healthy"])).not.toThrow();
    expect(git).toHaveBeenCalledWith("healthy", ["merge", "--ff-only", "main"], { check: false });
    expect(logSidecarEvent).toHaveBeenCalledWith("settle", { sidecarPath: "current", siblings: 1 });
  });

  test("leaves a current checkout holding uncaptured edits alone and still settles its siblings", () => {
    vi.mocked(branchExists).mockReturnValue(true);
    vi.mocked(isDirty).mockImplementation((repo) => repo === "current");

    expect(() => settleCheckouts("current", config, "inbox", ["healthy"])).not.toThrow();

    // Nothing ran in the current checkout: no switch, no fast-forward over the edit.
    expect(vi.mocked(git).mock.calls).toEqual([["healthy", ["merge", "--ff-only", "main"], { check: false }]]);
    expect(logSidecarEvent).toHaveBeenCalledWith("settle-deferred", { sidecarPath: "current" });
    expect(logSidecarEvent).toHaveBeenCalledWith("settle", { sidecarPath: "current", siblings: 1 });
  });

  test("defers when an edit lands between the dirty check and the fast-forward", () => {
    vi.mocked(branchExists).mockReturnValue(true);
    let edited = false;
    vi.mocked(isDirty).mockImplementation((repo) => repo === "current" && edited);
    vi.mocked(git).mockImplementation((repo, args) => {
      if (repo === "current" && args[0] === "merge") {
        edited = true;
        return { status: 1, stdout: "", stderr: "Your local changes would be overwritten by merge" };
      }
      return { status: 0, stdout: "", stderr: "" };
    });

    expect(() => settleCheckouts("current", config, "inbox", [])).not.toThrow();
    expect(logSidecarEvent).toHaveBeenCalledWith("settle-deferred", { sidecarPath: "current" });
  });

  test("still fails when a clean current checkout cannot fast-forward", () => {
    vi.mocked(branchExists).mockReturnValue(true);
    vi.mocked(isDirty).mockReturnValue(false);
    vi.mocked(git).mockImplementation((repo, args) =>
      repo === "current" && args[0] === "merge"
        ? { status: 128, stdout: "", stderr: "fatal: Not possible to fast-forward, aborting." }
        : { status: 0, stdout: "", stderr: "" });

    expect(() => settleCheckouts("current", config, "inbox", ["healthy"])).toThrow("Not possible to fast-forward");
  });
});
