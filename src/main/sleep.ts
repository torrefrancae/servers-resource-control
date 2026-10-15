import { execFile, spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { HostConfig, HostId, resolveHosts } from "@src/shared/hosts";

const execFileAsync = promisify(execFile);

export type SleepResult = {
  id: HostId;
  label: string;
  ok: boolean;
  error?: string;
};

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
    /* missing env is handled by caller */
  }
  return out;
}

function envBesideScript(sshScript: string): string {
  return path.join(path.dirname(sshScript), ".env");
}

function scrubError(err: unknown, secrets: string[] = []): string {
  let message = err instanceof Error ? err.message : String(err);
  for (const secret of secrets) {
    if (secret && message.includes(secret)) {
      message = message.split(secret).join("***");
    }
  }
  message = message.replace(/printf '%s\\n' '[^']*'/g, "printf '%s\\n' '***'");
  return message.slice(0, 180);
}

function darwinRemoteSleepCmd(): string {
  return [
    "pkill -u \"$(whoami)\" -x caffeinate >/dev/null 2>&1 || true",
    "sync",
    "nohup sh -c 'sleep 0.6; pmset sleepnow' >/dev/null 2>&1 &",
    "echo SLEEP_SENT",
  ].join("; ");
}

function linuxRemoteSleepCmd(): string {
  /* one sudo auth via stdin; root schedules suspend so SSH can return */
  return "sudo -S -p '' bash -c 'nohup bash -c \"sleep 0.6; /bin/systemctl suspend\" >/dev/null 2>&1 & echo SLEEP_SENT'";
}

function localDarwinSleepCmd(): string {
  return [
    "pkill -u \"$(whoami)\" -x caffeinate >/dev/null 2>&1 || true",
    "sync",
    "pmset sleepnow",
  ].join("; ");
}

async function runLocal(command: string): Promise<void> {
  await execFileAsync("/bin/bash", ["-lc", command], {
    timeout: 15000,
    maxBuffer: 1024 * 64,
    env: process.env,
  });
}

function runRemote(
  sshScript: string,
  command: string,
  stdinText?: string,
  env: NodeJS.ProcessEnv = process.env,
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
      reject(new Error("sleep command timed out"));
    }, 20000);

    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(`${stdout}\n${stderr}`);
      else reject(new Error(`sleep remote exit ${code || 1}`));
    });

    if (stdinText != null) {
      child.stdin.write(stdinText);
      if (!stdinText.endsWith("\n")) child.stdin.write("\n");
    }
    child.stdin.end();
  });
}

export async function sleepHost(id: HostId): Promise<SleepResult> {
  if (id === "fleet") {
    return { id, label: "fleet", ok: false, error: "fleet is summary only" };
  }
  const hosts = resolveHosts();
  const host = hosts.find((h) => h.id === id);
  if (!host) {
    return { id, label: String(id), ok: false, error: "unknown host" };
  }

  let secret = "";
  try {
    if (host.source === "local") {
      const command =
        host.kind === "darwin" ? localDarwinSleepCmd() : linuxRemoteSleepCmd();
      await runLocal(command);
      return { id: host.id, label: host.label, ok: true };
    }

    if (!host.sshScript) throw new Error("missing ssh script");

    const childEnv: NodeJS.ProcessEnv = { ...process.env };
    if (host.sshHost) childEnv.SSH_HOST = host.sshHost;
    if (host.sshPort) childEnv.SSH_PORT = String(host.sshPort);

    if (host.kind === "darwin") {
      const out = await runRemote(
        host.sshScript,
        darwinRemoteSleepCmd(),
        undefined,
        childEnv,
      );
      if (!out.includes("SLEEP_SENT")) {
        throw new Error("sleep command did not confirm");
      }
      return { id: host.id, label: host.label, ok: true };
    }

    const fileEnv = readEnvFile(envBesideScript(host.sshScript));
    secret = fileEnv.SSH_PASSWORD || "";
    if (!secret) throw new Error("missing SSH_PASSWORD for sudo suspend");
    const out = await runRemote(
      host.sshScript,
      linuxRemoteSleepCmd(),
      secret,
      childEnv,
    );
    if (!out.includes("SLEEP_SENT")) {
      throw new Error("sleep command did not confirm");
    }
    return { id: host.id, label: host.label, ok: true };
  } catch (err) {
    return {
      id: host.id,
      label: host.label,
      ok: false,
      error: scrubError(err, [secret]),
    };
  }
}

export async function sleepHosts(ids?: HostId[]): Promise<SleepResult[]> {
  const hosts = resolveHosts();
  const selected = ids?.length
    ? hosts.filter((h) => ids.includes(h.id))
    : hosts;
  const remotes = selected.filter((h) => h.source === "ssh");
  const local = selected.find((h) => h.source === "local");
  const results: SleepResult[] = [];

  for (const host of remotes) {
    results.push(await sleepHost(host.id));
  }

  if (local) {
    await new Promise((r) => setTimeout(r, 800));
    results.push(await sleepHost(local.id));
  }

  return results;
}

/* silence unused HostConfig lint in some ts configs */
export type { HostConfig };
