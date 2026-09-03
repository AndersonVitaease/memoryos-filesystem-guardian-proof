/**
 * FS-00 — Safe File Change.
 *
 * Derived only from the filesystem problem:
 *   - the caller may change the content of ONE regular file inside the ONE
 *     root the operator authorized (fixtures/); the root is not a parameter;
 *   - the caller names the file relative to that root and states the content
 *     it observed when it decided to change it, plus the new content it wants;
 *   - if the file no longer contains the observed content at execution time,
 *     the world moved during the decision window: the operation stops instead
 *     of silently overwriting what it finds (content precondition);
 *   - the write primitive returning is not evidence: the final content is
 *     read back and must prove itself equal to the intended content;
 *   - when the state cannot be established, the result says so; success is
 *     never assumed and absence of evidence is never success.
 */

import {
  closeSync,
  fstatSync,
  ftruncateSync,
  lstatSync,
  openSync,
  readSync,
  realpathSync,
  writeSync,
} from "node:fs";
import { dirname, join, posix, resolve, sep, win32 } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Operator authority for this lab: the only authorized root.
 * Derived from the lab location itself; never accepted from a caller.
 */
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const AUTHORIZED_ROOT = join(REPO_ROOT, "fixtures");

export type SafeFileChangeStatus =
  | "PLAN_READY"                // read-only observation the decision is based on
  | "APPLIED"                   // precondition held; final content proven equal to the intent
  | "BLOCKED"                   // request refused before any effect on the filesystem
  | "STOPPED_CONCURRENT_CHANGE" // file no longer holds the observed content: stop safely
  | "FAILED"                    // written, but read-back disproves the intended final content
  | "UNKNOWN";                  // state not establishable; success is not claimed

export interface SafeFileChangeInput {
  /** Logical file name relative to the authorized root. No "..", no absolute paths. */
  path: string;
  /** Content the caller observed when deciding. Required to execute. */
  expectedCurrentContent?: string;
  /** Content the caller wants the file to hold afterwards. Required to execute. */
  newContent?: string;
  /** Omitted/false: observe only (plan). true: perform the change. */
  execute?: boolean;
}

export interface SafeFileChangeResult {
  status: SafeFileChangeStatus;
  mutationPerformed: boolean;
  writeAttempted: boolean;
  reasons: string[];
  /** PLAN_READY only: content observed through the authorized root. */
  observedContent?: string;
  /** STOPPED_CONCURRENT_CHANGE only: content actually present at execution time. */
  currentContent?: string;
}

const strictUtf8 = new TextDecoder("utf-8", { fatal: true });
const lenientUtf8 = new TextDecoder("utf-8", { fatal: false });

interface ResolvedTarget {
  ok: boolean;
  realTarget?: string;
  reason?: string;
  unknown?: boolean;
}

function resolveAuthorizedTarget(segments: string[]): ResolvedTarget {
  const joined = join(AUTHORIZED_ROOT, ...segments);
  let realTarget: string;
  try {
    realTarget = realpathSync(joined);
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") {
      return { ok: false, reason: "TARGET_NOT_FOUND" };
    }
    return { ok: false, reason: "TARGET_STATE_UNREADABLE", unknown: true };
  }
  let realRoot: string;
  try {
    realRoot = realpathSync(AUTHORIZED_ROOT);
  } catch {
    return { ok: false, reason: "AUTHORIZED_ROOT_UNAVAILABLE", unknown: true };
  }
  const confined = realTarget === realRoot || realTarget.startsWith(realRoot + sep);
  if (!confined) {
    return { ok: false, reason: "ESCAPES_AUTHORIZED_ROOT" };
  }
  try {
    if (!lstatSync(realTarget).isFile()) {
      return { ok: false, reason: "NOT_A_REGULAR_FILE" };
    }
  } catch {
    return { ok: false, reason: "TARGET_STATE_UNREADABLE", unknown: true };
  }
  return { ok: true, realTarget };
}

function readAllViaFd(fd: number, totalBytes?: number): Buffer {
  const total = totalBytes ?? fstatSync(fd).size;
  if (total <= 0) return Buffer.alloc(0);
  const buffer = Buffer.alloc(total);
  let filled = 0;
  while (filled < total) {
    const read = readSync(fd, buffer, filled, total - filled, filled);
    if (read <= 0) break; // shrank concurrently: report only what is really there
    filled += read;
  }
  return filled === total ? buffer : buffer.subarray(0, filled);
}

export function safeFileChange(input: SafeFileChangeInput): SafeFileChangeResult {
  const refused = (reason: string): SafeFileChangeResult => ({
    status: "BLOCKED",
    mutationPerformed: false,
    writeAttempted: false,
    reasons: [reason],
  });
  const unknownState = (reason: string): SafeFileChangeResult => ({
    status: "UNKNOWN",
    mutationPerformed: false,
    writeAttempted: false,
    reasons: [reason],
  });

  const request = (input ?? {}) as {
    path?: unknown;
    execute?: unknown;
    expectedCurrentContent?: unknown;
    newContent?: unknown;
  };

  // Confinement is decided before any filesystem effect.
  const requestPath = request.path;
  if (typeof requestPath !== "string" || requestPath.length === 0) return refused("PATH_REQUIRED");
  if (requestPath.includes("\0")) return refused("PATH_MALFORMED");
  if (/^[a-zA-Z]:/.test(requestPath)) return refused("ABSOLUTE_PATH_BLOCKED"); // drive-absolute and drive-relative
  if (win32.isAbsolute(requestPath) || posix.isAbsolute(requestPath)) return refused("ABSOLUTE_PATH_BLOCKED");
  const segments = requestPath.split(/[\\/]+/);
  for (const segment of segments) {
    if (segment === "..") return refused("PATH_TRAVERSAL_BLOCKED");
    if (segment === "." || segment === "") return refused("PATH_MALFORMED");
  }

  const execute = request.execute === true;
  if (execute) {
    if (typeof request.expectedCurrentContent !== "string") return refused("EXPECTED_CURRENT_CONTENT_REQUIRED");
    if (typeof request.newContent !== "string") return refused("NEW_CONTENT_REQUIRED");
  }

  const resolved = resolveAuthorizedTarget(segments);
  if (!resolved.ok) {
    return resolved.unknown ? unknownState(resolved.reason!) : refused(resolved.reason!);
  }
  const realTarget = resolved.realTarget!;

  // Plan: observe the exact content the decision will be based on. Read-only.
  if (!execute) {
    let readFd: number;
    try {
      readFd = openSync(realTarget, "r");
    } catch {
      return unknownState("TARGET_STATE_UNREADABLE");
    }
    try {
      let observed: string;
      try {
        observed = strictUtf8.decode(readAllViaFd(readFd));
      } catch {
        return refused("OBSERVED_CONTENT_NOT_UTF8_TEXT");
      }
      return { status: "PLAN_READY", mutationPerformed: false, writeAttempted: false, reasons: [], observedContent: observed };
    } finally {
      try { closeSync(readFd); } catch { /* observation already produced; closing cannot mutate */ }
    }
  }

  // Execute: content precondition first — one descriptor, checked and written in place.
  let fd: number;
  try {
    fd = openSync(realTarget, "r+");
  } catch {
    return unknownState("TARGET_STATE_UNREADABLE");
  }
  try {
    let current: Buffer;
    try {
      current = readAllViaFd(fd);
    } catch {
      return unknownState("TARGET_STATE_UNREADABLE");
    }
    if (!current.equals(Buffer.from(request.expectedCurrentContent as string, "utf8"))) {
      return {
        status: "STOPPED_CONCURRENT_CHANGE",
        mutationPerformed: false,
        writeAttempted: false,
        reasons: ["CURRENT_CONTENT_DOES_NOT_MATCH_OBSERVED"],
        currentContent: lenientUtf8.decode(current),
      };
    }

    const next = Buffer.from(request.newContent as string, "utf8");
    // Mutation begins here: replace the whole content in one attempt. Never retried.
    try {
      ftruncateSync(fd, 0);
      writeSync(fd, next, 0, next.length, 0);
    } catch {
      return { status: "UNKNOWN", mutationPerformed: true, writeAttempted: true, reasons: ["WRITE_OUTCOME_UNDETERMINED"] };
    }

    // The primitive returning is not evidence: read the final content back.
    let finalBytes: Buffer;
    try {
      finalBytes = readAllViaFd(fd, fstatSync(fd).size);
    } catch {
      return { status: "UNKNOWN", mutationPerformed: true, writeAttempted: true, reasons: ["FINAL_CONTENT_UNVERIFIABLE"] };
    }
    if (!finalBytes.equals(next)) {
      return { status: "FAILED", mutationPerformed: true, writeAttempted: true, reasons: ["FINAL_CONTENT_DOES_NOT_MATCH_INTENDED"] };
    }
    return { status: "APPLIED", mutationPerformed: true, writeAttempted: true, reasons: [] };
  } finally {
    try { closeSync(fd); } catch { /* status already carries proven or unproven evidence */ }
  }
}
