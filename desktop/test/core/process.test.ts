// Lanceur de processus (tâche 3.6, régressions 46a9475 et a7d22bf).
import { describe, expect, test } from "bun:test";
import os from "node:os";
import { Readable } from "node:stream";
import {
  ENV_EXECUTABLE,
  KILL_GRACE_MS,
  ProcessGroup,
  ProcessLaunchError,
  pipe,
  run,
  STDERR_TAIL_LINES,
  start,
  systemRunnerEnv,
  widePath,
} from "../../src/core/process.ts";

const SH = "/bin/sh";

describe("process", () => {
  test("exit code, stdout and arguments are passed without a shell", async () => {
    const r = await run("/bin/echo", ["a b", "$HOME", "; rm -rf /"]);
    expect(r.code).toBe(0);
    expect(r.signal).toBeNull();
    expect(r.stdout).toBe("a b $HOME ; rm -rf /\n");
    expect(r.launched).toBe(true);
    expect((await run("/usr/bin/false", [])).code).toBe(1);
  });

  test("relative executables are refused", () => {
    expect(() => start("git", ["status"])).toThrow(TypeError);
  });

  test("a missing executable rejects with ENOENT", async () => {
    const error = await run("/nonexistent/cairn-tool", []).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ProcessLaunchError);
    expect((error as ProcessLaunchError).code).toBe("ENOENT");
  });

  test("environment: inherited, replaced, extended", async () => {
    const r = await run(SH, ["-c", 'printf "%s|%s" "$CAIRN_A" "$CAIRN_B"'], {
      env: { CAIRN_A: "1", PATH: "/usr/bin:/bin" },
      extraEnv: { CAIRN_B: "2" },
    });
    expect(r.stdout).toBe("1|2");
  });

  test("wide PATH of SystemRunner", () => {
    const home = os.homedir();
    expect(widePath(home)).toBe(
      [
        `${home}/.local/bin`,
        "/opt/homebrew/bin",
        "/usr/local/bin",
        `${home}/.local/share/mise/shims`,
        `${home}/.cargo/bin`,
        `${home}/go/bin`,
        "/usr/bin",
        "/bin",
        "/usr/sbin",
        "/sbin",
      ].join(":"),
    );
    const env = systemRunnerEnv({ KEEP: "x", PATH: "/usr/bin" });
    expect(env.PATH).toBe(widePath());
    expect(env.HOMEBREW_NO_AUTO_UPDATE).toBe("1");
    expect(env.KEEP).toBe("x");
    expect(ENV_EXECUTABLE).toBe("/usr/bin/env");
  });

  test("SystemRunner style: a command found through the wide PATH", async () => {
    const r = await run(ENV_EXECUTABLE, ["sh", "-c", 'echo "$HOMEBREW_NO_AUTO_UPDATE"'], { env: systemRunnerEnv() });
    expect(r.stdout).toBe("1\n");
  });

  test("stdin written while stdout is read: 32 MiB through cat without deadlock", async () => {
    const size = 32 * 1024 * 1024;
    const input = Buffer.alloc(size, 0x61);
    let received = 0;
    const r = await run("/bin/cat", [], { stdin: input, onData: (c) => (received += c.length) });
    expect(r.code).toBe(0);
    expect(received).toBe(size);
    expect(r.stdout).toBe(""); // onData : rien n'est gardé
  }, 30_000);

  test("stdin from a stream, stdout read line by line", async () => {
    async function* lines() {
      for (let i = 0; i < 100_000; i++) yield `line ${i}\n`;
    }
    const seen: string[] = [];
    const r = await run("/bin/cat", [], { stdin: Readable.from(lines()), onLine: (l) => seen.push(l) });
    expect(r.code).toBe(0);
    expect(seen.length).toBe(100_000);
    expect(seen[0]).toBe("line 0");
    expect(seen.at(-1)).toBe("line 99999");
  }, 30_000);

  test("a process that exits without reading its stdin is not an error (EPIPE)", async () => {
    const r = await run("/usr/bin/true", [], { stdin: Buffer.alloc(8 * 1024 * 1024) });
    expect(r.code).toBe(0);
  });

  test("CRLF lines are split without the carriage return", async () => {
    const seen: string[] = [];
    await run(SH, ["-c", "printf 'a\\r\\nb\\r\\n'"], { onLine: (l) => seen.push(l) });
    expect(seen).toEqual(["a", "b"]);
  });

  test("stderr keeps the last 20 lines only", async () => {
    const r = await run(SH, ["-c", "i=1; while [ $i -le 100 ]; do echo err$i >&2; i=$((i+1)); done; exit 23"]);
    expect(r.code).toBe(23);
    expect(STDERR_TAIL_LINES).toBe(20);
    expect(r.stderrTail.length).toBe(20);
    expect(r.stderrTail[0]).toBe("err81");
    expect(r.stderrTail.at(-1)).toBe("err100");
    const ignored = await run(SH, ["-c", "echo x >&2"], { stderr: "ignore" });
    expect(ignored.stderrTail).toEqual([]);
  });

  test("timeout: SIGTERM", async () => {
    const t = Date.now();
    const r = await run("/bin/sleep", ["30"], { timeoutMs: 200 });
    expect(r.timedOut).toBe(true);
    expect(r.signal).toBe("SIGTERM");
    expect(r.code).toBeNull();
    expect(Date.now() - t).toBeLessThan(5000);
  });

  test("timeout: SIGKILL after the grace delay when SIGTERM is ignored", async () => {
    expect(KILL_GRACE_MS).toBe(5000);
    const t = Date.now();
    const r = await run(SH, ["-c", "trap '' TERM; echo ready; while :; do sleep 0.1; done"], {
      timeoutMs: 300,
      killGraceMs: 300,
    });
    expect(r.timedOut).toBe(true);
    expect(r.signal).toBe("SIGKILL");
    expect(Date.now() - t).toBeLessThan(5000);
  });

  test("terminate and kill only a launched, running process", async () => {
    const p = start("/bin/sleep", ["30"]);
    expect(p.pid).toBeNumber();
    expect(p.running).toBe(true);
    p.terminate();
    const r = await p.result;
    expect(r.cancelled).toBe(true);
    expect(r.signal).toBe("SIGTERM");
    expect(p.running).toBe(false);
    // Terminé : plus aucun signal envoyé (le pid a pu être réutilisé).
    expect(p.kill("SIGKILL")).toBe(false);
    p.terminate();
  });

  test("suspend and resume", async () => {
    const p = start(SH, ["-c", "sleep 0.3; echo done"]);
    expect(p.suspend()).toBe(true);
    await new Promise((r) => setTimeout(r, 600));
    expect(p.running).toBe(true);
    expect(p.resume()).toBe(true);
    expect((await p.result).stdout).toBe("done\n");
  });

  test("abort signal stops the process", async () => {
    const controller = new AbortController();
    const p = start("/bin/sleep", ["30"], { signal: controller.signal });
    setTimeout(() => controller.abort(), 100);
    const r = await p.result;
    expect(r.cancelled).toBe(true);
    expect(r.signal).toBe("SIGTERM");
  });

  test("46a9475: a group stopped before launch never starts its process", async () => {
    const group = new ProcessGroup();
    const running = start("/bin/sleep", ["30"], { group });
    expect(group.size).toBe(1);
    group.abort();
    const r = await running.result;
    expect(r.cancelled).toBe(true);
    expect(r.launched).toBe(true);
    expect(group.size).toBe(0);
    // Arrêt demandé avant le lancement : rien n'est lancé, aucun signal envoyé.
    const later = start("/bin/sleep", ["30"], { group });
    expect(later.pid).toBeUndefined();
    expect(later.kill()).toBe(false);
    const lr = await later.result;
    expect(lr.launched).toBe(false);
    expect(lr.cancelled).toBe(true);
  });

  test("pipe: first | second through a kernel pipe, nothing kept in memory", async () => {
    const r = await pipe(
      { executable: "/bin/dd", args: ["if=/dev/zero", "bs=1048576", "count=64"] },
      { executable: "/usr/bin/wc", args: ["-c"] },
      {},
      { stderr: "ignore" },
    );
    expect(r.first.code).toBe(0);
    expect(r.second.code).toBe(0);
    expect(r.first.stdout).toBe("");
    expect(r.second.stdout.trim()).toBe(String(64 * 1024 * 1024));
  }, 30_000);

  test("pipe: second reads line by line, its exit code is reported", async () => {
    const seen: string[] = [];
    const r = await pipe(
      { executable: SH, args: ["-c", "printf 'b\\na\\nc\\n'"] },
      { executable: "/usr/bin/sort", args: [] },
      { onLine: (l) => seen.push(l) },
    );
    expect(seen).toEqual(["a", "b", "c"]);
    expect(r.second.code).toBe(0);
  });

  test("pipe: second exiting early stops the first (SIGPIPE or EPIPE), no hang", async () => {
    const r = await pipe({ executable: "/usr/bin/yes", args: [] }, { executable: "/usr/bin/head", args: ["-n", "3"] });
    expect(r.second.stdout).toBe("y\ny\ny\n");
    // SIGPIPE sous Node ; sous Bun l'enfant hérite de SIGPIPE ignoré et sort en erreur d'écriture.
    expect(r.first.signal === "SIGPIPE" || (r.first.code ?? 0) !== 0).toBe(true);
  }, 10_000);

  test("pipe: a missing first executable rejects", async () => {
    const error = await pipe({ executable: "/nonexistent/a", args: [] }, { executable: "/bin/cat", args: [] }).catch(
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(ProcessLaunchError);
  });
});
