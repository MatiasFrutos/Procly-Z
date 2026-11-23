#!/usr/bin/env bash
# Genera ./public: copia limpia del proyecto, lista para publicar como repositorio público.
#   ./scripts/make-public.sh
#   cd public && git init -b main && git add . && git commit -m "Initial commit"
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUT="$ROOT/public"
rm -rf "$OUT" && mkdir -p "$OUT"
tar -C "$ROOT" \
  --exclude=./.git --exclude=./public --exclude=./node_modules \
  --exclude=./src-tauri/target --exclude=./src-tauri/gen --exclude=./dist \
  -cf - . | tar -C "$OUT" -xf -
echo "Carpeta pública lista en: $OUT"
du -sh "$OUT" | cut -f1 | sed 's/^/Tamaño: /'
