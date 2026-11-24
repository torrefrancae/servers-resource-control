import fs from "node:fs";
import path from "node:path";
import type { HostConfig } from "@src/shared/hosts";

export function readEnvFile(filePath: string): Record<string, string> {
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

export function envBesideScript(sshScript: string): string {
  return path.join(path.dirname(sshScript), ".env");
}

export function sshProcessEnv(host: HostConfig): NodeJS.ProcessEnv {
  const env = { ...process.env };
  if (host.sshHost) env.SSH_HOST = host.sshHost;
  if (host.sshPort) env.SSH_PORT = String(host.sshPort);
  if (host.sshUser) env.SSH_USER = host.sshUser;
  return env;
}

export function resolveHostPassword(host: HostConfig): string {
  if (host.sshPassword) return host.sshPassword;
  if (host.sshScript) {
    return readEnvFile(envBesideScript(host.sshScript)).SSH_PASSWORD || "";
  }
  return process.env.SUDO_PASSWORD || "";
}

export function hydrateHostSecrets(host: HostConfig): HostConfig {
  if (host.source !== "ssh" || !host.sshScript) return host;
  const env = readEnvFile(envBesideScript(host.sshScript));
  return {
    ...host,
    sshUser: host.sshUser || env.SSH_USER || undefined,
    sshPassword: host.sshPassword || env.SSH_PASSWORD || undefined,
    sshHost: host.sshHost || env.SSH_HOST || host.sshHost,
    sshPort: host.sshPort || (Number(env.SSH_PORT) > 0 ? Number(env.SSH_PORT) : undefined),
  };
}

export function writeEnvBesideScript(
  sshScript: string,
  values: {
    sshUser?: string;
    sshHost?: string;
    sshPort?: number;
    sshPassword?: string;
  },
): void {
  const file = envBesideScript(sshScript);
  const prev = readEnvFile(file);
  const next: Record<string, string> = { ...prev };
  if (values.sshUser) next.SSH_USER = values.sshUser;
  if (values.sshHost) next.SSH_HOST = values.sshHost;
  if (values.sshPort) next.SSH_PORT = String(values.sshPort);
  if (typeof values.sshPassword === "string") {
    if (values.sshPassword) next.SSH_PASSWORD = values.sshPassword;
    else delete next.SSH_PASSWORD;
  }
  const body = Object.entries(next)
    .map(([k, v]) => `${k}=${v}`)
    .join("\n");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${body}\n`, "utf8");
}
