#!/usr/bin/env bash
# Detached launcher for the tiny always-on-top servers resource control panel.
set -euo pipefail

SERVE_ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEBUG_LOG="${DEBUG_LOG:-$SERVE_ROOT_DIR/debug.log}"
PID_FILE="${SERVE_ROOT_DIR}/.serve-headless.pid"
HEADLESS_LOG="${SERVE_ROOT_DIR}/serve-headless.log"
LABEL="com.et.servers-resource-control"
LEGACY_LABEL="com.et.pc-resource-monitor"
APP_DIR_NAME="$(basename "$SERVE_ROOT_DIR")"

sanitize_log_line() {
  tr -d '\000' | tr -cd '\11\12\15\40-\176'
}

append_debug_log() {
  local line="$1"
  local clean
  clean="$(printf '%s' "$line" | sanitize_log_line)"
  printf '[%s] %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$clean" >>"$DEBUG_LOG"
}

usage() {
  cat <<'EOF'
Usage: ./serve.sh [--headless] [--port=N] [pc_label]
       ./serve.sh --restore
       ./serve.sh --stop
       ./serve.sh --install-login
       ./serve.sh --uninstall-login
EOF
}

is_running() {
  if [[ -f "$PID_FILE" ]]; then
    local pid
    pid="$(cat "$PID_FILE" 2>/dev/null || true)"
    if [[ -n "$pid" ]] && kill -0 "$pid" 2>/dev/null; then
      return 0
    fi
  fi
  pgrep -f "electron .*${APP_DIR_NAME}" >/dev/null 2>&1
}

stop_app() {
  local pids
  pids="$(pgrep -f "/${APP_DIR_NAME}/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron" 2>/dev/null || true)"
  if [[ -z "$pids" ]]; then
    pids="$(pgrep -f '/pc-resource-monitor/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron' 2>/dev/null || true)"
  fi
  if [[ -n "$pids" ]]; then
    # shellcheck disable=SC2086
    kill $pids 2>/dev/null || true
    sleep 1.2
    # shellcheck disable=SC2086
    kill -0 $pids 2>/dev/null && kill -9 $pids 2>/dev/null || true
  fi
  if [[ -f "$PID_FILE" ]]; then
    local pid
    pid="$(cat "$PID_FILE" 2>/dev/null || true)"
    if [[ -n "$pid" ]] && kill -0 "$pid" 2>/dev/null; then
      kill "$pid" 2>/dev/null || true
      sleep 0.5
      kill -9 "$pid" 2>/dev/null || true
    fi
    rm -f "$PID_FILE"
  fi
  pkill -f "/${APP_DIR_NAME}/node_modules/electron" 2>/dev/null || true
  pkill -f "/pc-resource-monitor/node_modules/electron" 2>/dev/null || true
  pkill -f "electron .*${APP_DIR_NAME}" 2>/dev/null || true
  pkill -f "electron .*pc-resource-monitor" 2>/dev/null || true
  sleep 0.5
}

install_login() {
  local plist="$HOME/Library/LaunchAgents/${LABEL}.plist"
  local node_bin npm_bin node_dir path_value
  node_bin="$(command -v node)"
  npm_bin="$(command -v npm)"
  node_dir="$(dirname "$node_bin")"
  path_value="${node_dir}:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"
  mkdir -p "$(dirname "$plist")"
  cat >"$SERVE_ROOT_DIR/scripts/login-run.sh" <<EOF
#!/usr/bin/env bash
set -euo pipefail
export PATH="${path_value}"
export HOME="${HOME}"
export npm_config_yes=true
cd "${SERVE_ROOT_DIR}"
exec /bin/bash "${SERVE_ROOT_DIR}/serve.sh" --headless
EOF
  chmod +x "$SERVE_ROOT_DIR/scripts/login-run.sh" "$SERVE_ROOT_DIR/serve.sh"
  cat >"$plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/bash</string>
    <string>${SERVE_ROOT_DIR}/scripts/login-run.sh</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <false/>
  <key>WorkingDirectory</key>
  <string>${SERVE_ROOT_DIR}</string>
  <key>StandardOutPath</key>
  <string>${SERVE_ROOT_DIR}/serve-headless.log</string>
  <key>StandardErrorPath</key>
  <string>${SERVE_ROOT_DIR}/serve-headless.log</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>${path_value}</string>
    <key>HOME</key>
    <string>${HOME}</string>
  </dict>
</dict>
</plist>
EOF
  launchctl bootout "gui/$(id -u)/${LEGACY_LABEL}" 2>/dev/null || true
  rm -f "$HOME/Library/LaunchAgents/${LEGACY_LABEL}.plist"
  launchctl bootout "gui/$(id -u)/${LABEL}" 2>/dev/null || true
  launchctl bootstrap "gui/$(id -u)" "$plist"
  launchctl enable "gui/$(id -u)/${LABEL}" 2>/dev/null || true
  append_debug_log "installed login agent ${LABEL} node=${node_bin} npm=${npm_bin}"
  echo "Login auto-start installed: $plist"
}

uninstall_login() {
  local plist="$HOME/Library/LaunchAgents/${LABEL}.plist"
  launchctl bootout "gui/$(id -u)/${LABEL}" 2>/dev/null || true
  launchctl bootout "gui/$(id -u)/${LEGACY_LABEL}" 2>/dev/null || true
  rm -f "$plist" "$HOME/Library/LaunchAgents/${LEGACY_LABEL}.plist"
  append_debug_log "removed login agent ${LABEL}"
  echo "Login auto-start removed"
}

MODE="fg"
RESTORE=0
STOP=0
INSTALL=0
UNINSTALL=0

for arg in "$@"; do
  case "$arg" in
    --headless) MODE="headless" ;;
    --restore) RESTORE=1 ;;
    --stop) STOP=1 ;;
    --install-login) INSTALL=1 ;;
    --uninstall-login) UNINSTALL=1 ;;
    --port=*) ;;
    -h|--help) usage; exit 0 ;;
    *) ;;
  esac
done

if [[ "$STOP" -eq 1 ]]; then
  stop_app
  echo "stopped"
  exit 0
fi

if [[ "$UNINSTALL" -eq 1 ]]; then
  uninstall_login
  exit 0
fi

if [[ "$INSTALL" -eq 1 ]]; then
  install_login
  exit 0
fi

if [[ "$RESTORE" -eq 1 ]]; then
  stop_app
  MODE="headless"
fi

cd "$SERVE_ROOT_DIR"
: >"$DEBUG_LOG"

if [[ ! -d node_modules/electron ]]; then
  append_debug_log "npm install"
  npm install >>"$DEBUG_LOG" 2>&1
fi

append_debug_log "npm run build"
npm run build >>"$DEBUG_LOG" 2>&1

if is_running; then
  append_debug_log "already running"
  echo "servers-resource-control already running"
  exit 0
fi

export ELECTRON_ENABLE_LOGGING=1

if [[ "$MODE" == "headless" ]]; then
  append_debug_log "start headless"
  nohup npm start >>"$HEADLESS_LOG" 2>&1 &
  echo $! >"$PID_FILE"
  sleep 5
  if [[ -f "$DEBUG_LOG" ]]; then
    head -n 80 "$DEBUG_LOG" || true
  fi
  if is_running; then
    echo "started headless pid=$(cat "$PID_FILE")"
  else
    echo "start may have failed; check $HEADLESS_LOG and $DEBUG_LOG" >&2
    exit 1
  fi
else
  append_debug_log "start foreground"
  exec npm start
fi
