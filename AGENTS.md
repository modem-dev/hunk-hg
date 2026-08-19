# hunk-hg agent notes

## Purpose

`hunk-hg` is a standalone TypeScript extension that registers Mercurial support through Hunk's public `hunkdiff/extension` API. Keep provider commands and error translation local; do not import Hunk internals.

## Architecture

- `index.ts` detects `.hg` checkouts and registers `HgVcsAdapter`.
- `commands.ts` builds `hg` arguments, runs noninteractive commands, translates expected failures to `HunkExtensionUserError`, and lists unknown files.
- `*.test.ts` tests the public adapter surface. Tests requiring `hg` skip locally when it is absent; CI installs Mercurial.

## Rules

- Preserve Hunk's provider-neutral inputs and return `ExtensionVcsPatchResult` facts only.
- Emit `hg diff --git` output; the host parses and renders it.
- Unknown files are repo-root-relative and use `untrackedPaths`; Hunk synthesizes their diffs.
- Do not claim staging or Git-stash compatibility. Unsupported operations should remain omitted or return a user-facing error.
- Keep `watchPlan` absent until it can cover both `.hg` metadata and worktree state; polling is the safe default.
- Do not add an exact-source reader without pinning unambiguous old/new Mercurial endpoints.

## Commands

```sh
bun install
bun run format:check
bun run lint
bun run typecheck
bun run test
bun run check
```

## Releases

Maintain `CHANGELOG.md` under `## [Unreleased]` using Added, Changed, and Fixed subsections. Tag releases so users can pin `hunk extension install modem-dev/hunk-hg@vX.Y.Z`.

## Commits

Use Conventional Commits: `<type>[scope]: <description>`.
