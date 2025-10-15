#!/usr/bin/env bash
set -euo pipefail

# ====== CONFIG ======
ROOT="${ROOT:-src}"                   # cartella da esportare (default: src)
OUT="${OUT:-SRC_EXPORT.md}"           # file markdown di output
NORMALIZE_CRLF="${NORMALIZE_CRLF:-0}" # 1 = rimuove \r (Windows) per righe pulite
MAX_FILES="${MAX_FILES:-0}"           # 0 = nessun limite; es. 50 per limitare
MAX_BYTES_PER_FILE="${MAX_BYTES_PER_FILE:-0}" # 0 = nessun troncamento; es. 200000
INCLUDE_BIN="${INCLUDE_BIN:-0}"       # 0 = esclude asset/binari; 1 = includi tutto
# Sottocartelle rumorose da saltare DENTRO src/
PRUNE_DIRS=( "$ROOT/node_modules" "$ROOT/dist" "$ROOT/build" "$ROOT/coverage" "$ROOT/tmp" "$ROOT/www" )
# Pattern “binari” (usati solo se INCLUDE_BIN=0)
BIN_GLOBS=( "*.png" "*.jpg" "*.jpeg" "*.gif" "*.webp" "*.ico" "*.svg" "*.svgz"
            "*.pdf" "*.zip" "*.gz" "*.rar" "*.7z"
            "*.mp3" "*.wav" "*.mp4" "*.webm" "*.mov"
            "*.woff" "*.woff2" "*.ttf" "*.otf" "*.eot"
            "*.exe" "*.dll" "*.jar" "*.psd" "*.ai" )
# ====================

[ -d "$ROOT" ] || { echo "Cartella '$ROOT' non trovata"; exit 1; }

# ---- LISTA FILE (NUL-safe) ----
PRUNE_EXPR=()
for d in "${PRUNE_DIRS[@]}"; do PRUNE_EXPR+=( -path "$d" -o ); done
((${#PRUNE_EXPR[@]})) && unset 'PRUNE_EXPR[${#PRUNE_EXPR[@]}-1]'

OUT_NAME="$(basename "$OUT")"

FIND_CMD=( find "$ROOT" )
((${#PRUNE_EXPR[@]})) && FIND_CMD+=( \( "${PRUNE_EXPR[@]}" \) -prune -o )
FIND_CMD+=( -type f )
# escludi l'output se lo stai salvando in src
FIND_CMD+=( ! -name "$OUT_NAME" ! -path "$ROOT/$OUT_NAME" )
# (opz.) escludi binari
if (( INCLUDE_BIN == 0 )); then
  for g in "${BIN_GLOBS[@]}"; do FIND_CMD+=( ! -iname "$g" ); done
fi
FIND_CMD+=( -print0 )

mapfile -d '' -t FILES < <("${FIND_CMD[@]}")

# ordina e applica limite MAX_FILES
mapfile -d '' -t FILES < <(
  printf '%s\0' "${FILES[@]}" \
  | sed -z 's|^\./||' \
  | LC_ALL=C sort -z
)
TOTAL=${#FILES[@]}
if (( MAX_FILES>0 && TOTAL>MAX_FILES )); then
  FILES=("${FILES[@]:0:MAX_FILES}")
fi

# ---- helper: language per code fence ----
ext_to_lang () {
  case "$1" in
    ts|js|mjs|cjs|jsx|tsx|html|scss|css|less|sass|json|md|yml|yaml|xml|toml|ini|conf|sh|bash|bat|ps1|env|Dockerfile|dockerfile)
      printf "%s" "$1" ;;
    Dockerfile|dockerfile) printf "dockerfile" ;;
    *) printf "" ;;
  esac
}

# ---- SCRITTURA OUTPUT ----
OUT_TMP="$(mktemp)"
exec 3>"$OUT_TMP"

{
  echo "# Export ${ROOT}"
  echo
  echo "Generato: $(date '+%Y-%m-%d %H:%M:%S')"
  echo
  echo "## Elenco file in ${ROOT}/ (${TOTAL}$([[ $MAX_FILES -gt 0 ]] && echo ", mostrati max ${MAX_FILES}"))"
  echo
  echo '```'
  for f in "${FILES[@]}"; do echo "$f"; done
  echo '```'
  echo
  echo "## Contenuti dei file"
} >&3

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
echo "Creato ${OUT} — inclusi ${COUNT} file (su ${TOTAL} trovati in ${ROOT})."
