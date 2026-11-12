#!/bin/bash
# Draait elke minuut op de Pi (cron). Voegt nieuwe M1-opnames (*.kismet) uit ~/m1-rounds
# als bron toe aan de Kismet-server van de Pi, zodat Radar ze toont.
# De M1 uploadt eerst als *.part en hernoemt pas als het bestand compleet is.
set -u
DIR="$HOME/m1-rounds"
STATE="$DIR/.ingested"
STARTF="$DIR/.kismet-start"
KEEP=${KEEP:-12}            # zoveel recente rondes actief in Radar (~2 uur)
API="http://$(tailscale ip -4 | head -1):2501"
PW=$(grep httpd_password "$HOME/.kismet/kismet_httpd.conf" | cut -d= -f2)
mkdir -p "$DIR/archief"; touch "$STATE"

status=$(curl -s -m 5 -u "sam:$PW" "$API/system/status.json") || exit 0
start=$(printf '%s' "$status" | python3 -c 'import json,sys; print(json.load(sys.stdin)["kismet.system.timestamp.start_sec"])' 2>/dev/null) || exit 0
# Kismet herstart? Dan zijn alle bronnen weg: lijst opnieuw opbouwen.
if [ "$start" != "$(cat "$STARTF" 2>/dev/null)" ]; then : > "$STATE"; echo "$start" > "$STARTF"; fi

# Oudere opnames naar het archief (blijven bewaard voor analyse).
ls -1t "$DIR"/*.kismet 2>/dev/null | tail -n +$((KEEP + 1)) | while read -r f; do mv "$f" "$DIR/archief/"; done

for f in $(ls -1tr "$DIR"/*.kismet 2>/dev/null); do
  grep -qxF "$f" "$STATE" && continue
  name=$(basename "$f" .kismet | sed 's/-[0-9]\{8\}-[0-9-]*$//')
  if curl -s -m 20 -u "sam:$PW" --data-urlencode "json={\"definition\":\"$f:type=kismetdb,name=M1-$name\"}" \
       "$API/datasource/add_source.cmd" | grep -q '"kismet.datasource.uuid"'; then
    echo "$f" >> "$STATE"; echo "$(date '+%F %T') toegevoegd $f"
  else
    echo "$(date '+%F %T') toevoegen mislukt $f"
  fi
done
