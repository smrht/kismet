#!/usr/bin/env bash
# Kismet + Radar op de Raspberry Pi (blackberry) als vaste sensor.
# Draai één keer:  sudo bash ~/kismet-pi-setup.sh
# - Kismet (officiële release-repo, Debian trixie)
# - draait als gebruiker 'blackberry' via systemd (kismet-radar.service)
# - webinterface alleen op het Tailscale-adres (niet op je LAN/internet)
# - Bluetooth via hci0; wifi via wlan0 als die monitor mode kan, anders later via USB-adapter
# - Radar-dashboard uit je fork (smrht/kismet, branch radar-dashboard)
set -euo pipefail

U=blackberry
H=/home/$U
TS_IP=$(tailscale ip -4 2>/dev/null | head -1 || true)
[ -n "$TS_IP" ] || { echo "Geen Tailscale-IP gevonden; is tailscale actief?"; exit 1; }
[ "$(id -u)" -eq 0 ] || { echo "Draai met sudo: sudo bash $0"; exit 1; }

echo "==> 1/6 Kismet-repo en pakketten"
rm -f /usr/share/keyrings/kismet-archive-keyring.gpg
wget -O - https://www.kismetwireless.net/repos/kismet-release.gpg.key --quiet \
  | gpg --dearmor | tee /usr/share/keyrings/kismet-archive-keyring.gpg >/dev/null
echo 'deb [signed-by=/usr/share/keyrings/kismet-archive-keyring.gpg] https://www.kismetwireless.net/repos/apt/release/trixie trixie main' \
  > /etc/apt/sources.list.d/kismet.list
apt-get update -q
DEBIAN_FRONTEND=noninteractive apt-get install -y -q kismet iw git

echo "==> 2/6 Rechten: alleen de capture-hulpjes worden suid-root"
groupadd -f kismet
for b in /usr/bin/kismet_cap_linux_wifi /usr/bin/kismet_cap_linux_bluetooth; do
  [ -f "$b" ] && chown root:kismet "$b" && chmod 4750 "$b"
done
usermod -aG kismet "$U"

echo "==> 3/6 Test: kan de interne wifi (wlan0) in monitor mode?"
WIFI_SRC=""
if iw phy phy0 interface add radartest0 type monitor 2>/dev/null; then
  iw dev radartest0 del || true
  WIFI_SRC="source=wlan0:name=Pi-wifi"
  echo "    Ja: wlan0 wordt als wifi-bron gebruikt."
else
  echo "    Nee (normaal voor de Broadcom-chip van de Pi). Wifi volgt met een USB-adapter (MT7612U/MT7921AU)."
fi
# Een al aangesloten USB-adapter met monitor mode? Dan die gebruiken.
for d in /sys/class/net/wlx* /sys/class/net/wlan1; do
  [ -e "$d" ] || continue
  n=$(basename "$d"); WIFI_SRC="source=$n:name=USB-wifi"; echo "    USB-adapter gevonden: $n"
done

echo "==> 4/6 Configuratie"
install -d -o "$U" -g "$U" "$H/.kismet" "$H/kismet-logs"
cat > /etc/kismet/kismet_site.conf <<EOF
# Beheerd door kismet-pi-setup.sh
httpd_bind_address=$TS_IP
log_prefix=$H/kismet-logs/
source=hci0:name=Bluetooth
$WIFI_SRC
EOF
if [ ! -f "$H/.kismet/kismet_httpd.conf" ]; then
  # Eindige pijp (geen SIGPIPE), anders breekt 'set -o pipefail' het script af.
  PW=$(head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n' | cut -c1-24)
  printf 'httpd_username=sam\nhttpd_password=%s\n' "$PW" > "$H/.kismet/kismet_httpd.conf"
  chown "$U:$U" "$H/.kismet/kismet_httpd.conf"; chmod 600 "$H/.kismet/kismet_httpd.conf"
fi

echo "==> 5/6 Radar-dashboard uit je fork"
if [ ! -d "$H/kismet-radar/.git" ]; then
  sudo -u "$U" git clone -q --depth 1 --branch radar-dashboard --filter=blob:none --sparse \
    https://github.com/smrht/kismet.git "$H/kismet-radar"
  sudo -u "$U" git -C "$H/kismet-radar" sparse-checkout set plugin-radar
else
  sudo -u "$U" git -C "$H/kismet-radar" pull -q
fi
install -d -o "$U" -g "$U" "$H/.kismet/plugins"
sudo -u "$U" ln -sfn "$H/kismet-radar/plugin-radar" "$H/.kismet/plugins/radar"

echo "==> 6/6 Systemd-service"
systemctl disable --now kismet.service 2>/dev/null || true
cat > /etc/systemd/system/kismet-radar.service <<EOF
[Unit]
Description=Kismet sensor met Radar-dashboard
After=network-online.target tailscaled.service
Wants=network-online.target tailscaled.service

[Service]
User=$U
Group=$U
SupplementaryGroups=kismet
WorkingDirectory=$H
ExecStart=/usr/bin/kismet --no-line-wrap
Restart=on-failure
RestartSec=10

[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
systemctl enable --now kismet-radar.service
sleep 6
systemctl --no-pager --lines=0 status kismet-radar.service | head -3

echo
echo "Klaar. Open op je Mac:  http://$TS_IP:2501/plugin/radar/index.html"
echo "Login: sam / $(grep httpd_password "$H/.kismet/kismet_httpd.conf" | cut -d= -f2)"
