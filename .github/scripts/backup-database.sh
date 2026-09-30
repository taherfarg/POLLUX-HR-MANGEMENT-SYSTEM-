#!/usr/bin/env bash
# Backs up the Pollux HR database: dump, encrypt, upload, prune.
#
# Run every night by .github/workflows/backup.yml; setup and restore are in
# DEPLOYMENT.md, "Daily backups". It reads:
#   DATABASE_URL       the Neon connection string (the pooled one is fine - see below)
#   BACKUP_PASSPHRASE  the password each backup is encrypted with. Keep it somewhere
#                      safe: without it no backup can be opened.
#   BACKUP_REMOTE      optional: where the file goes, in rclone's terms ("gdrive:Pollux HR
#                      backups"). Left empty, the rclone config's only remote is used,
#                      with the folder BACKUP_FOLDER (default "Pollux HR backups").
#   KEEP_DAYS          backups older than this are deleted there (default 30)
# and an rclone config that defines the remote.
set -euo pipefail

: "${DATABASE_URL:?the BACKUP_DATABASE_URL secret is not set}"
: "${BACKUP_PASSPHRASE:?the BACKUP_PASSPHRASE secret is not set}"
BACKUP_REMOTE="${BACKUP_REMOTE:-}"
BACKUP_FOLDER="${BACKUP_FOLDER:-Pollux HR backups}"
KEEP_DAYS="${KEEP_DAYS:-30}"

# Where the file goes, settled before the dump. Remotes are checked by name
# only - a name is no secret - so a wrong paste is plain from the log.
remotes="$(rclone listremotes --ask-password=false 2>/dev/null | grep -vx 'DEFAULT:' || true)"
listed="$(printf '%s' "$remotes" | tr '\n' ' ')"
if [ -z "$BACKUP_REMOTE" ]; then
  if [ "$(printf '%s\n' "$remotes" | grep -c .)" -ne 1 ]; then
    echo "::error::The RCLONE_CONFIG secret should hold one remote (it has: ${listed:-none}). With several, set the BACKUP_REMOTE variable to the one to use - see DEPLOYMENT.md, Daily backups"
    exit 1
  fi
  BACKUP_REMOTE="$remotes$BACKUP_FOLDER"
fi
if ! printf '%s\n' "$remotes" | grep -qxF "${BACKUP_REMOTE%%:*}:"; then
  echo "::error::The RCLONE_CONFIG secret has no remote called \"${BACKUP_REMOTE%%:*}\" (it has: ${listed:-none}). Paste all of rclone.conf, starting with its [name] line - see DEPLOYMENT.md, Daily backups"
  exit 1
fi
echo "Backups go to $BACKUP_REMOTE"

# A dump needs a direct connection: Neon's pooler (the "-pooler" host) runs in
# transaction mode, which pg_dump cannot use.
url="${DATABASE_URL/-pooler./.}"

# Prisma's own parameters (?schema=public and the like) mean nothing to
# pg_dump, which refuses them; everything else, such as sslmode, stays.
query=""
if [[ "$url" == *\?* ]]; then
  IFS='&' read -r -a params <<<"${url#*\?}"
  for param in "${params[@]}"; do
    case "${param%%=*}" in
      schema | pgbouncer | connection_limit | pool_timeout | socket_timeout | statement_cache_size | sslaccept) ;;
      *) query="${query:+$query&}$param" ;;
    esac
  done
fi
url="${url%%\?*}${query:+?$query}"

# pg_dump must be at least as new as the server.
major="$(psql "$url" --no-psqlrc -Atc 'show server_version_num' | cut -c1-2)"
bin="/usr/lib/postgresql/$major/bin"
if [ ! -x "$bin/pg_dump" ]; then
  echo "Installing the PostgreSQL $major client"
  sudo install -d /usr/share/postgresql-common/pgdg
  sudo curl -fsSL -o /usr/share/postgresql-common/pgdg/apt.postgresql.org.asc https://www.postgresql.org/media/keys/ACCC4CF8.asc
  echo "deb [signed-by=/usr/share/postgresql-common/pgdg/apt.postgresql.org.asc] https://apt.postgresql.org/pub/repos/apt $(lsb_release -cs)-pgdg main" |
    sudo tee /etc/apt/sources.list.d/pgdg.list >/dev/null
  sudo apt-get update -qq
  sudo apt-get install -y -qq "postgresql-client-$major" >/dev/null
fi

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
name="pollux-hr-$(date -u +%Y-%m-%d-%H%M).dump.gpg"

"$bin/pg_dump" "$url" --format=custom --file="$work/backup.dump"
# A dump that cannot list its own contents is not a backup.
"$bin/pg_restore" --list "$work/backup.dump" >/dev/null

# Encrypted before it leaves the machine: the file holds salaries and personal data.
gpg --batch --yes --quiet --pinentry-mode loopback --passphrase-fd 3 \
  --symmetric --cipher-algo AES256 --output "$work/$name" "$work/backup.dump" 3<<<"$BACKUP_PASSPHRASE"
rm "$work/backup.dump"

rclone copy "$work/$name" "$BACKUP_REMOTE"
rclone delete "$BACKUP_REMOTE" --include 'pollux-hr-*.dump.gpg' --min-age "${KEEP_DAYS}d"
echo "Uploaded $name ($(du -h "$work/$name" | cut -f1)); backups older than $KEEP_DAYS days removed."
