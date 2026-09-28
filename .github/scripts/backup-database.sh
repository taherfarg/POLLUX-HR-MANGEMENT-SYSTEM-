#!/usr/bin/env bash
# Backs up the Pollux HR database: dump, encrypt, upload, prune.
#
# Run every night by .github/workflows/backup.yml; setup and restore are in
# DEPLOYMENT.md, "Daily backups". It reads:
#   DATABASE_URL       the Neon connection string (the pooled one is fine - see below)
#   BACKUP_PASSPHRASE  the password each backup is encrypted with. Keep it somewhere
#                      safe: without it no backup can be opened.
#   BACKUP_REMOTE      where the file goes, in rclone's terms ("gdrive:Pollux HR backups")
#   KEEP_DAYS          backups older than this are deleted there (default 30)
# and an rclone config that defines the remote.
set -euo pipefail

: "${DATABASE_URL:?the BACKUP_DATABASE_URL secret is not set}"
: "${BACKUP_PASSPHRASE:?the BACKUP_PASSPHRASE secret is not set}"
: "${BACKUP_REMOTE:?no backup destination is set}"
KEEP_DAYS="${KEEP_DAYS:-30}"

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
