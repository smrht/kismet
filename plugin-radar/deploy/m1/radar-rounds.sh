#!/bin/bash
# Radar-scanrondes op de M1.
# De interne wifi kan alleen luisteren als hij niet verbonden is, dus:
#   1. SCAN  : Kismet luistert SCAN_SECONDS met en0 (M1 is dan offline)
#   2. TERUG : wifi opnieuw verbinden, wachten tot Tailscale er weer is
#   3. TONEN : Kismet speelt de laatste KEEP_ROUNDS opnames af; Radar op het Tailscale-IP
# Gebruik:  radar-rounds.sh loop | once | view | stop | back
set -u
export PATH=/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin
LAB="$HOME/kismet-lab"
ROUNDS="$LAB/rounds"
SCAN_SECONDS=${SCAN_SECONDS:-600}
VIEW_SECONDS=${VIEW_SECONDS:-900}
KEEP_ROUNDS=${KEEP_ROUNDS:-6}
KEEP_DAYS=${KEEP_DAYS:-14}
HOME_SSID=${HOME_SSID:-DECO}
LOG="$LAB/logs/rounds.log"
mkdir -p "$ROUNDS" "$LAB/logs"

log() { echo "$(date '+%F %T') $*" >> "$LOG"; }

stop_kismet() {
  pkill -INT -x kismet 2>/dev/null
  for _ in $(seq 1 90); do pgrep -x kismet >/dev/null || return 0; sleep 1; done
  log "kismet stopte niet binnen 90s, hard stoppen"
  pkill -KILL -x kismet 2>/dev/null; sleep 2
}

# Het capture-programma draait als root (setuid) en houdt en0 in luistermodus.
# Pas als het weg is, kan de wifi weer verbinden.
release_radio() {
  for _ in $(seq 1 20); do pgrep -x kismet_cap_osx_corewlan_wifi >/dev/null || return 0; sleep 1; done
  log "capture-programma hing nog, stoppen via sudo-regel"
  sudo -n /usr/bin/killall kismet_cap_osx_corewlan_wifi 2>/dev/null; sleep 2
}

ts_ip() {
  for t in /Applications/Tailscale.app/Contents/MacOS/Tailscale /opt/homebrew/bin/tailscale /usr/local/bin/tailscale; do
    if [ -x "$t" ]; then "$t" ip -4 2>/dev/null | head -1; return; fi
  done
}

online() { ipconfig getifaddr en0 >/dev/null 2>&1 && [ -n "$(ts_ip)" ]; }

wifi_back() {
  release_radio
  sudo -n /usr/sbin/networksetup -setairportpower en0 off 2>/dev/null || networksetup -setairportpower en0 off
  sleep 3
  sudo -n /usr/sbin/networksetup -setairportpower en0 on 2>/dev/null || networksetup -setairportpower en0 on
  for _ in $(seq 1 25); do online && { log "weer online"; return 0; }; sleep 2; done
  log "niet vanzelf verbonden, expliciet naar $HOME_SSID"
  sudo -n /usr/sbin/networksetup -setairportnetwork en0 "$HOME_SSID" 2>>"$LOG"
  for _ in $(seq 1 40); do online && { log "weer online (na expliciet verbinden)"; return 0; }; sleep 2; done
  return 1
}

scan_round() {
  local name; name="ronde-$(date +%Y%m%d-%H%M)"
  printf 'httpd_bind_address=127.0.0.1\nlog_prefix=%s/\nlog_types=kismet\n' "$ROUNDS" > "$LAB/scan.conf"
  log "scan start $name (${SCAN_SECONDS}s, M1 offline)"
  kismet --no-line-wrap --override "$LAB/scan.conf" -c "en0:name=M1-wifi" -t "$name" \
    >> "$LAB/logs/kismet-scan.log" 2>&1 < /dev/null &
  sleep "$SCAN_SECONDS" & wait $!
  stop_kismet
  log "scan klaar $name"
}

view() {
  local ip; ip=$(ts_ip)
  [ -n "$ip" ] || { log "geen Tailscale-IP, viewer niet gestart"; return 1; }
  local srcs=() n=0
  while IFS= read -r f; do
    [ -n "$f" ] || continue
    srcs+=(-c "$f:type=kismetdb,name=$(basename "$f" .kismet)"); n=$((n + 1))
  done < <(ls -1t "$ROUNDS"/*.kismet 2>/dev/null | head -n "$KEEP_ROUNDS")
  printf 'httpd_bind_address=%s\n' "$ip" > "$LAB/view.conf"
  log "viewer op http://$ip:2501/plugin/radar/index.html met $n opname(s)"
  kismet --no-line-wrap --override "$LAB/view.conf" -n ${srcs[@]+"${srcs[@]}"} \
    >> "$LAB/logs/kismet-view.log" 2>&1 < /dev/null &
}

cleanup() { find "$ROUNDS" -name '*.kismet*' -mtime +"$KEEP_DAYS" -delete 2>/dev/null; }

case "${1:-loop}" in
  once) stop_kismet; scan_round; wifi_back || log "wifi kwam niet terug"; view ;;
  view) stop_kismet; view ;;
  stop) stop_kismet; release_radio; log "gestopt" ;;
  back) stop_kismet; wifi_back ;;
  loop)
    trap 'stop_kismet; wifi_back; exit 0' TERM INT
    while true; do
      stop_kismet; scan_round
      wifi_back || log "wifi kwam niet terug"
      cleanup; view
      sleep "$VIEW_SECONDS" & wait $!
    done ;;
  *) echo "gebruik: $0 loop|once|view|stop|back"; exit 2 ;;
esac
