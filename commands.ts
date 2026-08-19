import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { join, resolve } from "node:path";
import {
  HunkExtensionUserError,
  type ExtensionVcsDiffInput,
  type ExtensionVcsShowInput,
} from "hunkdiff/extension";

export type HgBackedInput = ExtensionVcsDiffInput | ExtensionVcsShowInput;

export interface RunHgTextOptions {
  input: HgBackedInput;
  args: string[];
  cwd?: string;
  hgExecutable?: string;
}

/** Add path filters only when Hunk received them after `--`. */
function appendHgPathspecs(args: string[], pathspecs?: string[]) {
  if (!pathspecs || pathspecs.length === 0) {
    return;
  }

  args.push("--", ...pathspecs);
}

/** Split Hunk's familiar two-endpoint range syntax into Mercurial diff endpoints. */
function splitRange(range: string) {
  const match = /^(?<from>.+)\.\.(?<to>.+)$/.exec(range);
  if (!match?.groups) {
    return null;
  }

  return { from: match.groups.from, to: match.groups.to };
}

/** Build a Git-extended Mercurial patch for a working-copy or two-revision review. */
export function buildHgDiffArgs(input: ExtensionVcsDiffInput) {
  const args = ["diff", "--git"];

  if (input.range) {
    const endpoints = splitRange(input.range);
    if (endpoints) {
      args.push("--from", endpoints.from, "--to", endpoints.to);
    } else {
      // `hunk diff REV` has Git's "REV versus working copy" meaning.
      args.push("--from", input.range);
    }
  }

  appendHgPathspecs(args, input.pathspecs);
  return args;
}

/** Build a Git-extended patch for one changeset against its first parent. */
export function buildHgShowArgs(input: ExtensionVcsShowInput) {
  const args = ["diff", "--git", "--change", input.ref ?? "."];
  appendHgPathspecs(args, input.pathspecs);
  return args;
}

/** Build the NUL-delimited unknown-file query that feeds Hunk's synthesized file diffs. */
function buildHgStatusArgs(input: ExtensionVcsDiffInput) {
  const args = ["status", "--unknown", "--no-status", "--print0"];
  appendHgPathspecs(args, input.pathspecs);
  return args;
}

/** Format the Hunk command that caused an Hg invocation. */
export function formatHgCommandLabel(input: HgBackedInput) {
  if (input.kind === "vcs") {
    if (input.staged) {
      return "hunk diff --staged";
    }

    return input.range ? `hunk diff ${input.range}` : "hunk diff";
  }

  return input.ref ? `hunk show ${input.ref}` : "hunk show";
}

/** Remove Mercurial's standard error prefix from one diagnostic line. */
function trimHgPrefix(message: string) {
  return message.replace(/^(abort|error|hg):\s*/i, "").trim();
}

/** Return the first useful diagnostic line for a generic Hg failure. */
function firstHgErrorLine(stderr: string) {
  const line = stderr
    .split("\n")
    .map((entry) => entry.trim())
    .find(Boolean);

  return trimHgPrefix((line ?? stderr.trim()) || "Mercurial command failed.");
}

/** Return whether Mercurial reported that the command is outside a repository. */
function isMissingHgRepoMessage(stderr: string) {
  return ["no repository found", "not in a repository", ".hg not found"].some((fragment) =>
    stderr.toLowerCase().includes(fragment),
  );
}

/** Return whether Mercurial reported an invalid revision or revset. */
function isInvalidRevisionMessage(stderr: string) {
  return [
    "unknown revision",
    "empty revision set",
    "ambiguous identifier",
    "invalid revision",
    "parse error",
    "revision not found",
  ].some((fragment) => stderr.toLowerCase().includes(fragment));
}

/** Create the actionable error for a missing Mercurial executable. */
function createMissingHgExecutableError(input: HgBackedInput, hgExecutable: string) {
  return new HunkExtensionUserError(
    `Mercurial is required for \`${formatHgCommandLabel(input)}\` when \`vcs = "hg"\`, but \`${hgExecutable}\` was not found in PATH.`,
    { suggestions: ['Install Mercurial or set `vcs = "git"` in Hunk config, then try again.'] },
  );
}

/** Create the actionable error for an Hg command outside an Hg checkout. */
function createMissingHgRepoError(input: HgBackedInput) {
  return new HunkExtensionUserError(
    `\`${formatHgCommandLabel(input)}\` must be run inside a Mercurial repository when \`vcs = "hg"\`.`,
    {
      suggestions: [
        'Run the command from a Mercurial checkout, or set `vcs = "git"` in Hunk config.',
      ],
    },
  );
}

/** Return the user-facing error when Hunk asks Mercurial for a staged diff. */
export function createHgStagedError(input: ExtensionVcsDiffInput) {
  return new HunkExtensionUserError(
    `\`${formatHgCommandLabel(input)}\` requires Git VCS mode because Mercurial has no staging area.`,
    { suggestions: ['Remove `--staged`, or set `vcs = "git"` in Hunk config.'] },
  );
}

/** Create the actionable error for an unresolvable Hg revision. */
function createInvalidRevisionError(input: HgBackedInput) {
  const revision = input.kind === "vcs" ? input.range : (input.ref ?? ".");
  return new HunkExtensionUserError(
    `\`${formatHgCommandLabel(input)}\` could not resolve Mercurial revision \`${revision}\`.`,
    { suggestions: ["Check the revision and try again."] },
  );
}

/** Preserve the first Hg diagnostic for failures without a more specific repair. */
function createGenericHgError(input: HgBackedInput, stderr: string) {
  return new HunkExtensionUserError(`\`${formatHgCommandLabel(input)}\` failed.`, {
    suggestions: [firstHgErrorLine(stderr)],
  });
}

/** Translate Bun process-spawn errors into an error Hunk can present to a reviewer. */
function translateHgSpawnFailure(
  input: HgBackedInput,
  error: unknown,
  hgExecutable: string,
): Error {
  if (error instanceof HunkExtensionUserError) {
    return error;
  }

  if (
    error instanceof Error &&
    (error.message.includes("Executable not found in $PATH") ||
      (error as NodeJS.ErrnoException).code === "ENOENT")
  ) {
    return createMissingHgExecutableError(input, hgExecutable);
  }

  return error instanceof Error ? error : new Error(String(error));
}

/** Translate expected Hg command failures into user-actionable extension errors. */
function translateHgExitFailure(input: HgBackedInput, stderr: string) {
  if (isMissingHgRepoMessage(stderr)) {
    return createMissingHgRepoError(input);
  }

  if (isInvalidRevisionMessage(stderr)) {
    return createInvalidRevisionError(input);
  }

  return createGenericHgError(input, stderr);
}

/** Spawn one noninteractive Mercurial command and require a successful exit status. */
function runHgCommand({ input, args, cwd = process.cwd(), hgExecutable = "hg" }: RunHgTextOptions) {
  const command = ["--noninteractive", "--color", "never", ...args];
  let proc: ReturnType<typeof spawnSync>;

  try {
    proc = spawnSync(hgExecutable, command, {
      cwd,
      encoding: "buffer",
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (error) {
    throw translateHgSpawnFailure(input, error, hgExecutable);
  }

  if (proc.error) {
    throw translateHgSpawnFailure(input, proc.error, hgExecutable);
  }

  const stdout = Buffer.from(proc.stdout ?? []).toString("utf8");
  const stderr = Buffer.from(proc.stderr ?? []).toString("utf8");

  if (proc.status !== 0) {
    throw translateHgExitFailure(
      input,
      stderr.trim() || `Command failed: ${[hgExecutable, ...command].join(" ")}`,
    );
  }

  return stdout;
}

/** Run Mercurial and translate ordinary invocation failures for Hunk's UI. */
export function runHgText(options: RunHgTextOptions) {
  return runHgCommand(options);
}

/** Return whether this working-copy review should include unknown files. */
function shouldIncludeUntrackedFiles(input: ExtensionVcsDiffInput) {
  // A two-revision comparison has no working-copy side, so current unknown files
  // would make it report content outside the requested historical endpoints.
  return (
    !input.staged &&
    input.options.excludeUntracked !== true &&
    (!input.range || splitRange(input.range) === null)
  );
}

/** Return whether one unknown path can become a Hunk-synthesized file diff. */
function isReviewableUntrackedPath(repoRoot: string, filePath: string) {
  const absolutePath = join(repoRoot, filePath);

  let pathInfo: fs.Stats;
  try {
    pathInfo = fs.lstatSync(absolutePath);
  } catch {
    return true;
  }

  if (pathInfo.isDirectory()) {
    return false;
  }

  if (!pathInfo.isSymbolicLink()) {
    return true;
  }

  try {
    return !fs.statSync(absolutePath).isDirectory();
  } catch {
    return true;
  }
}

/** Return every repo-root-relative unknown path that Hunk should synthesize. */
export function listHgUntrackedFiles(
  input: ExtensionVcsDiffInput,
  {
    cwd = process.cwd(),
    repoRoot,
    hgExecutable = "hg",
  }: Omit<RunHgTextOptions, "input" | "args"> & { repoRoot?: string } = {},
) {
  if (!shouldIncludeUntrackedFiles(input)) {
    return [];
  }

  const untrackedPaths = runHgText({
    input,
    args: buildHgStatusArgs(input),
    cwd,
    hgExecutable,
  })
    .split("\0")
    .filter(Boolean);

  if (untrackedPaths.length === 0) {
    return [];
  }

  const normalizedRepoRoot = repoRoot ?? resolveHgRepoRoot(input, { cwd, hgExecutable });
  return untrackedPaths.filter((filePath) =>
    isReviewableUntrackedPath(normalizedRepoRoot, filePath),
  );
}

/** Resolve and normalize the Mercurial checkout root for one Hunk operation. */
export function resolveHgRepoRoot(
  input: HgBackedInput,
  options: Omit<RunHgTextOptions, "input" | "args"> = {},
) {
  const repoRoot = runHgText({ input, args: ["root"], ...options }).trim();
  return resolve(repoRoot);
}
