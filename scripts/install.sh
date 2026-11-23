#!/usr/bin/env bash
# Compila e instala Procly en Omarchy / Arch Linux.
#
#   ./scripts/install.sh              compila e instala para tu usuario (~/.local)
#   ./scripts/install.sh --system     instala para todo el sistema (/usr/local, usa sudo)
#   ./scripts/install.sh --no-build   reutiliza el binario ya compilado
#   ./scripts/install.sh --skip-deps  no comprueba/instala dependencias con pacman
#   ./scripts/install.sh --uninstall  elimina Procly
set -euo pipefail

APP="procly"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SYSTEM=0; BUILD=1; DEPS=1; UNINSTALL=0

for arg in "$@"; do
  case "$arg" in
    --system)    SYSTEM=1 ;;
    --no-build)  BUILD=0 ;;
    --skip-deps) DEPS=0 ;;
    --uninstall) UNINSTALL=1 ;;
    -h|--help)   sed -n '2,9p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "Opción desconocida: $arg (usa --help)" >&2; exit 1 ;;
  esac
done

if [[ $SYSTEM -eq 1 ]]; then
  PREFIX="${PREFIX:-/usr/local}"; DATA="$PREFIX/share"; SUDO="sudo"
else
  PREFIX="${PREFIX:-$HOME/.local}"; DATA="${XDG_DATA_HOME:-$PREFIX/share}"; SUDO=""
fi
BIN="$PREFIX/bin/$APP"
DESKTOP="$DATA/applications/$APP.desktop"
ICON_DIR="$DATA/icons/hicolor"

say()  { printf '\033[1;36m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m!!\033[0m  %s\n' "$*" >&2; }

refresh_caches() {
  command -v update-desktop-database >/dev/null && $SUDO update-desktop-database "$DATA/applications" 2>/dev/null || true
  command -v gtk-update-icon-cache  >/dev/null && $SUDO gtk-update-icon-cache -qtf "$ICON_DIR" 2>/dev/null || true
}

# ───────── Desinstalar ─────────
if [[ $UNINSTALL -eq 1 ]]; then
  say "Eliminando Procly de $PREFIX"
  $SUDO rm -fv "$BIN" "$DESKTOP" \
    "$ICON_DIR"/{32x32,128x128,256x256,512x512}/apps/$APP.png "$ICON_DIR/scalable/apps/$APP.svg"
  refresh_caches
  say "Listo."
  exit 0
fi

# ───────── Dependencias ─────────
if [[ $DEPS -eq 1 && $BUILD -eq 1 ]]; then
  if command -v pacman >/dev/null; then
    pkgs=(base-devel webkit2gtk-4.1 gtk3 librsvg libsoup3 openssl)
    command -v cargo >/dev/null || pkgs+=(rust)
    command -v npm   >/dev/null || pkgs+=(nodejs npm)
    missing=()
    for p in "${pkgs[@]}"; do pacman -Qq "$p" >/dev/null 2>&1 || missing+=("$p"); done
    if [[ ${#missing[@]} -gt 0 ]]; then
      say "Instalando dependencias: ${missing[*]}"
      sudo pacman -S --needed --noconfirm "${missing[@]}"
    else
      say "Dependencias del sistema OK"
    fi
  else
    warn "pacman no encontrado: instala manualmente webkit2gtk-4.1, gtk3, librsvg, libsoup3, rust y nodejs/npm."
  fi
  command -v cargo >/dev/null || { warn "cargo no está en el PATH (si usas rustup: rustup default stable)"; exit 1; }
  command -v npm   >/dev/null || { warn "npm no está en el PATH"; exit 1; }
fi

# ───────── Compilar ─────────
BUILT="$ROOT/src-tauri/target/release/$APP"
if [[ $BUILD -eq 1 ]]; then
  cd "$ROOT"
  say "Instalando dependencias de Node"
  npm install --no-audit --no-fund
  say "Compilando Procly (release) — la primera vez tarda unos minutos"
  npm run build -- --no-bundle
fi
[[ -x "$BUILT" ]] || { warn "No existe $BUILT. Ejecuta sin --no-build."; exit 1; }

# ───────── Instalar ─────────
say "Instalando en $PREFIX"
$SUDO install -Dm755 "$BUILT" "$BIN"

ICONS="$ROOT/src-tauri/icons"
$SUDO install -Dm644 "$ICONS/32x32.png"       "$ICON_DIR/32x32/apps/$APP.png"
$SUDO install -Dm644 "$ICONS/128x128.png"     "$ICON_DIR/128x128/apps/$APP.png"
$SUDO install -Dm644 "$ICONS/128x128@2x.png"  "$ICON_DIR/256x256/apps/$APP.png"
$SUDO install -Dm644 "$ICONS/icon.png"        "$ICON_DIR/512x512/apps/$APP.png"
$SUDO install -Dm644 "$ROOT/assets/icon.svg"  "$ICON_DIR/scalable/apps/$APP.svg"

$SUDO mkdir -p "$(dirname "$DESKTOP")"
$SUDO tee "$DESKTOP" >/dev/null <<DESKTOP_FILE
[Desktop Entry]
Type=Application
Name=Procly
GenericName=Process Manager
Comment=Visor y terminador de procesos
Exec=$BIN
Icon=$APP
Terminal=false
Categories=System;Monitor;Utility;
Keywords=process;task;kill;monitor;procesos;
StartupWMClass=$APP
DESKTOP_FILE
refresh_caches

case ":$PATH:" in *":$PREFIX/bin:"*) ;; *) warn "$PREFIX/bin no está en tu PATH." ;; esac

say "Procly instalado: $BIN"
cat <<MSG

  Ejecutar:        $APP        (o búscalo en el lanzador: SUPER + ESPACIO)
  Atajo Hyprland:  añade a ~/.config/hypr/bindings.conf
                     bindd = SUPER SHIFT, P, Procly, exec, $APP
  Desinstalar:     ./scripts/install.sh --uninstall
MSG
