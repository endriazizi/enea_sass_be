#!/usr/bin/env bash
set -euo pipefail

# ===================== CONFIG =====================
OUT="${OUT:-exports/BE_FULL_EXPORT.md}"                     # File Markdown di output
TITLE="${TITLE:-Backend — Tree, Lista & Sorgenti (SAFE)}"
SHOW_TREE="${SHOW_TREE:-1}"                                  # 1=stampa tree, 0=no
ONLY_DIRS="${ONLY_DIRS:-.}"                                  # Es. "." oppure "src scripts"
MAX_SIZE_KB="${MAX_SIZE_KB:-0}"                              # 0=disabilitato; es. 512 per limitare a 512KB/file
SKIP_LOCKS="${SKIP_LOCKS:-1}"                                # 1=salta lockfile
DRY_RUN="${DRY_RUN:-0}"                                      # 1=non scrive i contenuti, solo lista/diagnostica
IGNORE_STRICT="${IGNORE_STRICT:-0}"                          # 1=esclude anche se tracciati (blacklist comune)

# === INIZIO MODIFICA: escludi sempre exports/ (anche senza STRICT) ===========
# Esclusioni "soft" di base + esclusione esplicita di exports/
# - (^|/)exports(/|$) esclude la cartella "exports" ovunque si trovi nel path.
EXCLUDE_REGEX="${EXCLUDE_REGEX:-(\.min\.(js|css)$|\.map$|(^|/)\.husky/|(^|/)exports(/|$))}"
# ✅ Aggiunto: pattern per escludere sempre `exports/`.
# === FINE MODIFICA ===========================================================

# Blacklist STRONG per STRICT mode (anche se tracciati)
STRICT_DIRS='node_modules|dist|build|coverage|www|exports|out|.next|.nuxt|.cache|.parcel-cache|tmp|temp|logs?|log|.vite|.angular|.vercel|.serverless|vendor'
STRICT_FILES='\.DS_Store$|\.log$|\.env($|\.)'
# ==================================================

say() { echo "[$(date +%H:%M:%S)] $*"; }

say "🧾 Export BE (SAFE) ▶️ $(pwd)"
say "Bash: $BASH_VERSION  ·  Git: $(git --version 2>/dev/null || echo 'N/A')"
say "Config → SHOW_TREE=$SHOW_TREE  DRY_RUN=$DRY_RUN  MAX_SIZE_KB=$MAX_SIZE_KB  IGNORE_STRICT=$IGNORE_STRICT"
echo

# ── Precheck ──────────────────────────────────────
if ! git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  echo "❌ Non è una repo Git (serve per rispettare .gitignore)."
  exit 1
fi

# ── Raccogli file NON ignorati (rispetta .gitignore) ─────────────────────────
collect_files() {
  local dir="$1"
  git ls-files --cached --others --exclude-standard -z -- "$dir/**" 2>/dev/null \
    | tr -d '\r' | tr '\0' '\n'
}
mapfile -t FILES < <(
  for d in $ONLY_DIRS; do collect_files "$d"; done | sort -u
)
say "Trovati ${#FILES[@]} file (non ignorati da .gitignore)."

# ── Applica STRICT (blacklist semplice e robusta) ─────────────────────────────
if [ "$IGNORE_STRICT" = "1" ]; then
  STRICT_REGEX="((^|/)(${STRICT_DIRS})/|(${STRICT_FILES}))"
  if [ -n "$EXCLUDE_REGEX" ]; then
    EXCLUDE_REGEX="(${EXCLUDE_REGEX})|(${STRICT_REGEX})"
  else
    EXCLUDE_REGEX="${STRICT_REGEX}"
  fi
fi

# Skip lockfiles se richiesto
if [ "$SKIP_LOCKS" = "1" ]; then
  EXCLUDE_REGEX="(${EXCLUDE_REGEX})|(pnpm-lock\.yaml|package-lock\.json|yarn\.lock)$"
fi

say "EXCLUDE_REGEX effettiva: $EXCLUDE_REGEX"
mapfile -t FILES < <(printf "%s\n" "${FILES[@]}" | grep -Ev -- "$EXCLUDE_REGEX" || true)
say "Dopo filtro regex: ${#FILES[@]} file."

# ── TREE (fallback a lista semplice se awk non c'è) ───────────────────────────
gen_tree() {
  if ! awk -W version >/dev/null 2>&1; then
    printf ".\n"; for f in "${FILES[@]}"; do printf "└── %s\n" "$f"; done; return
  fi
  printf "%s\n" "${FILES[@]}" | awk -F'/' '
  {
    n=split($0, comp, "/"); parent="."; isdir["."]=1;
    for (i=1; i<=n; i++) {
      node=(parent=="."?comp[i]:parent "/" comp[i]);
      if (i<n) isdir[node]=1;
      if (!(seen[parent, node])) kids[parent, ++kidcount[parent]] = node;
      seen[parent, node]=1; parent=node;
    }
  }
  function base(p, a,c){c=split(p,a,"/");return a[c]}
  function pt(n,p, i,ch,N,arr){
    N=kidcount[n]; if(N==0) return;
    split("", arr); for(i=1;i<=N;i++) arr[i]=kids[n,i];
    # semplice ordinamento alfabetico
    for(i=1;i<=N;i++) for(j=i+1;j<=N;j++) if(arr[i]>arr[j]) {tmp=arr[i];arr[i]=arr[j];arr[j]=tmp}
    for(i=1;i<=N;i++){ ch=arr[i]; last=(i==N);
      printf("%s%s %s\n", p, (last?"└──":"├──"), base(ch));
      if (isdir[ch]) pt(ch, p (last?"    ":"│   "));
    }
  }
  END{ print "."; pt(".",""); }'
}

# ── Rileva “file testuale” via whitelist estensioni (niente `file`: è lento) ─
TEXT_WHITELIST='js|mjs|cjs|ts|tsx|jsx|json|md|markdown|sql|sh|bash|cmd|ps1|txt|env|example|yml|yaml|html|htm|scss|sass|css|conf|ini|gitignore|editorconfig|eslintrc|prettierrc|npmrc'
is_text_by_ext() {
  case "$1" in
    *.*) local ext="${1##*.}"; echo "$ext" | grep -Eiq "^(${TEXT_WHITELIST})$" && return 0 ;;
  esac
  return 1
}
fence_lang() {
  case "${1##*.}" in
    js|mjs|cjs) echo "javascript" ;;
    ts|tsx) echo "typescript" ;;
    jsx) echo "jsx" ;;
    json) echo "json" ;;
    md|markdown) echo "markdown" ;;
    sh|bash|cmd|ps1) echo "bash" ;;
    sql) echo "sql" ;;
    yml|yaml) echo "yaml" ;;
    html|htm) echo "html" ;;
    scss|sass|css) echo "${1##*.}" ;;
    conf|ini|env|example|txt|gitignore|editorconfig|eslintrc|prettierrc|npmrc) echo "text" ;;
    *) echo "" ;;
  esac
}
too_big() {
  [ "$MAX_SIZE_KB" -gt 0 ] || return 1
  local bytes; bytes=$(wc -c <"$1" 2>/dev/null || echo 0)
  [ "$bytes" -gt $((MAX_SIZE_KB * 1024)) ]
}

# ── DRY RUN? (solo lista) ────────────────────────────────────────────────────
if [ "$DRY_RUN" = "1" ]; then
  say "DRY_RUN=1 → stampo solo anteprima:"
  printf "%s\n" "${FILES[@]}" | sed -n '1,50p'
  exit 0
fi

# ── Scrivi output ─────────────────────────────────────────────────────────────
mkdir -p "$(dirname "$OUT")"
{
  echo "# $TITLE"
  echo
  echo "- **Root:** \`$(pwd)\`"
  echo "- **Dir incluse:** \`$ONLY_DIRS\`"
  echo "- **Data:** $(date '+%Y-%m-%d %H:%M:%S')"
  echo "- **STRICT:** $IGNORE_STRICT  ·  **MAX_SIZE_KB:** $MAX_SIZE_KB  ·  **SKIP_LOCKS:** $SKIP_LOCKS"
  echo "- **EXCLUDE_REGEX:** \`$EXCLUDE_REGEX\`"
  echo
  if [ "$SHOW_TREE" = "1" ]; then
    echo "## Tree"
    echo '```'
    gen_tree
    echo '```'
    echo
  fi

  echo "## Elenco file (non esclusi)"
  for f in "${FILES[@]}"; do echo "- $f"; done
  echo

  echo "## Sorgenti (contenuto completo dei file testuali)"
  for f in "${FILES[@]}"; do
    echo
    echo "────────────────────────────────────────────────────────"
    echo "📄 FILE: $f"
    echo "────────────────────────────────────────────────────────"
    if ! is_text_by_ext "$f"; then
      echo "_[Probabile binario o estensione non whitelisted: contenuto non incluso]_"
      continue
    fi
    if too_big "$f"; then
      echo "_[Saltato: file > ${MAX_SIZE_KB}KB]_"
      continue
    fi
    lang="$(fence_lang "$f")"
    [ -n "$lang" ] && echo '```'"$lang" || echo '```'
    cat "$f"
    echo
    echo '```'
  done
  echo
} > "$OUT"

say "✅ Esportazione completata → $OUT"
