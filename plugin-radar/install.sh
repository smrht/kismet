#!/bin/sh
# Koppelt de Radar-plugin aan je lokale Kismet (symlink, dus wijzigingen zijn direct live).
# Gebruik: sh plugin-radar/install.sh   — daarna Kismet herstarten.
set -e
HERE="$(cd "$(dirname "$0")" && pwd)"
mkdir -p "$HOME/.kismet/plugins"
ln -sfn "$HERE" "$HOME/.kismet/plugins/radar"
echo "Radar gekoppeld: $HOME/.kismet/plugins/radar -> $HERE"
echo "Herstart Kismet en open http://localhost:2501/plugin/radar/"
