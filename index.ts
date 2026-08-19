import fs from "node:fs";
import { dirname, join, resolve } from "node:path";
import {
  buildHgDiffArgs,
  buildHgShowArgs,
  createHgStagedError,
  listHgUntrackedFiles,
  resolveHgRepoRoot,
  runHgText,
} from "./commands";
import type { ExtensionVcsAdapter, HunkExtensionAPI } from "hunkdiff/extension";

/** Return the last filesystem segment for a human-readable review title. */
function basename(path: string) {
  return path.split(/[\\/]/).filter(Boolean).pop() ?? path;
}

/** Walk upward to find the nearest Mercurial checkout without spawning Hg during startup. */
export function detectHgRepo(cwd: string) {
  let current = resolve(cwd);
  for (;;) {
    if (fs.existsSync(join(current, ".hg"))) {
      return { id: "hg" as const, repoRoot: current };
    }

    const parent = dirname(current);
    if (parent === current) {
      return null;
    }
    current = parent;
  }
}

/** Format a stable file-state fragment for the polling watch signature. */
export function statSignature(path: string) {
  if (!fs.existsSync(path)) {
    return `${path}:missing`;
  }

  const stat = fs.statSync(path);
  return `${path}:${stat.size}:${stat.mtimeMs}:${stat.ino}`;
}

/** VCS adapter translating Hunk's neutral review operations to Mercurial commands. */
export const HgVcsAdapter = {
  id: "hg",
  name: "Mercurial",
  detect: detectHgRepo,
  operations: {
    "working-tree-diff": {
      async load(input, { cwd }) {
        if (input.staged) {
          throw createHgStagedError(input);
        }

        const repoRoot = resolveHgRepoRoot(input, { cwd });
        const repoName = basename(repoRoot);
        return {
          repoRoot,
          sourceLabel: repoRoot,
          title: input.range ? `${repoName} ${input.range}` : `${repoName} working copy`,
          patchText: runHgText({ input, args: buildHgDiffArgs(input), cwd }),
          untrackedPaths: listHgUntrackedFiles(input, { cwd, repoRoot }),
        };
      },
      watchSignature(input, { cwd }) {
        const trackedPatch = runHgText({ input, args: buildHgDiffArgs(input), cwd });
        const repoRoot = resolveHgRepoRoot(input, { cwd });
        const untrackedSignatures = listHgUntrackedFiles(input, { cwd, repoRoot }).map(
          (filePath) => `untracked:${statSignature(join(repoRoot, filePath))}`,
        );
        return [trackedPatch, ...untrackedSignatures].join("\n---\n");
      },
    },
    "revision-show": {
      async load(input, { cwd }) {
        const repoRoot = resolveHgRepoRoot(input, { cwd });
        const repoName = basename(repoRoot);
        const revision = input.ref ?? ".";
        return {
          repoRoot,
          sourceLabel: repoRoot,
          title: `${repoName} show ${revision}`,
          patchText: runHgText({ input, args: buildHgShowArgs(input), cwd }),
        };
      },
      watchSignature(input, { cwd }) {
        return runHgText({ input, args: buildHgShowArgs(input), cwd });
      },
    },
  },
} satisfies ExtensionVcsAdapter;

/** Register Mercurial support with Hunk while its extension API is open. */
export default function registerHunkHg(hunk: HunkExtensionAPI) {
  hunk.registerVcsAdapter(HgVcsAdapter);
}
