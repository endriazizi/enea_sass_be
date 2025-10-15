#!/usr/bin/env bash
set -euo pipefail

# ===================== CONFIG =====================
ROOT="${ROOT:-.}"                          # radice del progetto
OUT="${OUT:-PROJECT_FULL_EXPORT.md}"       # file markdown di output
EXCLUDE_GIT="${EXCLUDE_GIT:-1}"            # 1 = esclude .git (consigliato)
INCLUDE_BIN="${INCLUDE_BIN:-1}"            # 1 = include binari (png/pdf/…)
NORMALIZE_CRLF="${NORMALIZE_CRLF:-0}"      # 1 = rimuove \r (Windows)
MAX_BYTES_PER_FILE="${MAX_BYTES_PER_FILE:-0}" # 0 = nessun troncamento
# ==================================================

# Dir escluse ovunque (tree + find)
EXCLUDE_DIRS=( "./node_modules" )
(( EXCLUDE_GIT == 1 )) && EXCLUDE_DIRS+=( "./.git" )

BIN_GLOBS=(
  "*.png" "*.jpg" "*.jpeg" "*.gif" "*.webp" "*.ico" "*.svg" "*.svgz"
  "*.pdf" "*.zip" "*.gz" "*.rar" "*.7z"
  "*.mp3" "*.wav" "*.mp4" "*.webm" "*.mov"
  "*.woff" "*.woff2" "*.ttf" "*.otf" "*.eot"
  "*.exe" "*.dll" "*.so" "*.dylib" "*.a" "*.jar" "*.psd" "*.ai"
)

# --------------------- TREE (forzato stile tree-cli + filtro blocchi) ---------------------
TREE_FILE="$(mktemp)"
EXCL_COMMA="$(printf "%s," "${EXCLUDE_DIRS[@]##./}" | sed 's/,$//')"  # es. "node_modules,.git"

if [ -x "./node_modules/.bin/tree" ]; then
  # tua CLI funzionante: -l 100 e -I con virgole
  ./node_modules/.bin/tree "$ROOT" -a -l 100 --dirs-first -I "$EXCL_COMMA" > "$TREE_FILE" || true
else
  if command -v cmd >/dev/null 2>&1; then
    ( cd "$ROOT" && cmd //c "tree /F /A" ) | sed 's/\r$//' > "$TREE_FILE" || true
  else
    find "$ROOT" -print | sed 's|^\./||' > "$TREE_FILE"
  fi
fi

# RIMUOVI comunque i blocchi node_modules/ (e .git/ se richiesto) dal TREE stampato
# Logica: quando incontra una riga "├── node_modules" (o ".git"), salta tutte le righe
# successive che iniziano con "|" o spazio fino alla prossima riga top-level (che inizia con "├" o "└").
awk -v dropGit="${EXCLUDE_GIT}" '
  BEGIN{skip=0}
  # inizio blocco da saltare (top-level)
  /^[[:space:]\|]*[├└]── node_modules(\r)?$/ { skip=1; next }
  (dropGit=="1") && /^[[:space:]\|]*[├└]── \.git(\r)?$/ { skip=1; next }
  # mentre siamo dentro al blocco, salta le righe che iniziano con | o spazio
  skip==1 {
    if ($0 ~ /^[[:space:]\|]/) next;
    else skip=0;
  }
  { print }
' "$TREE_FILE" > "${TREE_FILE}.filtered" && mv "${TREE_FILE}.filtered" "$TREE_FILE"

# --------------------- COSTRUISCI LISTA FILE ---------------------
PRUNE_EXPR=()
for d in "${EXCLUDE_DIRS[@]}"; do PRUNE_EXPR+=( -path "$d" -o ); done
((${#PRUNE_EXPR[@]})) && unset 'PRUNE_EXPR[${#PRUNE_EXPR[@]}-1]'

OUT_NAME="$(basename "$OUT")"

FIND_CMD=( find "$ROOT" )
((${#PRUNE_EXPR[@]})) && FIND_CMD+=( \( "${PRUNE_EXPR[@]}" \) -prune -o )
FIND_CMD+=( -type f )
# escludi SEMPRE l’output
FIND_CMD+=( ! -name "$OUT_NAME" ! -path "./$OUT" )
# (opzionale) escludi binari
if (( INCLUDE_BIN == 0 )); then
  for g in "${BIN_GLOBS[@]}"; do FIND_CMD+=( ! -iname "$g" ); done
fi
FIND_CMD+=( -print0 )

mapfile -d '' -t FILES < <("${FIND_CMD[@]}")
mapfile -d '' -t FILES < <(
  printf '%s\0' "${FILES[@]}" \
  | sed -z 's|^\./||' \
  | LC_ALL=C sort -z
)

# --------------------- PREPARA OUTPUT ---------------------
OUT_TMP="$(mktemp)"
exec 3>"$OUT_TMP"

{
  echo "# Project export"
  echo
  echo "Generato: $(date '+%Y-%m-%d %H:%M:%S')"
  echo
  echo "## Tree (esclusi: ${EXCL_COMMA:-none})"
  echo
  echo '```'
  cat "$TREE_FILE"
  echo '```'
  echo
  echo "## Contenuti dei file"
} >&3

ext_to_lang () {
  case "$1" in
    ts|js|mjs|cjs|jsx|tsx|html|scss|css|less|sass|json|md|yml|yaml|xml|toml|ini|conf|sh|bash|bat|ps1|env|Dockerfile|dockerfile)
      printf "%s" "$1" ;;
    Dockerfile|dockerfile) printf "dockerfile" ;;
    *) printf "" ;;
  esac
}

COUNT=0
for f in "${FILES[@]}"; do
  lang="$(ext_to_lang "${f##*.}")"
  {
    echo
    echo '---'
    echo
    echo "### ${f}"
    echo
    printf '```%s\n' "$lang"
  } >&3

  if (( MAX_BYTES_PER_FILE > 0 )); then
    size=$(wc -c < "$f")
    if (( size > MAX_BYTES_PER_FILE )); then
      if (( NORMALIZE_CRLF == 1 )); then head -c "$MAX_BYTES_PER_FILE" -- "$f" | tr -d '\r' >&3
      else head -c "$MAX_BYTES_PER_FILE" -- "$f" >&3
      fi
      echo -e "\n... [TRONCATO a ${MAX_BYTES_PER_FILE} byte: ${size} byte originali]" >&3
    else
      if (( NORMALIZE_CRLF == 1 )); then tr -d '\r' < "$f" >&3
      else cat -- "$f" >&3
      fi
    fi
  else
    if (( NORMALIZE_CRLF == 1 )); then tr -d '\r' < "$f" >&3
    else cat -- "$f" >&3
    fi
  fi

  echo '```' >&3
  COUNT=$((COUNT+1))
done

exec 3>&-
mv "$OUT_TMP" "$OUT"
echo "Creato ${OUT} — inclusi ${COUNT} file."
