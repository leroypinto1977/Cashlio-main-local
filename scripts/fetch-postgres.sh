#!/usr/bin/env bash
# Fetches the PostgreSQL runtime the packaged app ships with.
#
# The app cannot ask somebody to install PostgreSQL before they can open it, so
# a copy travels inside the installer. These are the official EnterpriseDB
# binary distributions — the same builds their installers lay down — pruned to
# what actually runs: the server, the client tools the backup path shells out
# to, and the libraries and locale data they need.
#
#   ./scripts/fetch-postgres.sh darwin    → resources/postgres/darwin
#   ./scripts/fetch-postgres.sh win32     → resources/postgres/win32
#
# Run once per platform before `npm run build:mac` / `build:win`. The result is
# large and deliberately not committed.
set -euo pipefail
cd "$(dirname "$0")/.."

PG_VERSION="${PG_VERSION:-16.4-1}"
PLATFORM="${1:-}"

case "$PLATFORM" in
  darwin) ARCHIVE="postgresql-${PG_VERSION}-osx-binaries.zip" ;;
  win32)  ARCHIVE="postgresql-${PG_VERSION}-windows-x64-binaries.zip" ;;
  linux)  ARCHIVE="postgresql-${PG_VERSION}-linux-x64-binaries.tar.gz" ;;
  *) echo "usage: $0 darwin|win32|linux" >&2; exit 1 ;;
esac

DEST="resources/postgres/${PLATFORM}"
if [ -x "${DEST}/bin/postgres" ] || [ -x "${DEST}/bin/postgres.exe" ]; then
  echo "▸ ${DEST} already present — delete it to re-fetch"
  exit 0
fi

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

echo "▸ downloading ${ARCHIVE} (a few hundred MB)"
curl -fL --progress-bar -o "${TMP}/pg.archive" "https://get.enterprisedb.com/postgresql/${ARCHIVE}"

echo "▸ extracting"
case "$ARCHIVE" in
  *.zip)     unzip -q "${TMP}/pg.archive" -d "${TMP}/x" ;;
  *.tar.gz)  mkdir -p "${TMP}/x" && tar -xzf "${TMP}/pg.archive" -C "${TMP}/x" ;;
esac
SRC="${TMP}/x/pgsql"
[ -d "$SRC" ] || SRC="$(find "${TMP}/x" -maxdepth 2 -type d -name pgsql | head -1)"
[ -d "$SRC" ] || { echo "could not find pgsql/ inside the archive" >&2; exit 1; }

echo "▸ pruning to the runtime"
rm -rf "$DEST"
mkdir -p "${DEST}/bin"

# Only what the app actually invokes. pg_dump and psql are not optional: the
# backup and restore path shells out to them, and shipping a database without
# them produces backups that silently never run.
KEEP="postgres initdb pg_ctl psql pg_dump pg_restore pg_isready"

if [ "$PLATFORM" = "win32" ]; then
  # Windows keeps the runtime DLLs beside the executables rather than in lib/,
  # so bin/ has to travel whole. Copying only the .exe files leaves every one
  # of them unable to start — libpq.dll, the SSL libraries and the rest all
  # live here, and the failure is a dialog about a missing DLL rather than
  # anything that names the database.
  cp -p "${SRC}"/bin/*.dll "${DEST}/bin/" 2>/dev/null || true
  for b in $KEEP; do
    [ -f "${SRC}/bin/${b}.exe" ] && cp -p "${SRC}/bin/${b}.exe" "${DEST}/bin/"
  done
else
  for b in $KEEP; do
    [ -f "${SRC}/bin/${b}" ] && cp -p "${SRC}/bin/${b}" "${DEST}/bin/"
  done
fi

# Shared libraries and the locale/timezone data the server refuses to start
# without. `share` is the expensive one and cannot be dropped: initdb reads its
# template SQL from there.
cp -R "${SRC}/lib" "${DEST}/lib"
cp -R "${SRC}/share" "${DEST}/share"
# Documentation, headers and static archives are not needed at runtime.
# pgxs is the extension build system — makefiles, headers and test binaries.
# None of it runs here, and on macOS every executable in the bundle has to be
# signed, so a stray test binary is one more thing to fail on.
rm -rf "${DEST}/share/doc" "${DEST}/share/man" "${DEST}/include" \
       "${DEST}/lib/pkgconfig" "${DEST}/lib/postgresql/pgxs" 2>/dev/null || true
find "${DEST}/lib" -name '*.a' -delete 2>/dev/null || true

echo "▸ done: $(du -sh "$DEST" | cut -f1) in ${DEST}"
ls "${DEST}/bin"
