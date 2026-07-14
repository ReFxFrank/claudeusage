#!/usr/bin/env bash
#
# Pulse — one-command installer for an Ubuntu (systemd) VPS.
#
#   curl -fsSL https://raw.githubusercontent.com/refxfrank/Pulse-Usage-Monitor/main/install.sh | bash
#
# or, from a checkout:   ./install.sh
#
# What it does:
#   1. Fetches Pulse (git clone, or uses the current checkout).
#   2. Ensures Node.js >= 18 (installs Node 20 LTS via NodeSource if needed).
#   3. Installs a systemd service that runs Pulse, restarts on failure, and
#      starts on boot — as the user whose ~/.claude holds your usage.
#   4. Binds to 127.0.0.1 by default and prints the SSH-tunnel command to reach
#      it securely. (Set PULSE_HOST=0.0.0.0 to expose it — you'll be warned.)
#
# Overridable via env: PULSE_REPO PULSE_BRANCH PULSE_DIR PULSE_PORT PULSE_HOST
set -euo pipefail

PULSE_REPO="${PULSE_REPO:-https://github.com/refxfrank/Pulse-Usage-Monitor.git}"
PULSE_BRANCH="${PULSE_BRANCH:-main}"
PULSE_PORT="${PULSE_PORT:-4747}"
PULSE_HOST="${PULSE_HOST:-127.0.0.1}"

c_mag=$'\033[35m'; c_red=$'\033[31m'; c_yel=$'\033[33m'; c_dim=$'\033[2m'; c_off=$'\033[0m'
log(){ printf '%s[pulse]%s %s\n' "$c_mag" "$c_off" "$*"; }
warn(){ printf '%s[pulse] %s%s\n' "$c_yel" "$*" "$c_off"; }
die(){ printf '%s[pulse] %s%s\n' "$c_red" "$*" "$c_off" >&2; exit 1; }

# --- who owns the ~/.claude we should read, and can we get root? -------------
if [ -n "${SUDO_USER:-}" ] && [ "${SUDO_USER}" != "root" ]; then
  TARGET_USER="$SUDO_USER"
else
  TARGET_USER="$(id -un)"
fi
TARGET_HOME="$(getent passwd "$TARGET_USER" 2>/dev/null | cut -d: -f6)"
[ -z "$TARGET_HOME" ] && TARGET_HOME="${HOME:-/home/$TARGET_USER}"

if [ "$(id -u)" -eq 0 ]; then SUDO=""; HAVE_ROOT=1
elif command -v sudo >/dev/null 2>&1; then SUDO="sudo"; HAVE_ROOT=1
else SUDO=""; HAVE_ROOT=0; fi

PULSE_DIR="${PULSE_DIR:-$TARGET_HOME/pulse}"

run_as_target(){ # run a command as TARGET_USER (dropping root if needed)
  if [ "$(id -un)" = "$TARGET_USER" ]; then bash -lc "$*";
  else $SUDO -u "$TARGET_USER" bash -lc "$*"; fi
}

# --- 1. fetch the code -------------------------------------------------------
SELF_SRC="${BASH_SOURCE[0]:-}"
SELF_DIR=""
[ -n "$SELF_SRC" ] && SELF_DIR="$(cd -- "$(dirname -- "$SELF_SRC")" 2>/dev/null && pwd || true)"

if [ -n "$SELF_DIR" ] && [ -f "$SELF_DIR/server.js" ]; then
  PULSE_DIR="$SELF_DIR"
  log "using existing checkout at $PULSE_DIR"
else
  command -v git >/dev/null 2>&1 || { log "installing git…"; $SUDO apt-get update -y && $SUDO apt-get install -y git; }
  if [ -d "$PULSE_DIR/.git" ]; then
    log "updating existing install at $PULSE_DIR"
    run_as_target "git -C '$PULSE_DIR' fetch --depth 1 origin '$PULSE_BRANCH' && git -C '$PULSE_DIR' checkout '$PULSE_BRANCH' && git -C '$PULSE_DIR' reset --hard 'origin/$PULSE_BRANCH'"
  else
    log "cloning $PULSE_REPO ($PULSE_BRANCH) -> $PULSE_DIR"
    run_as_target "git clone --depth 1 --branch '$PULSE_BRANCH' '$PULSE_REPO' '$PULSE_DIR'"
  fi
fi
[ -f "$PULSE_DIR/server.js" ] || die "server.js not found in $PULSE_DIR"

# --- 2. ensure Node >= 18 ----------------------------------------------------
node_ok=0
if command -v node >/dev/null 2>&1; then
  major="$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)"
  [ "${major:-0}" -ge 18 ] && { node_ok=1; log "found Node $(node -v)"; }
fi
if [ "$node_ok" -ne 1 ]; then
  [ "$HAVE_ROOT" -eq 1 ] || die "Node >= 18 not found and no root/sudo to install it. Install Node 18+ and re-run."
  log "installing Node.js 20 LTS via NodeSource (needs root)…"
  command -v curl >/dev/null 2>&1 || { $SUDO apt-get update -y && $SUDO apt-get install -y curl; }
  curl -fsSL https://deb.nodesource.com/setup_20.x | $SUDO -E bash -
  $SUDO apt-get install -y nodejs
  log "installed Node $(node -v)"
fi
NODE_BIN="$(command -v node)"

# make sure the target user owns the checkout (so its own service + future pulls work)
if [ "$HAVE_ROOT" -eq 1 ] && [ "$(id -un)" != "$TARGET_USER" ] && [ -d "$PULSE_DIR" ]; then
  $SUDO chown -R "$TARGET_USER":"$TARGET_USER" "$PULSE_DIR" 2>/dev/null || true
fi

CLAUDE_DIR_VAL="${CLAUDE_DIR:-$TARGET_HOME/.claude}"

# --- 3. install a service ----------------------------------------------------
INSTALLED=""
sysd_ok(){ command -v systemctl >/dev/null 2>&1 && [ -d /run/systemd/system ]; }

# System service — most robust; survives reboot; runs as TARGET_USER.
if [ -z "$INSTALLED" ] && [ "$HAVE_ROOT" -eq 1 ] && sysd_ok; then
  log "installing systemd service (runs as '$TARGET_USER')…"
  UNIT=/etc/systemd/system/pulse.service
  $SUDO tee "$UNIT" >/dev/null <<EOF
[Unit]
Description=Pulse — Claude Code usage dashboard
After=network.target

[Service]
Type=simple
User=$TARGET_USER
WorkingDirectory=$PULSE_DIR
Environment=CLAUDE_DIR=$CLAUDE_DIR_VAL
ExecStart=$NODE_BIN $PULSE_DIR/server.js --port $PULSE_PORT --host $PULSE_HOST
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
EOF
  if $SUDO systemctl daemon-reload && $SUDO systemctl enable --now pulse.service; then
    INSTALLED="system"
  else
    warn "system service didn't start — falling back."
    $SUDO rm -f "$UNIT" 2>/dev/null || true
  fi
fi

# User service — no root needed; lingers across logout/reboot.
if [ -z "$INSTALLED" ] && command -v systemctl >/dev/null 2>&1 && systemctl --user show-environment >/dev/null 2>&1; then
  log "installing systemd --user service…"
  UDIR="$HOME/.config/systemd/user"; mkdir -p "$UDIR"
  cat > "$UDIR/pulse.service" <<EOF
[Unit]
Description=Pulse — Claude Code usage dashboard
After=network.target

[Service]
Type=simple
WorkingDirectory=$PULSE_DIR
Environment=CLAUDE_DIR=$CLAUDE_DIR_VAL
ExecStart=$NODE_BIN $PULSE_DIR/server.js --port $PULSE_PORT --host $PULSE_HOST
Restart=always
RestartSec=3

[Install]
WantedBy=default.target
EOF
  loginctl enable-linger "$(id -un)" >/dev/null 2>&1 || true
  if systemctl --user daemon-reload && systemctl --user enable --now pulse.service; then
    INSTALLED="user"
  else
    warn "user service didn't start — falling back."
  fi
fi

# Fallback: nohup (does not survive reboot).
if [ -z "$INSTALLED" ]; then
  warn "systemd unavailable — starting with nohup (will NOT restart on reboot)."
  run_as_target "cd '$PULSE_DIR' && CLAUDE_DIR='$CLAUDE_DIR_VAL' nohup '$NODE_BIN' server.js --port '$PULSE_PORT' --host '$PULSE_HOST' > '$PULSE_DIR/pulse.log' 2>&1 &"
  INSTALLED="nohup"
fi

# --- 4. verify + print how to reach it --------------------------------------
sleep 2
health=""
if command -v curl >/dev/null 2>&1; then
  health="$(curl -fsS "http://127.0.0.1:$PULSE_PORT/api/health" 2>/dev/null || true)"
fi

echo
if printf '%s' "$health" | grep -q '"ok":true'; then
  log "Pulse is running ✓  (health: $health)"
else
  warn "couldn't confirm health yet — it may still be starting. Check the logs (below)."
fi

echo
log "Installed at:  $PULSE_DIR"
log "Reading:       $CLAUDE_DIR_VAL  (read-only)"
case "$INSTALLED" in
  system) log "Manage:        sudo systemctl {status|restart|stop} pulse   ·   logs: journalctl -u pulse -f";;
  user)   log "Manage:        systemctl --user {status|restart|stop} pulse   ·   logs: journalctl --user -u pulse -f";;
  nohup)  log "Manage:        kill it via 'pkill -f server.js'   ·   logs: tail -f $PULSE_DIR/pulse.log";;
esac

echo
if [ "$PULSE_HOST" = "127.0.0.1" ] || [ "$PULSE_HOST" = "::1" ] || [ "$PULSE_HOST" = "localhost" ]; then
  log "Pulse is bound to localhost on the VPS (safe default)."
  log "Reach it from your own machine over an SSH tunnel:"
  printf '\n    %sssh -N -L %s:localhost:%s %s@<your-vps-ip>%s\n' "$c_dim" "$PULSE_PORT" "$PULSE_PORT" "$TARGET_USER" "$c_off"
  printf '    %sthen open  http://localhost:%s  in your browser%s\n\n' "$c_dim" "$PULSE_PORT" "$c_off"
  log "To expose it directly instead (NOT recommended), re-run with PULSE_HOST=0.0.0.0"
else
  warn "Pulse is bound to $PULSE_HOST — reachable from the network."
  warn "Lock it down: a firewall allowing only your IP, or an authenticating reverse proxy."
  log  "Open:  http://<your-vps-ip>:$PULSE_PORT"
fi
echo
