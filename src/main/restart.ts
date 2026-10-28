import { execFile, spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import type { HostConfig, HostId } from "@src/shared/hosts";
import { resolveHosts } from "@src/shared/hosts";

const execFileAsync = promisify(execFile);

export type RestartResult = {
  id: HostId;
  label: string;
  ok: boolean;
  error?: string;
  skipped?: boolean;
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
    /* missing */
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
  return message.slice(0, 180);
}

function sshEnv(host: HostConfig): NodeJS.ProcessEnv {
  const env = { ...process.env };
  if (host.sshHost) env.SSH_HOST = host.sshHost;
  if (host.sshPort) env.SSH_PORT = String(host.sshPort);
  return env;
}

function findSudoPassword(preferScript?: string): string {
  if (preferScript) {
    const direct = readEnvFile(envBesideScript(preferScript)).SSH_PASSWORD || "";
    if (direct) return direct;
  }
  for (const host of resolveHosts()) {
    if (!host.sshScript) continue;
    const pw = readEnvFile(envBesideScript(host.sshScript)).SSH_PASSWORD || "";
    if (pw) return pw;
  }
  return process.env.SUDO_PASSWORD || "";
}

/* Force reboot: clear common blockers, then hard restart. */
function darwinRemoteRestartCmd(): string {
  return [
    "pkill -u \"$(whoami)\" -x caffeinate >/dev/null 2>&1 || true",
    "sync",
    "sudo -S -p '' bash -c 'nohup bash -c \"sleep 0.8; /sbin/shutdown -r now\" >/dev/null 2>&1 & echo REBOOT_SENT'",
  ].join("; ");
}

function linuxRemoteRestartCmd(): string {
  return "sudo -S -p '' bash -c 'nohup bash -c \"sleep 0.8; systemctl reboot --force --force\" >/dev/null 2>&1 & echo REBOOT_SENT'";
}

function localDarwinRestartCmd(secret: string): string {
  const escaped = secret.replace(/'/g, `'\"'\"'`);
  return [
    "pkill -u \"$(whoami)\" -x caffeinate >/dev/null 2>&1 || true",
    "sync",
    `printf '%s\\n' '${escaped}' | sudo -S -p '' /sbin/shutdown -r now`,
  ].join("; ");
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
      reject(new Error("restart command timed out"));
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

async function restartOne(host: HostConfig): Promise<RestartResult> {
  let secret = "";
  try {
    if (host.source === "local") {
      if (host.kind !== "darwin") {
        return {
          id: host.id,
          label: host.label,
          ok: false,
          error: "local restart only supported on macOS",
        };
      }
      secret = findSudoPassword();
      if (!secret) {
        return {
          id: host.id,
          label: host.label,
          ok: false,
          error: "missing sudo password for local restart",
        };
      }
      await execFileAsync("/bin/bash", ["-lc", localDarwinRestartCmd(secret)], {
        timeout: 15000,
        maxBuffer: 1024 * 64,
        env: process.env,
      });
      return { id: host.id, label: host.label, ok: true };
    }

    if (!host.sshScript) {
      return {
        id: host.id,
        label: host.label,
        ok: false,
        error: "missing ssh script",
      };
    }
    secret = findSudoPassword(host.sshScript);
    if (!secret) {
      return {
        id: host.id,
        label: host.label,
        ok: false,
        error: "missing SSH_PASSWORD",
      };
    }

    const cmd =
      host.kind === "darwin" ? darwinRemoteRestartCmd() : linuxRemoteRestartCmd();
    const out = await runRemote(host.sshScript, cmd, secret, sshEnv(host));
    if (!out.includes("REBOOT_SENT")) {
      throw new Error("restart command did not confirm");
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

export async function restartHost(id: HostId): Promise<RestartResult> {
  if (id === "fleet") {
    return { id, label: "fleet", ok: false, error: "fleet is summary only" };
  }
  const host = resolveHosts().find((h) => h.id === id);
  if (!host) {
    return { id, label: String(id), ok: false, error: "unknown host" };
  }
  return restartOne(host);
}

export async function restartHosts(): Promise<RestartResult[]> {
  const hosts = resolveHosts();
  const remotes = hosts.filter((h) => h.source === "ssh");
  const local = hosts.find((h) => h.source === "local");
  const results: RestartResult[] = [];

  for (const host of remotes) {
    const result = await restartOne(host);
    results.push(result);
  }

  const remoteFailed = results.some((r) => !r.ok);
  if (local) {
    if (remoteFailed) {
      results.push({
        id: local.id,
        label: local.label,
        ok: false,
        skipped: true,
        error: "skipped - remote restart failed",
      });
      return results;
    }
    await new Promise((r) => setTimeout(r, 900));
    results.push(await restartOne(local));
  }

  return results;
}
