import { spawnSync } from "node:child_process";
import { afterEach, describe, expect, test } from "vitest";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { platform, tmpdir } from "node:os";
import { join } from "node:path";
import registerHunkHg, { detectHgRepo, HgVcsAdapter } from "./index";
import type {
  ExtensionVcsDiffInput,
  ExtensionVcsOperations,
  ExtensionVcsShowInput,
  HunkExtensionAPI,
} from "hunkdiff/extension";

const hgAvailable = (() => {
  try {
    return spawnSync("hg", ["--version"], { stdio: "ignore" }).status === 0;
  } catch {
    return false;
  }
})();
const tempDirs: string[] = [];
const HgAdapterIntegrationTestTimeoutMs = 20_000;
const hgOperations: ExtensionVcsOperations = HgVcsAdapter.operations;

/** Create and track a temporary directory for one test. */
function createTempDir(prefix: string) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  tempDirs.push(dir);
  return dir;
}

/** Normalize Windows short and long temporary paths before comparison. */
function normalizeComparablePath(path: string) {
  const resolvedPath = platform() === "win32" ? realpathSync.native(path) : path;
  return resolvedPath.replace(/\\/g, "/");
}

/** Run one noninteractive Hg fixture command and return its text output. */
function hg(cwd: string, ...args: string[]) {
  const proc = spawnSync("hg", ["--noninteractive", "--color", "never", ...args], {
    cwd,
    encoding: "buffer",
    stdio: ["ignore", "pipe", "pipe"],
  });

  if (proc.error || proc.status !== 0) {
    const stderr = Buffer.from(proc.stderr ?? []).toString("utf8");
    throw proc.error ?? new Error(stderr.trim() || `hg ${args.join(" ")} failed`);
  }

  return Buffer.from(proc.stdout ?? []).toString("utf8");
}

/** Create a configured Mercurial repository suitable for commits in integration tests. */
function createTempHgRepo(prefix: string) {
  const dir = createTempDir(prefix);
  hg(dir, "init");
  writeFileSync(join(dir, ".hg", "hgrc"), "[ui]\nusername = Test User <test@example.com>\n");
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

describe("hunk-hg registration", () => {
  test("registers the Mercurial adapter", () => {
    let registered: unknown;
    const hunk = {
      registerVcsAdapter(adapter: unknown) {
        registered = adapter;
      },
    } as HunkExtensionAPI;

    registerHunkHg(hunk);
    expect(registered).toBe(HgVcsAdapter);
  });
});

describe("Mercurial repository detection", () => {
  test("finds the nearest Mercurial checkout from nested directories", () => {
    const repo = createTempDir("hunk-hg-detect-");
    mkdirSync(join(repo, ".hg"));
    const nested = join(repo, "src", "nested");
    mkdirSync(nested, { recursive: true });

    expect(detectHgRepo(nested)).toEqual({ id: "hg", repoRoot: repo });
  });

  test("returns null when no Mercurial marker exists", () => {
    expect(detectHgRepo(createTempDir("hunk-hg-none-"))).toBeNull();
  });
});

describe.skipIf(!hgAvailable)("Mercurial adapter integration", () => {
  test(
    "loads working-copy, range, and revision patches with unknown files",
    async () => {
      const repo = createTempHgRepo("hunk-hg-review-");
      writeFileSync(join(repo, "file.txt"), "one\n");
      hg(repo, "add", "file.txt");
      hg(repo, "commit", "-m", "initial");
      writeFileSync(join(repo, "file.txt"), "two\n");
      writeFileSync(join(repo, "unknown.txt"), "unknown\n");

      const diffInput = {
        kind: "vcs",
        staged: false,
        options: {},
      } satisfies ExtensionVcsDiffInput;
      const diffResult = await HgVcsAdapter.operations["working-tree-diff"]!.load(diffInput, {
        cwd: repo,
      });

      expect(normalizeComparablePath(diffResult.repoRoot)).toBe(normalizeComparablePath(repo));
      expect(diffResult.title).toContain("working copy");
      expect(diffResult.patchText).toContain("diff --git a/file.txt b/file.txt");
      expect(diffResult.patchText).toContain("+two");
      expect(diffResult.untrackedPaths).toEqual(["unknown.txt"]);

      hg(repo, "commit", "-m", "second", "file.txt");
      writeFileSync(join(repo, "file.txt"), "three\n");
      const rangeResult = await HgVcsAdapter.operations["working-tree-diff"]!.load(
        { ...diffInput, range: "0..1" },
        { cwd: repo },
      );
      expect(rangeResult.patchText).toContain("+two");
      expect(rangeResult.untrackedPaths).toEqual([]);

      const showInput = {
        kind: "show",
        ref: "1",
        options: {},
      } satisfies ExtensionVcsShowInput;
      const showResult = await HgVcsAdapter.operations["revision-show"]!.load(showInput, {
        cwd: repo,
      });
      expect(showResult.title).toContain("show 1");
      expect(showResult.patchText).toContain("diff --git a/file.txt b/file.txt");
      expect(showResult.patchText).toContain("+two");
    },
    HgAdapterIntegrationTestTimeoutMs,
  );

  test("keeps unknown paths repo-root-relative from nested directories", async () => {
    const repo = createTempHgRepo("hunk-hg-nested-");
    const nested = join(repo, "nested");
    mkdirSync(nested);
    writeFileSync(join(nested, "unknown.txt"), "unknown\n");

    const result = await HgVcsAdapter.operations["working-tree-diff"]!.load(
      { kind: "vcs", staged: false, options: {} },
      { cwd: nested },
    );

    expect(result.untrackedPaths).toEqual(["nested/unknown.txt"]);
  });

  test("rejects staged reviews and omits stash support", async () => {
    const stagedInput = {
      kind: "vcs",
      staged: true,
      options: {},
    } satisfies ExtensionVcsDiffInput;

    await expect(
      HgVcsAdapter.operations["working-tree-diff"]!.load(stagedInput, { cwd: tmpdir() }),
    ).rejects.toThrow("Mercurial has no staging area");
    expect(hgOperations["stash-show"]).toBeUndefined();
  });
});
