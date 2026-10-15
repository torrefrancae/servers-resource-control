# Servers Resource Control

A tiny always-on-top Electron panel that polls CPU, memory, and GPU usage across your local machine and SSH-reachable LAN hosts.

Built as a personal ops utility: low chrome, fast glanceability, resizable layout, and optional sleep controls for lab machines.

## Why this exists

I wanted a floating strip I could leave on a secondary display while coding. Browser tabs and heavy dashboards were too noisy, so this app is:

- Frameless and lightweight
- Persistent window size and position
- Polled over SSH multiplexing wrappers you already trust
- Safe by default for public sharing: host inventory and secrets live outside the repo

## Features

- Local + remote host metrics (CPU / memory / GPU)
- Fleet summary row (average of online hosts + availability), hidden until toggled
- Per-host sleep and sleep-all (macOS `pmset`, Linux `systemctl suspend`)
- Always-on-top toggle vs normal window level
- Light / dark theme
- Compact multi-column layout when the window is short and wide
- macOS LaunchAgent install for login auto-start (`./serve.sh --install-login`)

## Architecture

```text
renderer (UI)
    ^ metrics IPC
main process
    |- local samplers (os / vm_stat / ioreg)
    |- remote samplers (SSH wrapper scripts)
    |- TCP reachability probe before SSH
    '- window state + pin preference (Electron userData)
```

| Layer | Role |
| --- | --- |
| `src/main` | Electron main, polling, sleep, GPU helpers |
| `src/renderer` | Floating panel UI |
| `src/shared` | Host config types + fleet aggregation |
| `config/hosts.json` | Private inventory (gitignored) |
| `config/hosts.example.json` | Public sample inventory |

Polling interval defaults to **2.5s**. Remote Linux CPU uses a short `/proc/stat` delta; Darwin remotes approximate CPU from load average; GPU uses `ioreg` on macOS and i915 engine runtime on Linux when available.

## Quick start

```bash
git clone https://github.com/torrefrancae/servers-resource-control.git
cd servers-resource-control
npm install
cp config/hosts.example.json config/hosts.json
# edit config/hosts.json with your hosts and SSH wrapper paths
npm start
```

Detached / restore helpers:

```bash
./serve.sh --headless          # start in background
./serve.sh --stop              # stop
./serve.sh --install-login     # macOS login item via LaunchAgent
./serve.sh --uninstall-login
```

## Configure hosts

`config/hosts.json` is intentionally **not** committed. Copy the example and point each SSH host at your own wrapper script:

```json
{
  "id": "linux-lab",
  "label": "linux-lab",
  "kind": "linux",
  "source": "ssh",
  "sshScript": "~/path/to/ssh-linux-lab.sh",
  "sshHost": "linux-lab.local",
  "sshPort": 22
}
```

See `examples/ssh-wrapper.example.sh` and `examples/env.example`.

Notes:

- Prefer SSH keys. Keep any sudo password in a local `.env` beside the wrapper (`SSH_PASSWORD`), never in git.
- `.local` hostnames follow machines across DHCP subnet changes better than hard-coded LAN IPs.
- The monitor only marks a host online after TCP port 22 succeeds, then samples over your wrapper.

## Security posture

- No credentials are stored in this repository
- Private host names, IPs, and SSH wrapper paths belong in gitignored `config/hosts.json`
- Remote sudo passwords (if used) are read from a local `.env`, passed on stdin, and scrubbed from error strings
- Renderer runs with `contextIsolation`, no Node integration, and a tight CSP

If you fork this for a portfolio demo, keep your real inventory private and ship only the example config.

## Stack

- Electron 35
- TypeScript (separate main / renderer compiles)
- Plain CSS with fluid `clamp()` sizing
- Node `child_process` + `net` for SSH and reachability

## License

MIT
