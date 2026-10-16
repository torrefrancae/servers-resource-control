import { execFile, spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import type { HostConfig } from "@src/shared/hosts";

const execFileAsync = promisify(execFile);

function clampPercent(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(100, value));
}

function readEnvPassword(sshScript: string): string {
  const envPath = path.join(path.dirname(sshScript), ".env");
  try {
    const raw = fs.readFileSync(envPath, "utf8");
    for (const line of raw.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed.startsWith("SSH_PASSWORD=")) continue;
      let value = trimmed.slice("SSH_PASSWORD=".length).trim();
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1);
      }
      return value;
    }
  } catch {
    /* missing */
  }
  return "";
}

function parseDarwinGpu(text: string): number | null {
  const matches = [
    ...text.matchAll(/"Device Utilization %"(?:\s*at cur p-state)?\s*=\s*([0-9.]+)/g),
  ];
  if (!matches.length) {
    const alt = text.match(/"Renderer Utilization %"\s*=\s*([0-9.]+)/);
    return alt ? clampPercent(Number(alt[1])) : null;
  }
  const values = matches.map((m) => Number(m[1])).filter((n) => Number.isFinite(n));
  if (!values.length) return null;
  return clampPercent(Math.max(...values));
}

export async function sampleLocalDarwinGpu(): Promise<number | null> {
  try {
    const { stdout } = await execFileAsync(
      "/usr/sbin/ioreg",
      ["-r", "-d", "1", "-c", "IOAccelerator"],
      { timeout: 5000, maxBuffer: 1024 * 512 },
    );
    return parseDarwinGpu(stdout);
  } catch {
    return null;
  }
}

export const DARWIN_GPU_SNIPPET = [
  'GPU=$(ioreg -r -d 1 -c IOAccelerator 2>/dev/null | awk -F"= " \'/Device Utilization %/{gsub(/[ ;]/,"",$2); if($2+0==$2){print $2; exit}}\')',
  'echo "GPU ${GPU:-0}"',
].join("; ");

export function parseGpuLine(text: string): number | null {
  const line = text.match(/GPU\s+([0-9.]+)/);
  if (!line) return parseDarwinGpu(text);
  return clampPercent(Number(line[1]));
}

/* Base64-wrapped so remote login shells cannot expand $vars before python runs.
 * Runtime counters are milliseconds. Busy% = delta_ms / (interval_s * 1000) * 100.
 * Older formula divided by interval only, so anything above ~10% clamped to 100. */
const LINUX_GPU_PY = `
import json, re, shutil, subprocess, sys, time
pw = sys.stdin.read()
INTERVAL = 0.4

def run_sudo(args):
    return subprocess.run(
        ["sudo", "-S", "-p", "", *args],
        input=pw,
        text=True,
        capture_output=True,
    )

def from_intel_gpu_top():
    if not shutil.which("intel_gpu_top"):
        return None
    p = run_sudo(["timeout", "3", "intel_gpu_top", "-J", "-s", "500"])
    text = (p.stdout or "").strip()
    values = []
    depth = 0
    start = None
    for i, ch in enumerate(text):
        if ch == "{":
            if depth == 0:
                start = i
            depth += 1
        elif ch == "}":
            depth -= 1
            if depth == 0 and start is not None:
                chunk = text[start:i + 1]
                start = None
                try:
                    obj = json.loads(chunk)
                except Exception:
                    continue
                busy = (
                    obj.get("engines", {})
                    .get("Render/3D", {})
                    .get("busy")
                )
                if busy is not None:
                    values.append(float(busy))
    if not values:
        return None
    return max(0.0, min(100.0, values[-1]))

def runtime_ms():
    p = run_sudo(["cat", "/sys/kernel/debug/dri/0/i915_engine_info"])
    text = p.stdout or ""
    m = re.search(r"rcs0[\\s\\S]*?\\n\\tRuntime:\\s*(\\d+)ms", text)
    if not m:
        m = re.search(r"rcs0[\\s\\S]*?Runtime:\\s*(\\d+)ms", text)
    return int(m.group(1)) if m else None

util = from_intel_gpu_top()
if util is None:
    a = runtime_ms()
    time.sleep(INTERVAL)
    b = runtime_ms()
    if a is None or b is None or b < a:
        util = 0.0
    else:
        util = max(0.0, min(100.0, (b - a) / (INTERVAL * 1000.0) * 100.0))
print("GPU %.1f" % util)
`.trim();

function runRemoteWithStdin(
  sshScript: string,
  command: string,
  stdinText: string,
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
      reject(new Error("gpu sample timed out"));
    }, 20000);
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
      else reject(new Error(`gpu sample exit ${code || 1}`));
    });
    child.stdin.write(stdinText.endsWith("\n") ? stdinText : `${stdinText}\n`);
    child.stdin.end();
  });
}

export async function sampleLinuxGpu(
  host: HostConfig,
  env: NodeJS.ProcessEnv,
): Promise<number | null> {
  if (!host.sshScript) return null;
  const password = readEnvPassword(host.sshScript);
  if (!password) return null;
  try {
    const b64 = Buffer.from(LINUX_GPU_PY, "utf8").toString("base64");
    /* -c exec keeps SSH stdin free for the sudo password */
    const remote = `python3 -c "import base64; exec(base64.b64decode('${b64}').decode())"`;
    const out = await runRemoteWithStdin(host.sshScript, remote, password, env);
    return parseGpuLine(out);
  } catch {
    return null;
  }
}
