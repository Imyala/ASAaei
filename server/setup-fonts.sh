#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# ASAaei — install the fonts the converter needs
# ---------------------------------------------------------------------------
# LibreOffice reproduces a Word document exactly when it has the document's
# fonts. When one is missing it substitutes something else, glyph widths change
# and the text re-wraps — which is what "the PDF doesn't match Word" almost
# always turns out to be.
#
# This installs, in order of how much it helps:
#   1. the metric-compatible clones (Carlito for Calibri, Liberation for Arial /
#      Times / Courier, Caladea for Cambria) — same widths, identical wrapping;
#   2. good stand-ins for the fonts with no free clone (Verdana, Tahoma, Segoe
#      UI), plus the fontconfig rules that actually select them;
#   3. optionally the genuine Microsoft fonts, if you are licensed for them.
#
#   ./server/setup-fonts.sh                     # steps 1 and 2
#   ./server/setup-fonts.sh --ms-fonts          # also step 3 (accepts the EULA)
#   ./server/setup-fonts.sh --from-windows DIR  # copy real fonts you already own
#
# Re-running is safe.

set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CONF_SRC="$HERE/fonts/60-asaaei-office-substitutes.conf"

WANT_MS_FONTS=0
WINDOWS_DIR=""
while [ $# -gt 0 ]; do
  case "$1" in
    --ms-fonts) WANT_MS_FONTS=1; shift ;;
    --from-windows) WINDOWS_DIR="${2:-}"; shift 2 ;;
    -h|--help) sed -n '2,25p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
done

say() { printf '\n\033[1m==> %s\033[0m\n' "$*"; }
note() { printf '    %s\n' "$*"; }

# Root is needed for a system-wide install; without it we fall back to the
# user's own font directory, which works fine for a single-user machine.
if [ "$(id -u)" -eq 0 ]; then
  SUDO=""; FONT_DIR="/usr/local/share/fonts/asaaei"; CONF_DIR="/etc/fonts/conf.d"
elif command -v sudo >/dev/null 2>&1; then
  SUDO="sudo"; FONT_DIR="/usr/local/share/fonts/asaaei"; CONF_DIR="/etc/fonts/conf.d"
else
  SUDO=""; FONT_DIR="$HOME/.local/share/fonts/asaaei"; CONF_DIR="$HOME/.config/fontconfig/conf.d"
  note "not root and no sudo — installing for this user only ($FONT_DIR)"
fi

# ---------------------------------------------------------------------------
# 1 + 2. Free fonts
# ---------------------------------------------------------------------------

PKGS_APT="fonts-crosextra-carlito fonts-crosextra-caladea fonts-liberation2
          fonts-dejavu-core fonts-noto-core fonts-noto-cjk"

say "Installing the free substitute fonts"
if command -v apt-get >/dev/null 2>&1; then
  $SUDO apt-get update -qq || true
  # shellcheck disable=SC2086
  $SUDO apt-get install -y --no-install-recommends $PKGS_APT
elif command -v dnf >/dev/null 2>&1; then
  $SUDO dnf install -y google-carlito-fonts google-caladea-fonts \
    liberation-fonts dejavu-sans-fonts google-noto-sans-fonts || true
elif command -v brew >/dev/null 2>&1; then
  brew install --cask font-carlito font-caladea font-liberation font-dejavu || true
else
  note "no apt/dnf/brew found — install Carlito, Caladea, Liberation and DejaVu by hand"
fi

# ---------------------------------------------------------------------------
# 3. The genuine Microsoft fonts (optional, licence-dependent)
# ---------------------------------------------------------------------------

if [ -n "$WINDOWS_DIR" ]; then
  say "Copying fonts from $WINDOWS_DIR"
  if [ ! -d "$WINDOWS_DIR" ]; then
    echo "    $WINDOWS_DIR is not a directory" >&2; exit 1
  fi
  # Copying from a Windows machine you are licensed for is the surest route to
  # a pixel-exact match, and the only one that gets you real Verdana.
  $SUDO mkdir -p "$FONT_DIR"
  found=0
  for f in "$WINDOWS_DIR"/*.[tT][tT][fF] "$WINDOWS_DIR"/*.[tT][tT][cC] "$WINDOWS_DIR"/*.[oO][tT][fF]; do
    [ -e "$f" ] || continue
    $SUDO cp -n "$f" "$FONT_DIR/" && found=$((found + 1))
  done
  note "copied $found font file(s) into $FONT_DIR"
  note "you are responsible for holding a licence for these fonts"
fi

if [ "$WANT_MS_FONTS" -eq 1 ]; then
  say "Installing the Microsoft core fonts"
  note "this accepts the Microsoft EULA on your behalf — see"
  note "https://corefonts.sourceforge.net/eula.htm"
  if command -v apt-get >/dev/null 2>&1; then
    echo "ttf-mscorefonts-installer msttcorefonts/accepted-mscorefonts-eula select true" \
      | $SUDO debconf-set-selections
    $SUDO apt-get install -y ttf-mscorefonts-installer \
      || note "install failed (it downloads from sourceforge.net — check network access)"
  else
    note "not an apt system; use --from-windows instead"
  fi
fi

# ---------------------------------------------------------------------------
# Substitution rules
# ---------------------------------------------------------------------------

say "Installing the font substitution rules"
$SUDO mkdir -p "$CONF_DIR"
$SUDO cp "$CONF_SRC" "$CONF_DIR/"
note "installed $CONF_DIR/$(basename "$CONF_SRC")"

say "Rebuilding the font cache"
$SUDO fc-cache -f >/dev/null
command -v fc-cache >/dev/null && fc-cache -f >/dev/null 2>&1 || true

# ---------------------------------------------------------------------------

say "What the converter will now use"
for family in Calibri Cambria Arial "Times New Roman" "Courier New" \
              Verdana Tahoma "Segoe UI" Georgia; do
  got="$(fc-match "$family" family 2>/dev/null || echo '?')"
  if [ "$got" = "$family" ]; then
    printf '    %-18s %s \033[32m(the real font)\033[0m\n' "$family" "$got"
  else
    printf '    %-18s %s\n' "$family" "$got"
  fi
done

cat <<'EOF'

Done. Restart the converter so LibreOffice picks up the new fonts:

    npm run serve

A family listed above as itself is the genuine font and converts pixel-exact.
Carlito, Caladea and Liberation are metric-compatible stand-ins: different
shapes, identical widths, so line breaks and page counts match Word exactly.
Anything else is a close-proportion guess and text set in it may re-wrap — for
those, --from-windows with a licensed copy of the font is the real fix.
EOF
