# memoryos-filesystem-guardian-proof

> **EXPERIMENTAL**
> **FS-00**
> **Private proof**

## Purpose

Test whether safe execution invariants independently emerge in a
filesystem write domain — specifically: safely changing the content of
ONE authorized file inside an explicitly controlled root.

## Independence statement

This proof must not assume that the VPS/GitHub Guardian architecture
is universally correct.

The experiment is allowed to **REFUTE** the Guardian Core thesis.

No VPS Guardian, GitHub Guardian or Guardian Core mechanisms are
assumed: snapshot, fingerprint, approval, revalidation and
post-validation are NOT implemented and NOT presumed necessary.
The minimum mechanism required by the filesystem problem itself will
be derived first, and only afterwards compared with the other domains.

## Non-goals

- No delete/move/rename/directory operations.
- No shell, chmod, executables, symlinks, recursive or glob operations.
- No batch/multiple files, Git, GitHub, VPS, MCP server, API or CLI.
- No Guardian Core.

## Safety constraints (for the future experiment)

The experiment must NEVER operate on real user files. It will operate
ONLY inside a single explicitly controlled root. Reserved (conceptually,
not implemented yet):

- `fixtures/` — the only permitted future workspace.

Never permitted: `C:\`, `Users\`, `Documents\`, `Desktop\`,
`Downloads\`, SSH directories, credential directories, GitHub auth
directories, MemoryOS production directories.

## Setup

```bash
npm install
npm run typecheck
npm test
```

Baseline criteria: `TYPECHECK=PASS` and `TESTS=PASS`.
