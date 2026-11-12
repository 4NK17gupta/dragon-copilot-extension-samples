#!/usr/bin/env bash
#
# Downloads the Dragon Copilot extension samples and runs the Extensions Sandbox
# (macOS, Linux and WSL; Windows users can use setup-extensions-sandbox.ps1).
#
#   1. Checks for Git, Node.js (^20.19.0 or >=22.12.0) and npm 9+.
#   2. Gets the source:
#      - Run from the scripts folder of a copy of the repository you already have
#        (a clone or an extracted ZIP), it uses that copy as it is: nothing is
#        downloaded, and your branch and changes are left alone. Git isn't needed.
#      - Run from anywhere else, or with --dir, --branch or --repo, it clones the
#        branch into --dir, or updates that clone (switching to the branch if
#        needed). Updates are fast-forward only; a clone with local changes is
#        left as it is.
#   3. Installs the sandbox's dependencies with 'npm ci' (skipped when nothing changed).
#   4. Starts the sandbox with 'npm run dev' and opens http://localhost:3000.
#      Press Ctrl+C to stop it.
#
# Run the script again at any time to update to the latest commit and restart.
# See README.md next to this script for step-by-step instructions.
# Usage: bash setup-extensions-sandbox.sh [options]    (see --help)

set -euo pipefail

INSTALL_DIR="${HOME}/dragon-copilot-extension-samples"
REPO_URL="https://github.com/4NK17gupta/dragon-copilot-extension-samples.git"
BRANCH="Partner"
SOURCE_OPTION_GIVEN=0
USE_SCRIPT_REPO=0
SKIP_UPDATE=0
FORCE_INSTALL=0
SETUP_ONLY=0
NO_BROWSER=0

SANDBOX_URL="http://localhost:3000"
SANDBOX_PORTS="3000 4000"
BROWSER_PID=""

usage() {
  cat <<EOF
Usage: $0 [options]

Downloads the Dragon Copilot extension samples and runs the Extensions Sandbox.
Run from the scripts folder of a copy of the repository, without --dir, --branch
or --repo, it uses that copy as it is instead of cloning.

Options:
  --dir <path>       Folder the repository is cloned into (default: ${INSTALL_DIR})
  --repo <url>       Repository URL (default: ${REPO_URL})
  --branch <name>    Branch to use (default: ${BRANCH})
  --skip-update      Use the existing clone as it is; don't fetch the latest commits
  --force-install    Run 'npm ci' even if the dependencies look up to date
  --setup-only       Download and install only; don't start the sandbox
  --no-browser       Don't open the browser once the sandbox is ready
  -h, --help         Show this help

Example (another branch, in its own folder):
  $0 --branch AIDraft_QualityCheck_UXChanges --dir ~/dragon-samples-aidraft
EOF
}

step() { printf '\n==> %s\n' "$*"; }
info() { printf '    %s\n' "$*"; }
warn() { printf '    WARNING: %s\n' "$*" >&2; }
die() { printf '\nERROR: %s\n' "$*" >&2; exit 1; }

while [[ $# -gt 0 ]]; do
  case "$1" in
    --dir) INSTALL_DIR="${2:?--dir needs a value}"; SOURCE_OPTION_GIVEN=1; shift 2 ;;
    --dir=*) INSTALL_DIR="${1#*=}"; SOURCE_OPTION_GIVEN=1; shift ;;
    --repo) REPO_URL="${2:?--repo needs a value}"; SOURCE_OPTION_GIVEN=1; shift 2 ;;
    --repo=*) REPO_URL="${1#*=}"; SOURCE_OPTION_GIVEN=1; shift ;;
    --branch) BRANCH="${2:?--branch needs a value}"; SOURCE_OPTION_GIVEN=1; shift 2 ;;
    --branch=*) BRANCH="${1#*=}"; SOURCE_OPTION_GIVEN=1; shift ;;
    --skip-update) SKIP_UPDATE=1; shift ;;
    --force-install) FORCE_INSTALL=1; shift ;;
    --setup-only) SETUP_ONLY=1; shift ;;
    --no-browser) NO_BROWSER=1; shift ;;
    -h | --help) usage; exit 0 ;;
    *) die "Unknown option: $1 (see --help)" ;;
  esac
done

# The shell doesn't expand ~ in --dir=~/..., so do it here.
case "$INSTALL_DIR" in
  \~) INSTALL_DIR="$HOME" ;;
  \~/*) INSTALL_DIR="$HOME/${INSTALL_DIR#\~/}" ;;
esac

# Run from the scripts folder of a copy of the repository, without --dir, --branch or --repo,
# the script uses that copy as it is instead of cloning. BASH_SOURCE is empty when piped to bash.
script_path="${BASH_SOURCE[0]:-}"
if (( ! SOURCE_OPTION_GIVEN )) && [[ -n "$script_path" && -f "$script_path" ]]; then
  script_dir="$(cd "$(dirname "$script_path")" && pwd)" || script_dir=""
  repo_root="$(cd "$script_dir/../../../.." 2>/dev/null && pwd)" || repo_root=""
  if [[ -n "$script_dir" && -n "$repo_root" &&
    -f "$repo_root/radiologists/tools/extensions-sandbox/package.json" &&
    "$script_dir" -ef "$repo_root/radiologists/tools/extensions-sandbox/scripts" ]]; then
    USE_SCRIPT_REPO=1
    INSTALL_DIR="$repo_root"
  fi
fi

case "$INSTALL_DIR" in
  /* | [A-Za-z]:[\\/]*) ;;
  *) INSTALL_DIR="$PWD/$INSTALL_DIR" ;;
esac
SANDBOX_DIR="$INSTALL_DIR/radiologists/tools/extensions-sandbox"

version_of() {
  "$1" --version 2>/dev/null | head -n 1 | grep -Eo '[0-9]+\.[0-9]+\.[0-9]+' | head -n 1 || true
}

# Same range as the sandbox's "engines" field: ^20.19.0 || >=22.12.0
node_version_supported() {
  local major minor
  IFS=. read -r major minor _ <<<"$1"
  (( (major == 20 && minor >= 19) || (major == 22 && minor >= 12) || major > 22 ))
}

check_prerequisites() {
  step "Checking prerequisites"
  local problems=() git_version node_version npm_version

  git_version="$(command -v git >/dev/null 2>&1 && version_of git || true)"
  if (( USE_SCRIPT_REPO )); then
    : # Git isn't needed to use the copy the script is in.
  elif [[ -n "$git_version" ]]; then
    info "Git $git_version"
  else
    problems+=("Git isn't installed. Get it from https://git-scm.com/downloads (macOS: xcode-select --install; Debian/Ubuntu: sudo apt install git).")
  fi

  node_version="$(command -v node >/dev/null 2>&1 && version_of node || true)"
  if [[ -z "$node_version" ]]; then
    problems+=("Node.js isn't installed. Install the LTS version (22.12 or later) from https://nodejs.org, or with nvm: nvm install --lts")
  elif ! node_version_supported "$node_version"; then
    problems+=("Node.js $node_version is too old; the sandbox needs ^20.19.0 or >=22.12.0. Install the LTS version from https://nodejs.org, or with nvm: nvm install --lts")
  else
    info "Node.js $node_version"
  fi

  if [[ -n "$node_version" ]]; then
    npm_version="$(command -v npm >/dev/null 2>&1 && version_of npm || true)"
    if [[ -z "$npm_version" ]]; then
      problems+=("npm wasn't found. It's installed with Node.js; reinstall Node.js from https://nodejs.org.")
    elif (( ${npm_version%%.*} < 9 )); then
      problems+=("npm $npm_version is too old; the sandbox needs npm 9 or later. Run: npm install -g npm@latest")
    else
      info "npm $npm_version"
    fi
  fi

  if (( ${#problems[@]} > 0 )); then
    local problem
    for problem in "${problems[@]}"; do printf '    - %s\n' "$problem" >&2; done
    die "Install the missing prerequisites (open a new terminal afterwards), then run this script again."
  fi
}

# Exits 0 if something accepts connections on the port at 127.0.0.1 or ::1.
port_in_use() {
  node -e '
    const net = require("net");
    const port = Number(process.argv[1]);
    let pending = 2;
    let used = false;
    for (const host of ["127.0.0.1", "::1"]) {
      const socket = net.connect({ host, port });
      let settled = false;
      const settle = (connected) => {
        if (settled) return;
        settled = true;
        used = used || connected;
        socket.destroy();
        if (--pending === 0) process.exit(used ? 0 : 1);
      };
      socket.setTimeout(1000);
      socket.once("connect", () => settle(true));
      socket.once("timeout", () => settle(false));
      socket.once("error", () => settle(false));
    }
  ' "$1"
}

check_ports_free() {
  local port busy=""
  for port in $SANDBOX_PORTS; do
    if port_in_use "$port"; then busy="${busy:+$busy, }$port"; fi
  done
  if [[ -n "$busy" ]]; then
    die "The sandbox needs ports 3000 and 4000, but these are in use: $busy. If the sandbox is already running in another terminal, use that or stop it with Ctrl+C, then run this script again."
  fi
}

comparable_repo_url() {
  local url="$1"
  url="${url%/}"
  url="${url%.git}"
  url="${url/#git@github.com:/https://github.com/}"
  printf '%s' "$url" | tr '[:upper:]' '[:lower:]'
}

update_clone() {
  local origin current_branch changes refspecs
  local refspec="+refs/heads/$BRANCH:refs/remotes/origin/$BRANCH"
  origin="$(git -C "$INSTALL_DIR" config --get remote.origin.url || true)"
  if [[ "$(comparable_repo_url "$origin")" != "$(comparable_repo_url "$REPO_URL")" ]]; then
    die "$INSTALL_DIR is a clone of '$origin', not $REPO_URL. Use --dir to choose another folder."
  fi

  current_branch="$(git -C "$INSTALL_DIR" rev-parse --abbrev-ref HEAD)" ||
    die "Couldn't read the current branch in $INSTALL_DIR. Check the git message above."

  if (( SKIP_UPDATE )); then
    info "Using the existing clone as it is (--skip-update)."
    [[ "$current_branch" == "$BRANCH" ]] || warn "The clone is on '$current_branch', not '$BRANCH'."
    return
  fi

  changes="$(git -C "$INSTALL_DIR" status --porcelain)" || die "git status failed in $INSTALL_DIR. Check the git message above."
  if [[ -n "$changes" ]]; then
    [[ "$current_branch" == "$BRANCH" ]] ||
      die "$INSTALL_DIR has local changes on '$current_branch', so it can't switch to '$BRANCH'. Commit, stash or discard them, or use --dir to set up '$BRANCH' in another folder."
    warn "$INSTALL_DIR has local changes, so it wasn't updated. Commit, stash or discard them to get the latest version."
    return
  fi

  # Clones made by this script track a single branch; register this one so it can be tracked too.
  refspecs="$(git -C "$INSTALL_DIR" config --get-all remote.origin.fetch || true)"
  if ! grep -qxF -e "$refspec" -e '+refs/heads/*:refs/remotes/origin/*' <<<"$refspecs"; then
    git -C "$INSTALL_DIR" remote set-branches --add origin "$BRANCH" || die "Couldn't add $BRANCH to the clone."
  fi

  info "Fetching the latest $BRANCH from origin"
  git -C "$INSTALL_DIR" fetch origin "$refspec" || die "git fetch failed."

  if [[ "$current_branch" != "$BRANCH" ]]; then
    info "Switching from $current_branch to $BRANCH"
    # Create the branch before checking it out, so a failure leaves the working tree untouched.
    if ! git -C "$INSTALL_DIR" rev-parse --verify --quiet "refs/heads/$BRANCH" >/dev/null; then
      git -C "$INSTALL_DIR" branch --quiet --track "$BRANCH" "origin/$BRANCH" || die "Couldn't create the local branch $BRANCH."
    fi
    git -C "$INSTALL_DIR" checkout --quiet "$BRANCH" || die "Couldn't switch to $BRANCH."
  fi

  if ! git -C "$INSTALL_DIR" merge --ff-only --quiet "origin/$BRANCH"; then
    warn "Couldn't fast-forward to origin/$BRANCH (the clone has its own commits), so it wasn't updated."
  fi
}

print_commit_info() {
  if ! command -v git >/dev/null 2>&1 || [[ ! -e "$INSTALL_DIR/.git" ]]; then return 0; fi
  local commit head_branch
  commit="$(git -C "$INSTALL_DIR" log -1 --format='%h %s (%cr)')" || return 0
  head_branch="$(git -C "$INSTALL_DIR" rev-parse --abbrev-ref HEAD)" || return 0
  info "On $head_branch at commit $commit"
}

sync_source() {
  if (( USE_SCRIPT_REPO )); then
    step "Using the copy of the repository this script is in"
    info "$INSTALL_DIR"
    info "It's used as it is: nothing is downloaded, and your branch and changes are left alone."
    info "To have the script download and update its own copy instead, pass --dir <folder>."
    print_commit_info
    return
  fi

  step "Getting the source ($BRANCH)"
  if [[ ! -e "$INSTALL_DIR" || ( -d "$INSTALL_DIR" && -z "$(ls -A "$INSTALL_DIR")" ) ]]; then
    info "Cloning $REPO_URL into $INSTALL_DIR"
    git clone --branch "$BRANCH" --single-branch --filter=blob:none -c core.longpaths=true "$REPO_URL" "$INSTALL_DIR" ||
      die "git clone failed."
  elif [[ ! -e "$INSTALL_DIR/.git" ]]; then
    die "$INSTALL_DIR already exists and isn't a git clone. Use --dir to choose another folder, or delete it."
  else
    update_clone
  fi

  [[ -f "$SANDBOX_DIR/package.json" ]] ||
    die "The Extensions Sandbox wasn't found at $SANDBOX_DIR. Check that '$BRANCH' is the right branch."
  print_commit_info
}

sha256_of() {
  node -e 'process.stdout.write(require("crypto").createHash("sha256").update(require("fs").readFileSync(process.argv[1])).digest("hex"))' "$1"
}

install_dependencies() {
  step "Installing the sandbox dependencies"
  local stamp_file="$SANDBOX_DIR/node_modules/.extensions-sandbox-setup"
  local lock_hash node_version expected_stamp current_stamp=""
  lock_hash="$(sha256_of "$SANDBOX_DIR/package-lock.json")" || die "Couldn't read $SANDBOX_DIR/package-lock.json."
  node_version="$(node --version)"
  # Reinstall whenever the lock file or the Node.js version changes (native bindings are per version).
  expected_stamp="$lock_hash $node_version"
  if [[ -f "$stamp_file" ]]; then current_stamp="$(tr -d '\r\n' <"$stamp_file")"; fi

  if (( ! FORCE_INSTALL )) && [[ "$current_stamp" == "$expected_stamp" ]]; then
    info "Dependencies are up to date."
    return
  fi

  (cd "$SANDBOX_DIR" && npm ci --no-audit --no-fund) ||
    die "npm ci failed. Check your network or proxy settings, then run this script again."
  printf '%s' "$expected_stamp" >"$stamp_file"
}

open_browser() {
  case "$(uname -s)" in
    Darwin) open "$1" ;;
    MINGW* | MSYS* | CYGWIN*) start "" "$1" ;;
    *)
      if command -v wslview >/dev/null 2>&1; then
        wslview "$1"
      elif grep -qi microsoft /proc/version 2>/dev/null && command -v cmd.exe >/dev/null 2>&1; then
        cmd.exe /c start "" "$1" >/dev/null 2>&1
      elif command -v xdg-open >/dev/null 2>&1; then
        xdg-open "$1" >/dev/null 2>&1
      else
        info "Open $1 in your browser."
      fi
      ;;
  esac
}

open_browser_when_ready() {
  local attempt
  for ((attempt = 0; attempt < 90; attempt++)); do
    sleep 2
    if node -e 'fetch(process.argv[1]).then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))' "$SANDBOX_URL" 2>/dev/null; then
      open_browser "$SANDBOX_URL" || true
      return
    fi
  done
}

cleanup() {
  if [[ -n "$BROWSER_PID" ]]; then kill "$BROWSER_PID" 2>/dev/null || true; fi
}

start_sandbox() {
  step "Starting the Extensions Sandbox"
  info "Sandbox UI:  $SANDBOX_URL"
  info "Press Ctrl+C to stop it."

  trap cleanup EXIT
  trap 'exit 130' INT TERM
  if (( ! NO_BROWSER )); then
    open_browser_when_ready &
    BROWSER_PID=$!
  fi

  local status=0
  (cd "$SANDBOX_DIR" && npm run dev) || status=$?
  if (( status != 0 )); then
    warn "The sandbox stopped with exit code $status. Check the output above."
  fi
}

check_prerequisites
if (( ! SETUP_ONLY )); then check_ports_free; fi
sync_source
install_dependencies

if (( SETUP_ONLY )); then
  step "Setup complete"
  info "Start the sandbox later by running this script again, or with:"
  info "  cd \"$SANDBOX_DIR\""
  info "  npm run dev"
  info "Then open $SANDBOX_URL."
  exit 0
fi

start_sandbox
