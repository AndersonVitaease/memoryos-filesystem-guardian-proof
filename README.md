# Filesystem Guardian

An AI agent reads a file at state `X` and decides to change it to `Y`. Before execution, another actor changes the file to `Z`. A stale agent decision must not silently overwrite `Z`.

Filesystem Guardian is an experimental Guardian for **safe file changes for AI agents**: decisions are bound to the exact observed file state, revalidated byte-for-byte immediately before writing, and only called successful when read-back evidence proves the final content.

> Give AI agents capabilities. Not unrestricted authority.

## The problem

```
observe X
→ decide X → Y
→ state becomes Z (another actor)
→ stale execution arrives
```

Without protection, the stale `X → Y` decision silently overwrites `Z` — the newer state is lost, and the agent may never know. This is the classic stale-write hazard for autonomous agents acting on files.

## What Filesystem Guardian does

```
Intent
→ Observe exact file state
→ Bound decision
→ Fresh state check
→ Controlled write
→ Read-back verification
→ Evidence-based result
```

The proof uses a natural two-phase flow:

- **PLAN** — reads and records the exact observed content.
- **EXECUTE** — receives the expected observed content, opens and reads the current state, compares byte-for-byte, and only writes if `current == expected`.

If `current != expected`: `STOPPED_CONCURRENT_CHANGE`, zero write.

## Stale write example

The exact scenario proven by tests in this repository:

```
T0: file = X
T1: agent observes X
T2: agent decides X → Y
T3: another actor changes X → Z
T4: stale agent tries X → Y

Guardian:
current != expected
→ STOPPED_CONCURRENT_CHANGE
→ writeAttempted=false
→ mutationPerformed=false
→ final file remains exactly Z
```

## Bounded filesystem authority

The caller does not receive unrestricted filesystem authority. In the certified design, the caller supplies only intent; the operator controls the rest:

```
caller intent
↓
operator-controlled root (<repo>/fixtures)
↓
path validation / containment
↓
existing regular file only
↓
controlled mutation
```

Blocked (proven by tests): absolute paths, drive paths, UNC paths, POSIX absolute paths, `..`, `.`, empty path, null path. `realpath` containment prevents escape via junction/symlink in the tested scenario. This is not a defense against every filesystem attack — see [Limitations](#limitations).

## Success is evidence

```
write returned  ≠  final state proven
```

The certified mutation path is `ftruncateSync(fd, 0)` followed by **one** `writeSync` on the same verified descriptor — 1 file, 1 write, zero retries — followed by a **read-back through the same descriptor**. The write's return value is never treated as proof of success:

- final == intended → `APPLIED`
- proven mismatch → `FAILED`
- outcome cannot be established → `UNKNOWN`

Real outcome vocabulary in this repo: `PLAN_READY`, `APPLIED`, `BLOCKED`, `STOPPED_CONCURRENT_CHANGE`, `FAILED`, `UNKNOWN`.

## What was tested

Baseline certified on this repository:

- **13/13 PASS** (Vitest) + `TYPECHECK=PASS`
- stale `X → Z` protection with zero write on stale state
- path authority restrictions (the block list above)
- controlled one-file mutation, zero retry
- read-back verification; `UNKNOWN` when evidence is insufficient

Reproduce locally:

```bash
npm install
npm run typecheck
npm test
```

Repository layout:

```
src/safeFileChange.ts     the governed file-change flow
test/                     Vitest baseline (13 tests)
```

## Relationship to Guardian Core

Filesystem Guardian started as an **independent proof**: it does not import Guardian Core at runtime. Its behavior was later used to test and conform the horizontal model of [Guardian Core](https://github.com/AndersonVitaease/memoryos-guardian-core) — the experimental domain-agnostic Safe Execution Core (bind → gate → apply, fail-closed) behind the broader Guardian approach.

## Limitations

- Experimental. This is **not** production certification.
- Evidence applies to the tested filesystem path only.
- No malicious-adapter / malicious-environment guarantee.
- **Residual TOCTOU/race**: a window remains between `realpath`/validation and `open`. Node.js does not expose, in this design, all the low-level primitives needed to universally eliminate symlink/locking races.
- No distributed locking, no universal filesystem transaction, no exactly-once guarantee.
- `UNKNOWN` remains possible when the outcome cannot be established — it is never guessed away.
- No LICENSE file is included yet; all rights reserved by the author. Public visibility does not make this open source.

## Guardian ecosystem

- [Guardian Core](https://github.com/AndersonVitaease/memoryos-guardian-core) — experimental domain-agnostic Safe Execution Core (bind → gate → apply, fail-closed).
- [VPS Guardian](https://github.com/AndersonVitaease/memoryos-vps-guardian-pro) — governed VPS/Dokploy application redeploy with supervised rollback evidence.
- [GitHub Guardian](https://github.com/AndersonVitaease/memoryos-github-guardian-proof) — state-bound PR merge execution using GitHub's native SHA precondition and independent post-merge verification.
- [Email Guardian](https://github.com/AndersonVitaease/memoryos-email-guardian-proof) — bounded outbound email execution with stale-state protection, same-instance keyed duplicate suppression and evidence-based outcomes.
