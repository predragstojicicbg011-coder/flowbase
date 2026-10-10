# Shared by scripts/seed-client.sh and scripts/db-push.sh. Not run directly.
#
# Reads the client's Supabase credentials from the gitignored
# .supabase-cli.env in the repo root (never `supabase login`), the way the
# first client app has always done it:
#
#   SUPABASE_ACCESS_TOKEN=sbp_...
#   SUPABASE_DB_PASSWORD=...
#
# Notepad saves that file with CRLF, so every value has \r stripped.

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CRED_FILE="$REPO_ROOT/.supabase-cli.env"
REF_FILE="$REPO_ROOT/supabase/.temp/project-ref"

die() { echo "GREŠKA: $*" >&2; exit 1; }

read_cred() {
  grep -E "^$1=" "$CRED_FILE" | head -n 1 | cut -d= -f2- | tr -d '\r'
}

load_credentials() {
  [ -f "$CRED_FILE" ] || die "nema $CRED_FILE (SUPABASE_ACCESS_TOKEN i SUPABASE_DB_PASSWORD)."
  SUPABASE_ACCESS_TOKEN="$(read_cred SUPABASE_ACCESS_TOKEN)"
  SUPABASE_DB_PASSWORD="$(read_cred SUPABASE_DB_PASSWORD)"
  [ -n "$SUPABASE_DB_PASSWORD" ] || die "SUPABASE_DB_PASSWORD nije upisan u .supabase-cli.env."
  export SUPABASE_ACCESS_TOKEN SUPABASE_DB_PASSWORD
}

load_project_ref() {
  [ -f "$REF_FILE" ] || die "projekat nije linkovan (nema supabase/.temp/project-ref). Pokreni: npx supabase link --project-ref <ref>"
  PROJECT_REF="$(tr -d '\r\n ' < "$REF_FILE")"
  [ -n "$PROJECT_REF" ] || die "supabase/.temp/project-ref je prazan."
}

confirm_project() {
  echo "Linkovan Supabase projekat: $PROJECT_REF"
  echo "Folder: $REPO_ROOT"
  read -r -p "Da li je ovo baza OVOG klijenta? Upiši 'da' za nastavak: " answer
  [ "$answer" = "da" ] || die "prekinuto."
}
