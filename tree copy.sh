# === Config ===
OUT="SRC_EXPORT.md"

# 1) TREE (puoi cambiare 'src' con '.' se vuoi l'albero completo)
npx tree-cli src -a -I "node_modules|dist|build|coverage|.git|.angular|.vscode|tmp|www" \
  | sed -r 's/\x1B\[[0-9;]*[A-Za-z]//g' > /tmp/_tree_src.txt  # rimuove eventuali colori ANSI

# 2) Header + TREE nel markdown
{
  echo "# Export src"
  echo
  echo "## Tree di src/"
  echo
  echo '```'
  cat /tmp/_tree_src.txt
  echo '```'
  echo
  echo "## Contenuti dei file in src/"
} > "$OUT"

# 3) Elenco file da "esplodere" (solo dentro src/, escludo cartelle pesanti)
find src \
  -type f \
  ! -path "*/node_modules/*" ! -path "*/dist/*" ! -path "*/build/*" ! -path "*/coverage/*" \
  ! -path "*/.git/*" ! -path "*/.angular/*" ! -path "*/.vscode/*" ! -path "*/www/*" \
  \( -name "*.ts" -o -name "*.js" -o -name "*.html" -o -name "*.scss" -o -name "*.css" \
     -name "*.json" -o -name "*.md" -o -name "*.yml" -o -name "*.yaml" \) \
  | sort | while IFS= read -r f; do
    ext="${f##*.}"
    case "$ext" in
      ts|js|html|scss|css|json|md|yml|yaml) lang="$ext" ;;
      *) lang="" ;;
    esac
    printf '\n---\n\n### %s\n\n```%s\n' "$f" "$lang" >> "$OUT"
    sed -e 's/\r$//' -- "$f" >> "$OUT"
    printf '\n```\n' >> "$OUT"
  done

echo "Creato $OUT"
