#!/usr/bin/env bash
# Fetches the Visual C++ runtime the Windows installer lays down.
#
# Every PostgreSQL binary the app ships imports VCRUNTIME140.dll. Most Windows
# machines have it already — almost every desktop application installs it — but
# a clean install does not, and there the database fails to start with a dialog
# about a missing DLL that mentions no database and suggests no fix.
#
# Run once before `npm run build:win`. Microsoft's own installer is a no-op
# when a newer runtime is present, so shipping it costs nothing on a machine
# that does not need it.
set -euo pipefail
cd "$(dirname "$0")/.."

DEST="build/vc_redist.x64.exe"
if [ -f "$DEST" ]; then
  echo "▸ $DEST already present"
  exit 0
fi
mkdir -p build
echo "▸ downloading the Visual C++ 2015-2022 redistributable (~24 MB)"
curl -fL --progress-bar -o "$DEST" "https://aka.ms/vs/17/release/vc_redist.x64.exe"
echo "▸ done: $(du -h "$DEST" | cut -f1)"
