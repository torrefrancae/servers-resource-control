import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { HostConfig, HostId } from "@src/shared/hosts";
import { resolveHosts } from "@src/shared/hosts";

export type ScheduleHostState = {
  id: HostId;
  label: string;
  kind: "linux" | "darwin";
  armed: boolean;
  detail: string;
  ok: boolean;
  error?: string;
};

export type ScheduleState = {
  armed: boolean;
  hosts: ScheduleHostState[];
  updatedAt: number;
};

const DARWIN_WAKE = "wakeorpoweron MTWRF 15:00:00";
const DARWIN_SLEEP = "sleep MTWRFSU 05:00:00";
const LINUX_TIMER = "cctv-sleep.timer";

function readEnvFile(filePath: string): Record<string, string> {
  const out: Record<string, string> = {};
  try {
    const raw = fs.readFileSync(filePath, "utf8");
    for (const line of raw.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#") || !trimmed.includes("=")) continue;
      const i = trimmed.indexOf("=");
      const key = trimmed.slice(0, i).trim();
      let value = trimmed.slice(i + 1).trim();
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1);
      }
      out[key] = value;
    }
  } catch {
    /* missing */
  }
  return out;
}

function scrub(err: unknown, secrets: string[] = []): string {
  let message = err instanceof Error ? err.message : String(err);
  for (const secret of secrets) {
    if (secret && message.includes(secret)) {
      message = message.split(secret).join("***");
    }
  }
  return message.slice(0, 160);
}

function sshEnv(host: HostConfig): NodeJS.ProcessEnv {
  const env = { ...process.env };
  if (host.sshHost) env.SSH_HOST = host.sshHost;
  if (host.sshPort) env.SSH_PORT = String(host.sshPort);
  return env;
}

function runRemote(
  sshScript: string,
  command: string,
  stdinText: string | undefined,
  env: NodeJS.ProcessEnv,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(sshScript, [command], {
      env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("schedule command timed out"));
    }, 25000);
    child.stdout.on("data", (c: Buffer) => {
      stdout += c.toString("utf8");
    });
    child.stderr.on("data", (c: Buffer) => {
      stderr += c.toString("utf8");
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(`${stdout}\n${stderr}`);
      else reject(new Error((stderr || stdout || `exit ${code || 1}`).slice(0, 180)));
    });
    if (stdinText != null) {
      child.stdin.write(stdinText.endsWith("\n") ? stdinText : `${stdinText}\n`);
    }
    child.stdin.end();
  });
}

function scheduledHosts(): HostConfig[] {
  return resolveHosts().filter((h) => h.source === "ssh");
}

function parseDarwinArmed(text: string): boolean {
  return /sleep\s+at\s+5:00\s*AM/i.test(text) || /sleep\s+MTWRFSU\s+05:00/i.test(text);
}

async function readDarwin(host: HostConfig): Promise<ScheduleHostState> {
  if (!host.sshScript) {
    return {
      id: host.id,
      label: host.label,
      kind: "darwin",
      armed: false,
      detail: "missing ssh",
      ok: false,
      error: "missing ssh script",
    };
  }
  try {
    const out = await runRemote(host.sshScript, "pmset -g sched", undefined, sshEnv(host));
    const armed = parseDarwinArmed(out);
    return {
      id: host.id,
      label: host.label,
      kind: "darwin",
      armed,
      detail: armed ? "pmset sleep 05:00 daily" : "no 05:00 sleep",
      ok: true,
    };
  } catch (err) {
    return {
      id: host.id,
      label: host.label,
      kind: "darwin",
      armed: false,
      detail: "unreachable",
      ok: false,
      error: scrub(err),
    };
  }
}

async function readLinux(host: HostConfig): Promise<ScheduleHostState> {
  if (!host.sshScript) {
    return {
      id: host.id,
      label: host.label,
      kind: "linux",
      armed: false,
      detail: "missing ssh",
      ok: false,
      error: "missing ssh script",
    };
  }
  try {
    const out = await runRemote(
      host.sshScript,
      `systemctl is-enabled ${LINUX_TIMER} 2>/dev/null; systemctl is-active ${LINUX_TIMER} 2>/dev/null; systemctl show ${LINUX_TIMER} -p NextElapseUSecRealtime --value 2>/dev/null`,
      undefined,
      sshEnv(host),
    );
    const enabled = /^enabled\b/m.test(out);
    const active = /\bactive\b/.test(out.split(/\n/)[1] || "");
    const armed = enabled || active;
    return {
      id: host.id,
      label: host.label,
      kind: "linux",
      armed,
      detail: armed ? `${LINUX_TIMER} armed` : `${LINUX_TIMER} off`,
      ok: true,
    };
  } catch (err) {
    return {
      id: host.id,
      label: host.label,
      kind: "linux",
      armed: false,
      detail: "unreachable",
      ok: false,
      error: scrub(err),
    };
  }
}

async function writeDarwin(host: HostConfig, armed: boolean): Promise<ScheduleHostState> {
  const secret = host.sshScript
    ? readEnvFile(path.join(path.dirname(host.sshScript), ".env")).SSH_PASSWORD || ""
    : "";
  if (!host.sshScript) {
    return {
      id: host.id,
      label: host.label,
      kind: "darwin",
      armed: false,
      detail: "missing ssh",
      ok: false,
      error: "missing ssh script",
    };
  }
  if (!secret) {
    return {
      id: host.id,
      label: host.label,
      kind: "darwin",
      armed: false,
      detail: "missing sudo password",
      ok: false,
      error: "missing SSH_PASSWORD",
    };
  }
  const repeat = armed
    ? `pmset repeat ${DARWIN_WAKE} ${DARWIN_SLEEP}`
    : `pmset repeat ${DARWIN_WAKE}`;
  const cmd = `sudo -S -p '' bash -c '${repeat}; echo SCHED_OK; pmset -g sched'`;
  try {
    const out = await runRemote(host.sshScript, cmd, secret, sshEnv(host));
    if (!out.includes("SCHED_OK")) throw new Error("schedule change did not confirm");
    const nextArmed = parseDarwinArmed(out);
    return {
      id: host.id,
      label: host.label,
      kind: "darwin",
      armed: nextArmed,
      detail: nextArmed ? "pmset sleep 05:00 daily" : "no 05:00 sleep",
      ok: true,
    };
  } catch (err) {
    return {
      id: host.id,
      label: host.label,
      kind: "darwin",
      armed: false,
      detail: "write failed",
      ok: false,
      error: scrub(err, [secret]),
    };
  }
}

async function writeLinux(host: HostConfig, armed: boolean): Promise<ScheduleHostState> {
  const secret = host.sshScript
    ? readEnvFile(path.join(path.dirname(host.sshScript), ".env")).SSH_PASSWORD || ""
    : "";
  if (!host.sshScript) {
    return {
      id: host.id,
      label: host.label,
      kind: "linux",
      armed: false,
      detail: "missing ssh",
      ok: false,
      error: "missing ssh script",
    };
  }
  if (!secret) {
    return {
      id: host.id,
      label: host.label,
      kind: "linux",
      armed: false,
      detail: "missing sudo password",
      ok: false,
      error: "missing SSH_PASSWORD",
    };
  }
  const action = armed
    ? `systemctl enable --now ${LINUX_TIMER}`
    : `systemctl disable --now ${LINUX_TIMER}`;
  const cmd = `sudo -S -p '' bash -c '${action}; echo SCHED_OK; systemctl is-enabled ${LINUX_TIMER} || true; systemctl is-active ${LINUX_TIMER} || true'`;
  try {
    const out = await runRemote(host.sshScript, cmd, secret, sshEnv(host));
    if (!out.includes("SCHED_OK")) throw new Error("schedule change did not confirm");
    const enabled = /^enabled\b/m.test(out);
    return {
      id: host.id,
      label: host.label,
      kind: "linux",
      armed: enabled,
      detail: enabled ? `${LINUX_TIMER} armed` : `${LINUX_TIMER} off`,
      ok: true,
    };
  } catch (err) {
    return {
      id: host.id,
      label: host.label,
      kind: "linux",
      armed: false,
      detail: "write failed",
      ok: false,
      error: scrub(err, [secret]),
    };
  }
}

function pack(hosts: ScheduleHostState[]): ScheduleState {
  const known = hosts.filter((h) => h.ok);
  return {
    armed: known.some((h) => h.armed),
    hosts,
    updatedAt: Date.now(),
  };
}

export async function getAutoSleepSchedule(): Promise<ScheduleState> {
  const hosts = scheduledHosts();
  const results = await Promise.all(
    hosts.map((h) => (h.kind === "darwin" ? readDarwin(h) : readLinux(h))),
  );
  return pack(results);
}

export async function setAutoSleepSchedule(armed: boolean): Promise<ScheduleState> {
  const hosts = scheduledHosts();
  const results: ScheduleHostState[] = [];
  for (const host of hosts) {
    results.push(
      host.kind === "darwin"
        ? await writeDarwin(host, armed)
        : await writeLinux(host, armed),
    );
  }
  return pack(results);
}
