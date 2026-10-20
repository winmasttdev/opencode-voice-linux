#!/usr/bin/env bash
#
# opencode-voice-linux setup script
#
# Installs the Linux port of the OpenCode voice plugin (ElevenLabs v3 TTS):
#   - clones/updates the repository (or registers an existing checkout)
#   - installs the (dev) dependencies
#   - prompts for your ElevenLabs API key
#   - registers the plugin in the active OpenCode config (opencode.jsonc)
#
# Usage:
#   ./setup.sh                       # full install
#   ./setup.sh --register-only       # only register the plugin path
#   ./setup.sh --dir ~/dev/my-voice  # use a custom checkout
#
# The OpenCode config is JSONC (comments + trailing commas). It is never
# round-tripped through a JSON parser - the plugin entry is inserted with
# surgical text edits so comments and formatting survive.

set -euo pipefail

REPO_URL="https://github.com/winmasttdev/opencode-voice-linux.git"
DEFAULT_DIR_NAME="opencode-voice-linux"

INSTALL_DIR="${OPENCODE_VOICE_DIR:-}"
CONFIG_FILE=""
PLUGIN_URL=""
DO_CLONE=1
DO_KEY=1
DO_INSTALL=1

usage() {
  cat <<'EOF'
opencode-voice-linux setup script

Options:
  --dir <path>        Plugin checkout directory
                      (default: $OPENCODE_VOICE_DIR or ~/dev/opencode-voice-linux)
  --config <path>     OpenCode config file to edit
                      (default: ~/.config/opencode/opencode.jsonc, falling back
                       to the legacy opencode.json)
  --plugin-url <url>  Plugin URL to register (default: file://<dir>)
  --no-clone          Do not clone/update the repository
  --no-install        Do not install dependencies
  --no-key            Do not prompt for the ElevenLabs API key
  --register-only     Only register the plugin (implies --no-clone --no-install
                      --no-key)
  -h, --help          Show this help
EOF
}

while [ $# -gt 0 ]; do
  case "$1" in
    --dir)
      INSTALL_DIR="${2:?--dir needs a path}"
      shift 2
      ;;
    --config)
      CONFIG_FILE="${2:?--config needs a path}"
      shift 2
      ;;
    --plugin-url)
      PLUGIN_URL="${2:?--plugin-url needs a url}"
      shift 2
      ;;
    --no-clone)
      DO_CLONE=0
      shift
      ;;
    --no-install)
      DO_INSTALL=0
      shift
      ;;
    --no-key)
      DO_KEY=0
      shift
      ;;
    --register-only)
      DO_CLONE=0
      DO_INSTALL=0
      DO_KEY=0
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown option: $1" >&2
      usage >&2
      exit 1
      ;;
  esac
done

# >>> BEGIN CONFIG HELPERS
# OpenCode's global config is JSONC (comments and trailing commas allowed).
# Round-tripping it through a JSON parser would reject comments and rewrite
# the whole file, so the helpers below make targeted text edits instead.
#
# Behavior mirrors OpenCode itself: opencode.jsonc is preferred over the
# legacy opencode.json, and a missing config file is created as
# opencode.jsonc. Plugin entries use the V2 "plugins" array (the V1 "plugin"
# field is used as a fallback when it is the only key present).

IFS= read -r -d '' AWK_JSONC <<'AWK_EOF' || true
function is_space(c) {
  return (c == " " || c == "\t" || c == "\r" || c == "\n")
}

# Build a mask marking which characters are code (1) vs inside a comment or
# a JSON value string (0). Quoted keys keep mask 1 so key lookup can use it.
# `mask` is a global array on purpose - the helpers below read it.
function build_mask(text,   i, n, c, d, start, end, j, k, iskey) {
  n = length(text)
  for (i = 1; i <= n; i++) mask[i] = 1
  i = 1
  while (i <= n) {
    c = substr(text, i, 1)
    d = (i < n) ? substr(text, i + 1, 1) : ""
    if (c == "/" && d == "/") {
      while (i <= n && substr(text, i, 1) != "\n") { mask[i] = 0; i++ }
      continue
    }
    if (c == "/" && d == "*") {
      mask[i] = 0
      if (i + 1 <= n) mask[i + 1] = 0
      i += 2
      while (i <= n) {
        if (substr(text, i, 1) == "*" && (i < n) && substr(text, i + 1, 1) == "/") {
          mask[i] = 0
          mask[i + 1] = 0
          i += 2
          break
        }
        mask[i] = 0
        i++
      }
      continue
    }
    if (c == "\"") {
      start = i
      i++
      while (i <= n) {
        c = substr(text, i, 1)
        if (c == "\\") {
          mask[i] = 0
          if (i < n) mask[i + 1] = 0
          i += 2
          continue
        }
        if (c == "\"") break
        i++
      }
      end = i
      # A string followed by a colon is a key (stays code); otherwise it is
      # a value string and gets masked.
      j = end + 1
      while (j <= n && is_space(substr(text, j, 1))) j++
      iskey = (j <= n && substr(text, j, 1) == ":")
      if (!iskey) for (k = start; k <= end; k++) mask[k] = 0
      i = end + 1
      continue
    }
    i++
  }
}

# Object/array nesting depth at Index (1-based), ignoring strings/comments.
# Root level members of the config object are at braces=1, brackets=0.
function depth_at(text, idx,   i, n, c, d, braces, brackets, instr, inline, inblock) {
  braces = 0; brackets = 0; instr = 0; inline = 0; inblock = 0
  n = length(text)
  for (i = 1; i < idx; i++) {
    c = substr(text, i, 1)
    d = (i < n) ? substr(text, i + 1, 1) : ""
    if (instr) {
      if (c == "\\") { i++; continue }
      if (c == "\"") instr = 0
      continue
    }
    if (inline) { if (c == "\n") inline = 0; continue }
    if (inblock) { if (c == "*" && d == "/") { inblock = 0; i++; continue } continue }
    if (c == "\"") { instr = 1; continue }
    if (c == "/" && d == "/") { inline = 1; i++; continue }
    if (c == "/" && d == "*") { inblock = 1; i++; continue }
    if (c == "{") braces++
    else if (c == "}") braces--
    else if (c == "[") brackets++
    else if (c == "]") brackets--
  }
  return braces SUBSEP brackets
}

# Find the 1-based index of a top-level property name: "Name" followed by ':'.
# Returns 0 when absent, inside comments/strings, or nested below the root.
function find_prop(text, mask, name,   pat, s, p, j, n, dd) {
  pat = "\"" name "\""
  n = length(text)
  s = 1
  while (s <= n) {
    p = index(substr(text, s), pat)
    if (p == 0) break
    p = s + p - 1
    j = p + length(pat)
    while (j <= n && is_space(substr(text, j, 1))) j++
    if (j <= n && substr(text, j, 1) == ":" && mask[p] == 1) {
      split(depth_at(text, p), dd, SUBSEP)
      if (dd[1] == 1 && dd[2] == 0) return p
    }
    s = p + 1
  }
  return 0
}

# Find the matching closing delimiter for the opener at OpenIndex.
function find_matching(text, openidx, opench, closech,   i, n, c, d, depth, instr, inline, inblock) {
  depth = 0; instr = 0; inline = 0; inblock = 0
  n = length(text)
  for (i = openidx; i <= n; i++) {
    c = substr(text, i, 1)
    d = (i < n) ? substr(text, i + 1, 1) : ""
    if (instr) {
      if (c == "\\") { i++; continue }
      if (c == "\"") instr = 0
      continue
    }
    if (inline) { if (c == "\n") inline = 0; continue }
    if (inblock) { if (c == "*" && d == "/") { inblock = 0; i++; continue } continue }
    if (c == "\"") { instr = 1; continue }
    if (c == "/" && d == "/") { inline = 1; i++; continue }
    if (c == "/" && d == "*") { inblock = 1; i++; continue }
    if (c == opench) depth++
    else if (c == closech) {
      depth--
      if (depth == 0) return i
    }
  }
  return 0
}

# Locate the [...] span of the given property. Returns 0 when the property
# is absent or its value is not an array.
function find_array_span(text, mask, name,   keyidx, i, n, openidx, closeidx) {
  keyidx = find_prop(text, mask, name)
  if (keyidx == 0) return 0
  n = length(text)
  i = index(substr(text, keyidx), ":") + keyidx
  while (i <= n && !(mask[i] == 1 && substr(text, i, 1) == "[")) i++
  if (i > n) return 0
  openidx = i
  closeidx = find_matching(text, openidx, "[", "]")
  if (closeidx == 0) return 0
  return openidx SUBSEP closeidx
}

# Inspect array contents: whether it has values, whether a comma follows the
# last one, where the last value ends and where the first value starts.
function array_info(text, openidx, closeidx,   hasval, comma, lastend, firststart, i, n, c, d, nest, invalue, instr, inline, inblock) {
  hasval = 0; comma = 0; lastend = -1; firststart = -1
  nest = 0; invalue = 0; instr = 0; inline = 0; inblock = 0
  n = length(text)
  for (i = openidx + 1; i < closeidx; i++) {
    c = substr(text, i, 1)
    d = (i < n) ? substr(text, i + 1, 1) : ""
    if (instr) {
      if (c == "\\") { i++; continue }
      if (c == "\"") {
        instr = 0
        if (nest == 0) { invalue = 0; hasval = 1; comma = 0; lastend = i + 1 }
      }
      continue
    }
    if (inline) { if (c == "\n") inline = 0; continue }
    if (inblock) { if (c == "*" && d == "/") { inblock = 0; i++; continue } continue }
    if (c == "\"") {
      if (nest == 0 && !invalue) { invalue = 1; if (firststart < 0) firststart = i }
      instr = 1
      continue
    }
    if (c == "/" && d == "/") { inline = 1; i++; continue }
    if (c == "/" && d == "*") { inblock = 1; i++; continue }
    if (c == "{" || c == "[") {
      if (nest == 0 && !invalue) { invalue = 1; if (firststart < 0) firststart = i }
      nest++
      continue
    }
    if (c == "}" || c == "]") {
      nest--
      if (nest <= 0) { nest = 0; invalue = 0; hasval = 1; comma = 0; lastend = i + 1 }
      continue
    }
    if (c == "," && nest == 0 && !invalue && hasval) { comma = 1; continue }
  }
  return hasval SUBSEP comma SUBSEP lastend SUBSEP firststart
}

# 1-based index of the start of the line containing Index.
function line_start(text, idx,   i) {
  for (i = idx; i > 0; i--) {
    if (substr(text, i, 1) == "\n") return i + 1
  }
  return 1
}

# Leading whitespace of the line containing Index.
function line_indent(text, idx,   start, i, n, c) {
  start = line_start(text, idx)
  i = start
  n = length(text)
  while (i <= n) {
    c = substr(text, i, 1)
    if (c != " " && c != "\t") break
    i++
  }
  return substr(text, start, i - start)
}

function newline_of(text) {
  return (index(text, "\r\n") > 0) ? "\r\n" : "\n"
}

# Insert an entry string into the array spanning openidx..closeidx, preserving
# comments, formatting and existing entries.
function add_entry_to_array(text, openidx, closeidx, entry,   nl, ai, hasval, comma, lastend, firststart, lineopen, lineclose, result, commaPos, closeIndent, entryIndent, insertAt, sep) {
  nl = newline_of(text)
  split(array_info(text, openidx, closeidx), ai, SUBSEP)
  hasval = ai[1]; comma = ai[2]; lastend = ai[3]; firststart = ai[4]

  lineopen = line_start(text, openidx)
  lineclose = line_start(text, closeidx)

  if (lineopen == lineclose) {
    # Array opens and closes on one line: single insert.
    sep = ""
    if (hasval) sep = comma ? " " : ", "
    return substr(text, 1, closeidx - 1) sep entry substr(text, closeidx)
  }

  # Multi-line: comma first (so later indexes stay valid), then the entry
  # line in front of the closing bracket.
  result = text
  commaPos = 0
  if (hasval && !comma) {
    commaPos = lastend
    result = substr(result, 1, commaPos - 1) "," substr(result, commaPos)
  }

  closeIndent = line_indent(text, closeidx)
  if (hasval) entryIndent = line_indent(text, firststart)
  else entryIndent = closeIndent "  "

  insertAt = lineclose
  if (commaPos > 0 && commaPos < lineclose) insertAt = lineclose + 1
  return substr(result, 1, insertAt - 1) entryIndent entry nl substr(result, insertAt)
}

# Add a brand-new top-level array property to the root object.
# Returns "" when the root object cannot be identified.
function add_root_property(text, mask, name, entry,   i, n, openidx, closeidx, nl, between, stripped, rootempty, memberindent, scan, c, detected, block, entryindent) {
  n = length(text)
  i = 1
  while (i <= n && !(mask[i] == 1 && substr(text, i, 1) == "{")) i++
  if (i > n) return ""
  openidx = i
  closeidx = find_matching(text, openidx, "{", "}")
  if (closeidx == 0) return ""

  nl = newline_of(text)
  between = substr(text, openidx + 1, closeidx - openidx - 1)
  stripped = between
  gsub(/\/\/[^\n]*/, "", stripped)
  gsub(/\/\*[^*]*\*+([^\/*][^*]*\*+)*\//, "", stripped)
  gsub(/[ \t\r\n]/, "", stripped)
  rootempty = (length(stripped) == 0)

  memberindent = "  "
  if (!rootempty) {
    # Reuse the indentation of the first existing member.
    scan = openidx + 1
    while (scan < closeidx && is_space(substr(text, scan, 1))) scan++
    if (scan < closeidx) {
      detected = line_indent(text, scan)
      if (length(detected) > 0) memberindent = detected
    }
  }
  entryindent = memberindent "  "

  block = nl memberindent "\"" name "\": [" nl entryindent entry nl memberindent "]"
  if (!rootempty) block = block ","

  return substr(text, 1, openidx) block substr(text, openidx + 1)
}

BEGIN {
  ENTRY = ENVIRON["CFG_ENTRY"]
  PLUGIN_URL = ENVIRON["CFG_URL"]
  TRAILING_NEWLINE = ENVIRON["CFG_TRAILING_NEWLINE"] + 0
  STATUS = "manual"
  DETAIL = ""
  OUT = ""
  n = 0
}

{ lines[++n] = $0 }

END {
  text = ""
  for (i = 1; i <= n; i++) text = text lines[i] "\n"
  if (!TRAILING_NEWLINE && n > 0) text = substr(text, 1, length(text) - 1)

  if (text == "") {
    printf "STATUS:manual\nDETAIL:empty config\n" > "/dev/stderr"
    exit 0
  }

  # Already registered (same path)?
  if (index(text, PLUGIN_URL) > 0) {
    printf "STATUS:exists\nDETAIL:%s\n", PLUGIN_URL > "/dev/stderr"
    exit 0
  }

  # Registered under a different opencode-voice path? Do not add a second
  # entry - that would load the same plugin twice.
  if (match(text, /"[^"]*opencode-voice[^"]*"/)) {
    printf "STATUS:exists-elsewhere\nDETAIL:%s\n", substr(text, RSTART + 1, RLENGTH - 2) > "/dev/stderr"
    exit 0
  }

  build_mask(text)

  # Preferred: the native V2 "plugins" array, then the legacy V1 "plugin".
  split("plugins plugin", names, " ")
  for (ni = 1; ni <= 2; ni++) {
    name = names[ni]
    span = find_array_span(text, mask, name)
    if (span != 0) {
      split(span, sp, SUBSEP)
      OUT = add_entry_to_array(text, sp[1], sp[2], ENTRY)
      printf "STATUS:added\nDETAIL:%s\n", name > "/dev/stderr"
      printf "%s", OUT
      exit 0
    }
    if (find_prop(text, mask, name) > 0) {
      # Key exists but is not an array - cannot edit safely.
      printf "STATUS:manual\nDETAIL:%s is present but is not an array\n", name > "/dev/stderr"
      exit 0
    }
  }

  # No plugins array yet - add the property to the root object.
  OUT = add_root_property(text, mask, "plugins", ENTRY)
  if (OUT == "") {
    printf "STATUS:manual\nDETAIL:root object not found\n" > "/dev/stderr"
    exit 0
  }
  printf "STATUS:added\nDETAIL:plugins\n" > "/dev/stderr"
  printf "%s", OUT
}
AWK_EOF

# Render the updated config for a config file.
# The updated config goes to stdout, the status/detail lines to stderr.
config_render() {
  local file="$1"
  local entry="$2"
  local url="$3"
  local prog
  prog="$(mktemp)"
  printf '%s\n' "$AWK_JSONC" > "$prog"

  local trailing=1
  if [ -s "$file" ]; then
    if [ "$(tail -c 1 "$file" | od -An -c | tr -d ' \n')" != '\n' ]; then
      trailing=0
    fi
  fi

  CFG_ENTRY="$entry" CFG_URL="$url" CFG_TRAILING_NEWLINE="$trailing" \
    awk -f "$prog" "$file"
  local rc=$?
  rm -f "$prog"
  return $rc
}

# Register the plugin in an OpenCode config file.
# Prints two lines on stdout:
#   1. one of: created | added | exists | exists-elsewhere | manual
#   2. a detail string (array name, path or reason)
config_add_plugin() {
  local file="$1"
  local url="$2"
  local dir
  dir="$(dirname "$file")"
  mkdir -p "$dir"

  # JSON-escape the url so it can live inside a JSON string.
  local escaped="$url"
  escaped="${escaped//\\/\\\\}"
  escaped="${escaped//\"/\\\"}"
  local entry="\"$escaped\""

  # Missing, empty or whitespace-only config: start fresh as a complete
  # opencode.jsonc (same as what OpenCode itself would create).
  if [ ! -s "$file" ] || [ -z "$(tr -d '[:space:]' < "$file")" ]; then
    printf '{\n  "$schema": "https://opencode.ai/config.json",\n  "plugins": [\n    %s\n  ]\n}\n' \
      "$entry" > "$file"
    printf 'created\n%s\n' "$file"
    return 0
  fi

  local out err status detail
  out="$(mktemp)"
  err="$(mktemp)"
  config_render "$file" "$entry" "$url" > "$out" 2> "$err" || true

  status="$(sed -n 's/^STATUS://p' "$err" | head -n 1)"
  detail="$(sed -n 's/^DETAIL://p' "$err" | head -n 1)"

  if [ "$status" = "added" ]; then
    # Preserve the original file mode/ownership by writing in place.
    cat "$out" > "$file"
  fi

  rm -f "$out" "$err"

  case "$status" in
    added|exists|exists-elsewhere)
      printf '%s\n%s\n' "$status" "$detail"
      ;;
    *)
      printf 'manual\n%s\n' "$detail"
      ;;
  esac
}
# <<< END CONFIG HELPERS

# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

if [ -z "$INSTALL_DIR" ]; then
  INSTALL_DIR="$HOME/dev/$DEFAULT_DIR_NAME"
fi
# Strip trailing slashes so the registered URL is stable.
while [ "${INSTALL_DIR%/}" != "$INSTALL_DIR" ] && [ "${INSTALL_DIR}" != "/" ]; do
  INSTALL_DIR="${INSTALL_DIR%/}"
done

if [ -z "$PLUGIN_URL" ]; then
  PLUGIN_URL="file://$INSTALL_DIR"
fi

SECRETS_DIR="$HOME/.config/opencode/secrets"
KEY_PATH="$SECRETS_DIR/elevenlabs-key"

echo ""
echo "==========================================================="
echo "         opencode-voice-linux Setup Script"
echo "     ElevenLabs v3 TTS Plugin for OpenCode (Linux)"
echo "==========================================================="
echo ""

# Step 1: clone or update the repository
if [ "$DO_CLONE" = "1" ]; then
  if ! command -v git >/dev/null 2>&1; then
    echo "  Error: git is not installed" >&2
    exit 1
  fi
  echo "  Step 1: Installing plugin..."
  if [ -d "$INSTALL_DIR/.git" ]; then
    echo "   Directory exists, pulling latest..."
    git -C "$INSTALL_DIR" pull --quiet
  else
    echo "   Cloning repository..."
    mkdir -p "$(dirname "$INSTALL_DIR")"
    git clone --quiet "$REPO_URL" "$INSTALL_DIR"
  fi
else
  echo "  Step 1: Skipping clone (using $INSTALL_DIR)"
fi

# Step 2: install dependencies (there are no runtime dependencies, this is
# only needed for the dev workflow: typecheck + tests)
if [ "$DO_INSTALL" = "1" ]; then
  echo "  Step 2: Installing dependencies..."
  if command -v bun >/dev/null 2>&1; then
    (cd "$INSTALL_DIR" && bun install --silent) || true
  elif command -v npm >/dev/null 2>&1; then
    (cd "$INSTALL_DIR" && npm install --no-audit --no-fund) || true
  else
    echo "   No bun/npm found - skipping (the plugin has no runtime dependencies)"
  fi
else
  echo "  Step 2: Skipping dependency install"
fi

# Step 3: ElevenLabs API key
if [ "$DO_KEY" = "1" ]; then
  echo ""
  echo "  Step 3: ElevenLabs API Key"
  echo "   Get your API key from: https://elevenlabs.io/app/settings/api-keys"
  echo ""

  skip_key=0
  if [ -f "$KEY_PATH" ]; then
    existing_key="$(tr -d '\r\n' < "$KEY_PATH")"
    if [ -n "$existing_key" ] && [ "$existing_key" != "YOUR_ELEVENLABS_API_KEY_HERE" ]; then
      echo "   Found existing API key."
      read -r -p "   Keep existing key? [Y/n]: " keep_key
      if [ -z "$keep_key" ] || printf '%s' "$keep_key" | grep -qi '^y'; then
        echo "   Keeping existing key"
        skip_key=1
      fi
    fi
  fi

  if [ "$skip_key" = "0" ]; then
    read -r -s -p "   Enter your ElevenLabs API key: " api_key
    echo ""
    if [ -z "$api_key" ]; then
      echo "   No key provided. You can add it later to:"
      echo "      $KEY_PATH"
    else
      mkdir -p "$SECRETS_DIR"
      printf '%s' "$api_key" > "$KEY_PATH"
      chmod 600 "$KEY_PATH"
      echo "   API key saved"
    fi
  fi
else
  echo "  Step 3: Skipping API key setup"
fi

# The secrets directory may not exist on a fresh OpenCode install.
mkdir -p "$SECRETS_DIR"

# Step 4: register the plugin in the active OpenCode config
echo ""
echo "  Step 4: Configuring OpenCode..."

if [ -z "$CONFIG_FILE" ]; then
  config_dir="$HOME/.config/opencode"
  jsonc_file="$config_dir/opencode.jsonc"
  json_file="$config_dir/opencode.json"
  # OpenCode prefers opencode.jsonc over the legacy opencode.json and creates
  # opencode.jsonc when no config exists yet.
  if [ -f "$jsonc_file" ]; then
    CONFIG_FILE="$jsonc_file"
  elif [ -f "$json_file" ]; then
    CONFIG_FILE="$json_file"
  else
    CONFIG_FILE="$jsonc_file"
  fi
fi

result="$(config_add_plugin "$CONFIG_FILE" "$PLUGIN_URL")"
status="$(printf '%s\n' "$result" | sed -n '1p')"
detail="$(printf '%s\n' "$result" | sed -n '2p')"

echo "   Config file: $CONFIG_FILE"

case "$status" in
  created)
    echo "   Plugin registered in new config"
    ;;
  added)
    echo "   Plugin added to config (array: $detail)"
    ;;
  exists)
    echo "   Plugin already registered in config"
    ;;
  exists-elsewhere)
    echo "   Plugin already registered at a different path:"
    echo "      $detail"
    echo "   Remove that entry if this install replaced it."
    ;;
  *)
    echo "   Could not update config automatically." >&2
    [ -n "$detail" ] && echo "   ($detail)" >&2
    echo "   Please manually add this to the \"plugins\" array in" >&2
    echo "      $CONFIG_FILE" >&2
    echo "      \"$PLUGIN_URL\"" >&2
    ;;
esac

# Done!
echo ""
echo "==========================================================="
echo "                    Setup Complete!"
echo "==========================================================="
echo ""
echo "  Plugin installed to: $INSTALL_DIR"
echo "  API key stored in:   $KEY_PATH"
echo "  Config file:         $CONFIG_FILE"
echo ""
echo "  Restart OpenCode to load the 'speak' tool!"
echo ""
echo "   Example usage:"
echo '   speak("[excited] Hello! [laughs] This is amazing!")'
echo ""
