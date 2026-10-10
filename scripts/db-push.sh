#!/usr/bin/env bash
# Applies supabase/migrations to the client's LINKED Supabase project.
#
#   bash scripts/db-push.sh            # migrations only
#   bash scripts/db-push.sh --dry-run  # extra flags go to `supabase db push`
#
# Always through npx: there is no bare `supabase` on this machine, and a
# missing command must never look like a finished push.
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/_credentials.sh"

cd "$REPO_ROOT"
load_credentials
load_project_ref
[ -n "$SUPABASE_ACCESS_TOKEN" ] || die "SUPABASE_ACCESS_TOKEN nije upisan u .supabase-cli.env."
confirm_project

npx supabase db push --linked "$@"
