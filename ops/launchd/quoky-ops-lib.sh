# shellcheck shell=bash
# Shared helpers for ops/launchd/quoky-launch.sh and ops/launchd/quokyctl.sh (ADR-0102, SUB-1).
# Sourced, never executed. Written for macOS /bin/bash 3.2: no associative arrays, no mapfile.
# Nothing here reads, prints or logs the content of the env file; only its path, type, mode and owner are checked.

# Process exit code for "retrying will not help until the owner changes something" (sysexits EX_CONFIG). The app
# uses the same value (apps/quoky/src/ops/exit-codes.ts, QuokyExitCode.CONFIGURATION).
QUOKY_EXIT_CONFIGURATION=78

# Default launchd label (one service per user).
QUOKY_DEFAULT_LABEL=com.quoky.personal

# Prints the OS name; macOS is "Darwin".
quoky_os_name() {
  uname -s 2>/dev/null
}

# Succeeds on macOS only.
quoky_is_darwin() {
  [ "$(quoky_os_name)" = "Darwin" ]
}

# Succeeds when $1 is an absolute path with no newline or carriage return.
quoky_is_safe_abs_path() {
  case "$1" in
    /*) ;;
    *) return 1 ;;
  esac
  case "$1" in
    *$'\n'* | *$'\r'*) return 1 ;;
  esac
  return 0
}

# Prints "<permission-octal> <owner-uid>" for $1 without following a symlink (BSD stat first, GNU stat fallback).
quoky_mode_and_owner() {
  stat -f '%Lp %u' "$1" 2>/dev/null || stat -c '%a %u' "$1" 2>/dev/null
}

# Checks the env file is a regular, non-symlink file owned by the current user with no group/other permission bits
# (600 or 400). Prints a reason code and returns 1 otherwise: ENV_FILE_NOT_ABSOLUTE, ENV_FILE_MISSING,
# ENV_FILE_INSECURE.
quoky_check_private_env_file() {
  local file=$1 info perm owner
  if ! quoky_is_safe_abs_path "$file"; then
    echo "ENV_FILE_NOT_ABSOLUTE"
    return 1
  fi
  if [ -L "$file" ]; then
    echo "ENV_FILE_INSECURE"
    return 1
  fi
  if [ ! -f "$file" ]; then
    echo "ENV_FILE_MISSING"
    return 1
  fi
  info=$(quoky_mode_and_owner "$file") || {
    echo "ENV_FILE_MISSING"
    return 1
  }
  perm=${info%% *}
  owner=${info##* }
  case "$perm" in
    400 | 500 | 600 | 700) ;;
    *)
      echo "ENV_FILE_INSECURE"
      return 1
      ;;
  esac
  if [ "$owner" != "$(id -u)" ]; then
    echo "ENV_FILE_INSECURE"
    return 1
  fi
  return 0
}

# Remediation text for a reason code from quoky_check_private_env_file.
quoky_env_file_hint() {
  case "$1" in
    ENV_FILE_NOT_ABSOLUTE) echo "the env file path must be absolute" ;;
    ENV_FILE_MISSING) echo "the env file does not exist or is not a regular file: create the host .env.local first" ;;
    ENV_FILE_INSECURE) echo "the env file must be a regular file you own with mode 600: run 'chmod 600 <repo>/.env.local'" ;;
    *) echo "unknown env file problem" ;;
  esac
}
