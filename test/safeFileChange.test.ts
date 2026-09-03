import { beforeEach, describe, expect, it } from "vitest";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { AUTHORIZED_ROOT, safeFileChange, type SafeFileChangeInput } from "../src/safeFileChange";

function resetFixtures(): void {
  mkdirSync(AUTHORIZED_ROOT, { recursive: true });
  for (const entry of readdirSync(AUTHORIZED_ROOT)) {
    rmSync(join(AUTHORIZED_ROOT, entry), { recursive: true, force: true });
  }
}

function fixturesSnapshot(): Map<string, string> {
  const snapshot = new Map<string, string>();
  const walk = (dir: string, prefix: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const key = prefix + entry.name;
      if (entry.isDirectory()) walk(join(dir, entry.name), key + "/");
      else snapshot.set(key, readFileSync(join(dir, entry.name), "utf8"));
    }
  };
  walk(AUTHORIZED_ROOT, "");
  return snapshot;
}

describe("FS-00 safe file change", () => {
  beforeEach(resetFixtures);

  it("1. an authorized file can be observed for a change without mutation", () => {
    const target = join(AUTHORIZED_ROOT, "target.txt");
    writeFileSync(target, "X");

    const result = safeFileChange({ path: "target.txt" });

    expect(result.status).toBe("PLAN_READY");
    expect(result.observedContent).toBe("X");
    expect(result.mutationPerformed).toBe(false);
    expect(result.writeAttempted).toBe(false);
    expect(readFileSync(target, "utf8")).toBe("X");
  });

  it("2. path traversal is blocked before any effect", () => {
    const target = join(AUTHORIZED_ROOT, "target.txt");
    writeFileSync(target, "X");

    for (const hostile of ["../outside.txt", "a/../b.txt", "..\\..\\outside.txt", "sub/../../outside.txt", ".."]) {
      const result = safeFileChange({ path: hostile, execute: true, expectedCurrentContent: "X", newContent: "Y" });
      expect(result.status, hostile).toBe("BLOCKED");
      expect(result.reasons, hostile).toContain("PATH_TRAVERSAL_BLOCKED");
      expect(result.mutationPerformed, hostile).toBe(false);
      expect(result.writeAttempted, hostile).toBe(false);
    }

    expect(existsSync(join(AUTHORIZED_ROOT, "..", "outside.txt"))).toBe(false);
    expect(readFileSync(target, "utf8")).toBe("X");
  });

  it("3. absolute paths are blocked", () => {
    const target = join(AUTHORIZED_ROOT, "target.txt");
    writeFileSync(target, "X");

    for (const hostile of [
      "C:\\Users\\Micro\\victim.txt",
      "C:victim.txt",
      "\\victim.txt",
      "/etc/hosts",
      "\\\\server\\share\\victim.txt",
      "//server/share/victim.txt",
    ]) {
      const result = safeFileChange({ path: hostile, execute: true, expectedCurrentContent: "X", newContent: "Y" });
      expect(result.status, hostile).toBe("BLOCKED");
      expect(result.reasons, hostile).toContain("ABSOLUTE_PATH_BLOCKED");
      expect(result.mutationPerformed, hostile).toBe(false);
    }

    expect(readFileSync(target, "utf8")).toBe("X");
  });

  it("4. the caller cannot redirect the operation to another root", () => {
    const target = join(AUTHORIZED_ROOT, "target.txt");
    writeFileSync(target, "X");

    const hostile = safeFileChange({
      path: "victim.txt",
      execute: true,
      expectedCurrentContent: "X",
      newContent: "Y",
      root: "C:\\__fs00_not_a_root__",
      fs: { writeFileSync: () => { throw new Error("must not be used"); } },
    } as unknown as SafeFileChangeInput);

    expect(hostile.status).toBe("BLOCKED");
    expect(hostile.reasons).toContain("TARGET_NOT_FOUND"); // resolved inside fixtures only
    expect(hostile.mutationPerformed).toBe(false);
    expect(readFileSync(target, "utf8")).toBe("X");
  });

  it("5. X to Y without concurrency applies and proves the final content", () => {
    const target = join(AUTHORIZED_ROOT, "target.txt");
    writeFileSync(target, "X");

    const observation = safeFileChange({ path: "target.txt" });
    expect(observation.status).toBe("PLAN_READY");
    expect(observation.observedContent).toBe("X");

    const result = safeFileChange({
      path: "target.txt",
      execute: true,
      expectedCurrentContent: observation.observedContent,
      newContent: "Y",
    });

    expect(result.status).toBe("APPLIED");
    expect(result.mutationPerformed).toBe(true);
    expect(result.writeAttempted).toBe(true);
    expect(result.reasons).toEqual([]);
    expect(readFileSync(target, "utf8")).toBe("Y");
  });

  it("5b. replacing content leaves no residue from longer content", () => {
    const target = join(AUTHORIZED_ROOT, "target.txt");
    writeFileSync(target, "AAAAAAAAAA");

    const result = safeFileChange({ path: "target.txt", execute: true, expectedCurrentContent: "AAAAAAAAAA", newContent: "BB" });

    expect(result.status).toBe("APPLIED");
    expect(readFileSync(target, "utf8")).toBe("BB");
  });

  it("5c. replacing content with empty content works", () => {
    const target = join(AUTHORIZED_ROOT, "target.txt");
    writeFileSync(target, "data");

    const result = safeFileChange({ path: "target.txt", execute: true, expectedCurrentContent: "data", newContent: "" });

    expect(result.status).toBe("APPLIED");
    expect(readFileSync(target, "utf8")).toBe("");
  });

  it("6. a concurrent change is stopped, never silently overwritten", () => {
    const target = join(AUTHORIZED_ROOT, "target.txt");
    writeFileSync(target, "X");

    const observation = safeFileChange({ path: "target.txt" });
    expect(observation.observedContent).toBe("X");

    writeFileSync(target, "Z"); // another actor changes X -> Z during the decision window

    const result = safeFileChange({ path: "target.txt", execute: true, expectedCurrentContent: "X", newContent: "Y" });

    expect(result.status).toBe("STOPPED_CONCURRENT_CHANGE");
    expect(result.mutationPerformed).toBe(false);
    expect(result.writeAttempted).toBe(false);
    expect(result.currentContent).toBe("Z");
    expect(readFileSync(target, "utf8")).toBe("Z"); // Z survives untouched
  });

  it("7. errors and indeterminate states never invent success", () => {
    // missing file: refused, and never created
    const missing = safeFileChange({ path: "ghost.txt", execute: true, expectedCurrentContent: "X", newContent: "Y" });
    expect(missing.status).toBe("BLOCKED");
    expect(missing.reasons).toContain("TARGET_NOT_FOUND");
    expect(missing.mutationPerformed).toBe(false);
    expect(existsSync(join(AUTHORIZED_ROOT, "ghost.txt"))).toBe(false);

    // directory: not a regular file
    mkdirSync(join(AUTHORIZED_ROOT, "a-directory"));
    const directory = safeFileChange({ path: "a-directory", execute: true, expectedCurrentContent: "X", newContent: "Y" });
    expect(directory.status).toBe("BLOCKED");
    expect(directory.reasons).toContain("NOT_A_REGULAR_FILE");

    // target that cannot be opened for writing: state not establishable, success not claimed
    const locked = join(AUTHORIZED_ROOT, "locked.txt");
    writeFileSync(locked, "X");
    chmodSync(locked, 0o444);
    try {
      const unreadable = safeFileChange({ path: "locked.txt", execute: true, expectedCurrentContent: "X", newContent: "Y" });
      expect(unreadable.status).toBe("UNKNOWN");
      expect(unreadable.reasons).toContain("TARGET_STATE_UNREADABLE");
      expect(unreadable.mutationPerformed).toBe(false);
      expect(unreadable.writeAttempted).toBe(false);
    } finally {
      chmodSync(locked, 0o666);
    }
    expect(readFileSync(locked, "utf8")).toBe("X");

    // malformed execute requests refused without any filesystem effect
    const noExpected = safeFileChange({ path: "locked.txt", execute: true, newContent: "Y" } as unknown as SafeFileChangeInput);
    expect(noExpected.status).toBe("BLOCKED");
    expect(noExpected.reasons).toContain("EXPECTED_CURRENT_CONTENT_REQUIRED");
    const noNext = safeFileChange({ path: "locked.txt", execute: true, expectedCurrentContent: "X" } as unknown as SafeFileChangeInput);
    expect(noNext.status).toBe("BLOCKED");
    expect(noNext.reasons).toContain("NEW_CONTENT_REQUIRED");
  });

  it("8. at most one file is mutated", () => {
    writeFileSync(join(AUTHORIZED_ROOT, "target.txt"), "X");
    writeFileSync(join(AUTHORIZED_ROOT, "other-a.txt"), "OA");
    writeFileSync(join(AUTHORIZED_ROOT, "other-b.txt"), "OB");
    mkdirSync(join(AUTHORIZED_ROOT, "sub"));
    writeFileSync(join(AUTHORIZED_ROOT, "sub", "nested.txt"), "N");

    const before = fixturesSnapshot();
    expect(before.size).toBe(4);

    const result = safeFileChange({ path: "target.txt", execute: true, expectedCurrentContent: "X", newContent: "Y" });
    expect(result.status).toBe("APPLIED");

    const after = fixturesSnapshot();
    expect(after.size).toBe(4); // no files created, none deleted
    expect(after.get("target.txt")).toBe("Y");
    expect(after.get("other-a.txt")).toBe("OA");
    expect(after.get("other-b.txt")).toBe("OB");
    expect(after.get("sub/nested.txt")).toBe("N");
  });

  it("9. the derived mechanism needs no network, process or Git primitives", () => {
    const sources = ["src/safeFileChange.ts", "src/index.ts"].map((relative) =>
      readFileSync(new URL("../" + relative, import.meta.url), "utf8"),
    );

    const importSpecifiers = sources.flatMap((source) =>
      [...source.matchAll(/from\s+["']([^"']+)["']/g)].map((match) => match[1]),
    );
    for (const specifier of importSpecifiers) {
      expect(["node:fs", "node:path", "node:url"], specifier).toContain(specifier);
    }

    const forbidden = [
      "child_process",
      "node:net",
      "node:http",
      "node:https",
      "node:tls",
      "node:dns",
      "node:worker_threads",
      "spawn",
      "execFile",
      "execSync",
      "require(",
      "eval(",
      "fetch(",
      "XMLHttpRequest",
      "WebSocket",
    ];
    for (const source of sources) {
      for (const token of forbidden) {
        expect(source.includes(token), token).toBe(false);
      }
    }
  });

  it("10. a link that escapes the authorized root cannot be used to change outside files", () => {
    const probeDir = join(AUTHORIZED_ROOT, "..", ".fs00-escape-probe");
    const victim = join(probeDir, "victim.txt");
    const link = join(AUTHORIZED_ROOT, "escape-link");
    rmSync(probeDir, { recursive: true, force: true });
    mkdirSync(probeDir, { recursive: true });
    writeFileSync(victim, "OUTSIDE-VICTIM");
    symlinkSync(probeDir, link, "junction");
    try {
      const result = safeFileChange({
        path: "escape-link/victim.txt",
        execute: true,
        expectedCurrentContent: "OUTSIDE-VICTIM",
        newContent: "Y",
      });

      expect(result.status).toBe("BLOCKED");
      expect(result.reasons).toContain("ESCAPES_AUTHORIZED_ROOT");
      expect(result.mutationPerformed).toBe(false);
      expect(readFileSync(victim, "utf8")).toBe("OUTSIDE-VICTIM");
    } finally {
      rmSync(link, { recursive: true, force: true });
      rmSync(probeDir, { recursive: true, force: true });
    }
  });
});
