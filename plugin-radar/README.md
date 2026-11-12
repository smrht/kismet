# Radar — dashboard-plugin voor Kismet

Radar is een web-only Kismet-plugin: geen C++, geen build-stap. Kismet serveert
`httpd/` zelf op `/plugin/radar/`, dus het dashboard draait op dezelfde origin en
gebruikt dezelfde login (sessiecookie `KISMET`) als de standaard-UI.

## Installeren

```sh
sh plugin-radar/install.sh      # symlink naar ~/.kismet/plugins/radar
# Kismet herstarten
open http://localhost:2501/plugin/radar/
```

## Wat erin zit

| Tab | Inhoud | API |
|---|---|---|
| Overzicht | KPI's, pakketten/sec (60 s), beveiliging van netwerken, netwerken per kanaal, top-fabrikanten, laatste alerts, bronnen | `/system/status.json`, `/packetchain/packet_stats.json`, `/devices/views/all/devices.json`, `/alerts/last-time/…`, `/datasource/all_sources.json` |
| Netwerken | Alle access points: SSID, BSSID, beveiliging, PMF, kanaal, signaal, clients | view `phydot11_accesspoints` |
| Apparaten | Alle apparaten met filter op type, herkenning van willekeurige MAC-adressen | view `all` |
| Alerts | WIDS-meldingen (deauth, spoofing, kanaalwissel…) | `/alerts/last-time/…` |
| Bronnen | Capture-bronnen starten/pauzeren, interfaces | `/datasource/*` |

**Privacymodus** (knop rechtsboven) maskeert de laatste drie octetten van elk
MAC-adres en het grootste deel van elke SSID. Gebruik die voor screenshots:
MAC-adressen zijn persoonsgegevens onder de AVG.

## Leerpunten (informatica)

- *Locally administered bit*: is bit 1 van het eerste octet gezet
  (tweede hex-teken 2, 6, A of E), dan is het MAC-adres niet door de fabrikant
  uitgegeven maar willekeurig gekozen. Zo herkent Radar telefoons met
  MAC-randomisatie.
- *RRD-ringbuffer*: Kismet bewaart pakketaantallen in een vaste array van 60
  seconden waarin index = tijd mod 60. `radar.js` (`rrdSeries`) zet die ring om
  naar een tijdreeks.
- *Same-origin*: omdat de plugin van Kismet zelf komt, zijn CORS en
  API-sleutels in de browser niet nodig.
