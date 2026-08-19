import { describe, expect, test } from "vitest";
import {
  buildHgDiffArgs,
  buildHgShowArgs,
  createHgStagedError,
  listHgUntrackedFiles,
  runHgText,
} from "./commands";
import type { ExtensionVcsDiffInput, ExtensionVcsShowInput } from "hunkdiff/extension";

/** Build one working-tree review input for command tests. */
function diffInput(overrides: Partial<ExtensionVcsDiffInput> = {}): ExtensionVcsDiffInput {
  return { kind: "vcs", staged: false, options: {}, ...overrides };
}

describe("Mercurial command arguments", () => {
  test("builds a Git-extended working-copy patch", () => {
    expect(buildHgDiffArgs(diffInput())).toEqual(["diff", "--git"]);
  });

  test("compares one revision to the working copy", () => {
    expect(buildHgDiffArgs(diffInput({ range: "release" }))).toEqual([
      "diff",
      "--git",
      "--from",
      "release",
    ]);
  });

  test("translates Hunk's two-endpoint range syntax", () => {
    expect(buildHgDiffArgs(diffInput({ range: "one..two", pathspecs: ["src/file.ts"] }))).toEqual([
      "diff",
      "--git",
      "--from",
      "one",
      "--to",
      "two",
      "--",
      "src/file.ts",
    ]);
  });

  test("builds a single-changeset patch", () => {
    const input = {
      kind: "show",
      ref: "42",
      pathspecs: ["src/file.ts"],
      options: {},
    } satisfies ExtensionVcsShowInput;

    expect(buildHgShowArgs(input)).toEqual([
      "diff",
      "--git",
      "--change",
      "42",
      "--",
      "src/file.ts",
    ]);
  });
});

describe("Mercurial command errors", () => {
  test("reports a friendly error when Mercurial is unavailable", () => {
    expect(() =>
      runHgText({
        input: diffInput(),
        args: ["root"],
        hgExecutable: "definitely-not-a-real-hg-binary",
      }),
    ).toThrow(
      'Mercurial is required for `hunk diff` when `vcs = "hg"`, but `definitely-not-a-real-hg-binary` was not found in PATH.',
    );
  });

  test("describes staged review as unsupported", () => {
    expect(createHgStagedError(diffInput({ staged: true })).message).toContain(
      "Mercurial has no staging area",
    );
  });
});

describe("Mercurial untracked files", () => {
  test("skips the status subprocess when users exclude unknown files", () => {
    expect(
      listHgUntrackedFiles(diffInput({ options: { excludeUntracked: true } }), {
        hgExecutable: "definitely-not-a-real-hg-binary",
      }),
    ).toEqual([]);
  });
});
