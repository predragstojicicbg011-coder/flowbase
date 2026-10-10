#!/usr/bin/env bash
# Runs the client's own supabase/client/seed.sql against the LINKED Supabase
# project, through the session pooler.
#
#   bash scripts/seed-client.sh
#
# Environment (all optional):
#   PSQL             path to psql (default: on PATH, then the scoop install)
#   SUPABASE_REGION  pooler region (default aws-1-eu-central-1, Frankfurt;
#                    Dashboard → Connect → Session pooler shows the host)
#   SEED_FILE        another seed file (default supabase/client/seed.sql)
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/_credentials.sh"

cd "$REPO_ROOT"
SEED_FILE="${SEED_FILE:-supabase/client/seed.sql}"
REGION="${SUPABASE_REGION:-aws-1-eu-central-1}"

if [ ! -f "$SEED_FILE" ]; then
  die "nema $SEED_FILE. Napravi ga iz primera:
    cp supabase/client/seed.example.sql supabase/client/seed.sql
  popuni vrednosti i commituj ga u repo klijenta (u FlowBase-u seed.sql ne postoji)."
fi

if [ -z "${PSQL:-}" ]; then
  if command -v psql >/dev/null 2>&1; then
    PSQL="psql"
  else
    PSQL="C:/Users/Predrag PC/scoop/apps/postgresql/current/bin/psql.exe"
  fi
fi
[ -x "$PSQL" ] || command -v "$PSQL" >/dev/null 2>&1 || die "psql nije pronađen ($PSQL). Postavi PSQL=<putanja>."

load_credentials
load_project_ref
confirm_project

HOST="$REGION.pooler.supabase.com"
echo "Seed: $SEED_FILE → $HOST (postgres.$PROJECT_REF)"

PGPASSWORD="$SUPABASE_DB_PASSWORD" PGSSLMODE=require "$PSQL" \
  -h "$HOST" -p 5432 -U "postgres.$PROJECT_REF" -d postgres \
  -v ON_ERROR_STOP=1 -f "$SEED_FILE"
