#!/usr/bin/env bash
# Example SSH entrypoint expected by pc-resource-monitor.
# Copy beside a private .env (never commit the .env) and point hosts.json at this script.
set -euo pipefail

_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if [[ -f "$_DIR/.env" ]]; then
  set -a
  # shellcheck disable=SC1091
  . "$_DIR/.env"
  set +a
fi

_USER="${SSH_USER:-$USER}"
_HOST="${SSH_HOST:-example-host.local}"
_PORT="${SSH_PORT:-22}"

case "${1:-}" in
  --up|--check|--down|--restart)
    echo "wire these to your preferred SSH multiplex helper if you use one"
    exit 0
    ;;
esac

exec ssh -p "$_PORT" "${_USER}@${_HOST}" "$@"
