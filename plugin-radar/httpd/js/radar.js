// Radar — live dashboard voor Kismet (web-only plugin, same-origin REST API).
// Geen dependencies; alles hand-gebouwde SVG zodat het in elke Kismet-installatie draait.

const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const nf = new Intl.NumberFormat('nl-NL');
const fmt = (n) => nf.format(Math.round(n || 0));

// ---------------------------------------------------------------- state
const store = {
  get(k, d) { try { const v = localStorage.getItem('radar.' + k); return v === null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem('radar.' + k, JSON.stringify(v)); } catch { /* geen opslag */ } },
};

const S = {
  tab: 'overzicht',
  now: Math.floor(Date.now() / 1000),
  status: null, devices: [], alerts: [], sources: [], ifaces: [], pkt: null,
  privacy: store.get('privacy', false),
  band: store.get('band', '24'),
  secFilter: 'all', typeFilter: 'all', qAps: '', qDev: '',
  apSort: { k: 'signal', dir: -1 }, devSort: { k: 'last', dir: -1 },
  connected: false, loginOpen: false, tick: 0,
};

const TABS = {
  overzicht: ['Overzicht', 'Wat je radio nu om je heen ziet.'],
  netwerken: ['Netwerken', 'Alle access points met hun beveiliging en signaal.'],
  apparaten: ['Apparaten', 'Alles wat zendt: routers, telefoons, laptops, Bluetooth.'],
  alerts: ['Alerts', 'Meldingen van de ingebouwde inbraakdetectie (WIDS).'],
  bronnen: ['Bronnen', 'Waarmee Kismet luistert, en wat je kunt aanzetten.'],
};

// ---------------------------------------------------------------- API
class AuthError extends Error {}

async function api(path, body) {
  const opt = { credentials: 'same-origin', headers: {} };
  if (body !== undefined) {
    opt.method = 'POST';
    opt.headers['Content-Type'] = 'application/x-www-form-urlencoded';
    opt.body = new URLSearchParams({ json: JSON.stringify(body) });
  }
  const r = await fetch(path, opt);
  if (r.status === 401 || r.status === 403) throw new AuthError('auth');
  if (!r.ok) throw new Error(`${path} → HTTP ${r.status}`);
  const ct = r.headers.get('content-type') || '';
  return ct.includes('json') ? r.json() : r.text();
}

const DEVICE_FIELDS = [
  ['kismet.device.base.key', 'key'],
  ['kismet.device.base.macaddr', 'mac'],
  ['kismet.device.base.phyname', 'phy'],
  ['kismet.device.base.type', 'type'],
  ['kismet.device.base.commonname', 'name'],
  ['kismet.device.base.manuf', 'manuf'],
  ['kismet.device.base.crypt', 'crypt'],
  ['kismet.device.base.channel', 'channel'],
  ['kismet.device.base.frequency', 'freq'],
  ['kismet.device.base.first_time', 'first'],
  ['kismet.device.base.last_time', 'last'],
  ['kismet.device.base.packets.total', 'packets'],
  ['kismet.device.base.signal/kismet.common.signal.last_signal', 'signal'],
  ['kismet.device.base.num_alerts', 'nalerts'],
  ['dot11.device/dot11.device.num_associated_clients', 'clients'],
  ['dot11.device/dot11.device.num_probed_ssids', 'probes'],
  ['dot11.device/dot11.device.last_beaconed_ssid_record/dot11.advertisedssid.ssid', 'ssid'],
  ['dot11.device/dot11.device.last_beaconed_ssid_record/dot11.advertisedssid.cloaked', 'cloaked'],
  ['dot11.device/dot11.device.last_beaconed_ssid_record/dot11.advertisedssid.wpa_mfp_required', 'mfpReq'],
  ['dot11.device/dot11.device.last_beaconed_ssid_record/dot11.advertisedssid.wpa_mfp_supported', 'mfpSup'],
];

async function loadFast() {
  const [status, pkt, alerts, sources] = await Promise.all([
    api('/system/status.json'),
    api('/packetchain/packet_stats.json'),
    api('/alerts/last-time/0/alerts.json'),
    api('/datasource/all_sources.json'),
  ]);
  S.status = status;
  S.now = status['kismet.system.timestamp.sec'] || Math.floor(Date.now() / 1000);
  S.pkt = pkt;
  const list = Array.isArray(alerts) ? alerts : (alerts['kismet.alert.list'] || []);
  S.alerts = list.slice().sort((a, b) => (b['kismet.alert.timestamp'] || 0) - (a['kismet.alert.timestamp'] || 0));
  S.sources = Array.isArray(sources) ? sources : [];
}

async function loadDevices() {
  const rows = await api('/devices/views/all/devices.json', { fields: DEVICE_FIELDS });
  S.devices = (Array.isArray(rows) ? rows : []).map(enrich);
}

async function loadIfaces() {
  try { S.ifaces = await api('/datasource/list_interfaces.json'); } catch (e) { if (e instanceof AuthError) throw e; S.ifaces = []; }
}

// ---------------------------------------------------------------- domein
// Kismet's crypt_to_simple_string: "Open", "WEP40", "WPA2 WPA2-PSK", "WPA3 WPA3-PSK WPA3-SAE", …
const SEC = {
  open:  { label: 'Open',            tone: 'critical', icon: 'i-unlock', rank: 0 },
  wep:   { label: 'WEP',             tone: 'critical', icon: 'i-unlock', rank: 1 },
  wpa1:  { label: 'WPA (oud)',       tone: 'serious',  icon: 'i-warn',   rank: 2 },
  wpa2:  { label: 'WPA2',            tone: 'warning',  icon: 'i-lock',   rank: 3 },
  mixed: { label: 'WPA2/3 mix',      tone: 'good',     icon: 'i-lock',   rank: 4 },
  wpa3:  { label: 'WPA3',            tone: 'good',     icon: 'i-shield', rank: 5 },
  owe:   { label: 'Enhanced Open',   tone: 'good',     icon: 'i-shield', rank: 4 },
  unk:   { label: 'Onbekend',        tone: 'neutral',  icon: 'i-warn',   rank: -1 },
};
const TONE_COLOR = { good: 'var(--good)', warning: 'var(--warning)', serious: 'var(--serious)', critical: 'var(--critical)', neutral: 'var(--neutral)' };

function secClass(crypt) {
  const c = String(crypt || '').toUpperCase();
  if (!c) return 'unk';
  if (c === 'OPEN' || c === 'NONE') return 'open';
  if (c.startsWith('WEP')) return 'wep';
  if (c.includes('OWE')) return 'owe';
  if (c.includes('SAE') && c.includes('PSK')) return 'mixed';
  if (c.includes('WPA3') || c.includes('SAE')) return 'wpa3';
  if (c.includes('WPA2')) return 'wpa2';
  if (c.includes('WPA')) return 'wpa1';
  return 'unk';
}

// Locally administered bit (0x02 van het eerste octet) = willekeurig/zelfgekozen MAC.
function isRandomMac(mac) {
  const b = parseInt(String(mac || '').slice(0, 2), 16);
  return Number.isFinite(b) && (b & 0x02) === 0x02 && (b & 0x01) === 0;
}

function band(freqKhz, channel) {
  const f = Number(freqKhz) / 1000; // MHz
  if (f >= 5925) return '6';
  if (f >= 4900) return '5';
  if (f >= 2400) return '24';
  const ch = parseInt(channel, 10);
  if (ch >= 1 && ch <= 14) return '24';
  if (ch >= 32) return '5';
  return '';
}

function kind(d) {
  const t = String(d.type || '');
  const p = String(d.phy || '');
  if (t === 'Wi-Fi AP') return 'ap';
  if (/bluetooth|btle/i.test(p) || /^BR\/EDR|BTLE/i.test(t)) return 'bt';
  if (/^Wi-Fi/i.test(t) || p === 'IEEE802.11') return 'client';
  return 'other';
}

function enrich(d) {
  const o = {
    key: d.key, mac: d.mac || '', phy: d.phy || '', type: d.type || '', name: d.name || '',
    manuf: d.manuf || '', crypt: d.crypt || '', channel: d.channel || '', freq: d.freq || 0,
    first: d.first || 0, last: d.last || 0, packets: d.packets || 0, signal: d.signal || 0,
    nalerts: d.nalerts || 0, clients: d.clients || 0, probes: d.probes || 0,
    ssid: d.ssid || '', cloaked: !!d.cloaked, mfpReq: !!d.mfpReq, mfpSup: !!d.mfpSup,
  };
  o.kind = kind(o);
  o.sec = o.kind === 'ap' ? secClass(o.crypt) : null;
  o.random = isRandomMac(o.mac);
  o.band = band(o.freq, o.channel);
  if (o.manuf === 'Unknown') o.manuf = '';
  return o;
}

// ---------------------------------------------------------------- privacy
function maskMac(mac) {
  if (!S.privacy || !mac) return mac;
  const p = mac.split(':');
  return p.length === 6 ? `${p[0]}:${p[1]}:${p[2]}:••:••:••` : '••:••:••';
}
function maskText(s) {
  if (!S.privacy || !s) return s;
  return s.length <= 2 ? '••' : s.slice(0, 2) + '•'.repeat(Math.min(6, s.length - 2));
}
function maskInText(s) {
  if (!S.privacy) return s;
  return String(s).replace(/\b([0-9A-F]{2}:[0-9A-F]{2}:[0-9A-F]{2}):[0-9A-F]{2}:[0-9A-F]{2}:[0-9A-F]{2}\b/gi, '$1:••:••:••');
}

// ---------------------------------------------------------------- helpers
function ago(ts) {
  if (!ts) return '—';
  const s = Math.max(0, S.now - ts);
  if (s < 5) return 'nu';
  if (s < 60) return `${s} s`;
  if (s < 3600) return `${Math.floor(s / 60)} min`;
  if (s < 86400) return `${Math.floor(s / 3600)} u`;
  return `${Math.floor(s / 86400)} d`;
}

// RRD: vaste ring van 60 sec; index = epoch % 60. Waarden ouder dan last_time-59 of
// nieuwer dan last_time bestaan niet (Kismet vult lazy) en tellen als 0.
function rrdSeries(rrd, now) {
  if (!rrd) return [];
  const vec = rrd['kismet.common.rrd.minute_vec'] || [];
  const last = rrd['kismet.common.rrd.last_time'] || now;
  const out = [];
  for (let t = now - 59; t <= now; t++) {
    const inWindow = t <= last && t > last - 60;
    out.push({ t, v: inWindow ? (vec[t % 60] || 0) : 0 });
  }
  return out;
}

function niceMax(v) {
  if (v <= 0) return 4;
  const p = Math.pow(10, Math.floor(Math.log10(v)));
  for (const m of [1, 2, 2.5, 5, 10]) if (m * p >= v) return m * p;
  return 10 * p;
}

const tip = $('#tip');
function showTip(e, html) {
  tip.innerHTML = html; tip.hidden = false;
  const w = tip.offsetWidth, h = tip.offsetHeight;
  let x = e.clientX + 14, y = e.clientY - h - 12;
  if (x + w > innerWidth - 8) x = e.clientX - w - 14;
  if (y < 8) y = e.clientY + 16;
  tip.style.left = x + 'px'; tip.style.top = y + 'px';
}
function hideTip() { tip.hidden = true; }
document.addEventListener('pointermove', (e) => {
  const t = e.target.closest?.('[data-tip]');
  if (t) showTip(e, t.dataset.tip); else if (!e.target.closest?.('.chart')) hideTip();
});

// ---------------------------------------------------------------- charts
function lineChart(el, pts, unit) {
  const W = Math.max(320, el.clientWidth), H = el.clientHeight || 210;
  const m = { l: 40, r: 10, t: 10, b: 24 };
  const iw = W - m.l - m.r, ih = H - m.t - m.b;
  const max = niceMax(Math.max(...pts.map((p) => p.v), 0));
  const x = (i) => m.l + (i / Math.max(1, pts.length - 1)) * iw;
  const y = (v) => m.t + ih - (v / max) * ih;
  const ticks = [0, max / 2, max];
  const path = pts.map((p, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(p.v).toFixed(1)}`).join('');
  const area = `${path}L${x(pts.length - 1)},${y(0)}L${x(0)},${y(0)}Z`;
  el.innerHTML = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Pakketten per seconde, laatste 60 seconden">
    <g class="axis">${ticks.map((t) => `<line class="grid-line" x1="${m.l}" x2="${W - m.r}" y1="${y(t)}" y2="${y(t)}"/><text x="${m.l - 8}" y="${y(t) + 4}" text-anchor="end">${fmt(t)}</text>`).join('')}
      <text x="${x(0)}" y="${H - 6}">−60 s</text><text x="${x(29)}" y="${H - 6}" text-anchor="middle">−30 s</text><text x="${x(59)}" y="${H - 6}" text-anchor="end">nu</text></g>
    <path d="${area}" fill="var(--series-1-soft)"/>
    <path d="${path}" fill="none" stroke="var(--series-1)" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>
    <line class="xh" x1="0" x2="0" y1="${m.t}" y2="${m.t + ih}" stroke="var(--line-strong)" visibility="hidden"/>
    <circle class="xd" r="4.5" fill="var(--series-1)" stroke="var(--surface-1)" stroke-width="2" visibility="hidden"/>
    <rect x="${m.l}" y="${m.t}" width="${iw}" height="${ih}" fill="transparent" class="hit"/>
  </svg>`;
  const svg = el.firstElementChild, hit = $('.hit', svg), xh = $('.xh', svg), xd = $('.xd', svg);
  hit.addEventListener('pointermove', (e) => {
    const r = svg.getBoundingClientRect();
    const px = (e.clientX - r.left) * (W / r.width);
    const i = Math.max(0, Math.min(pts.length - 1, Math.round(((px - m.l) / iw) * (pts.length - 1))));
    xh.setAttribute('x1', x(i)); xh.setAttribute('x2', x(i)); xh.setAttribute('visibility', 'visible');
    xd.setAttribute('cx', x(i)); xd.setAttribute('cy', y(pts[i].v)); xd.setAttribute('visibility', 'visible');
    const sec = pts.length - 1 - i;
    showTip(e, `<div class="t">${sec ? `${sec} s geleden` : 'nu'}</div><div class="v">${fmt(pts[i].v)} ${unit}</div>`);
  });
  hit.addEventListener('pointerleave', () => { xh.setAttribute('visibility', 'hidden'); xd.setAttribute('visibility', 'hidden'); hideTip(); });
}

function columnChart(el, items, emptyText) {
  if (!items.length) { el.innerHTML = `<div class="empty"><span>${emptyText}</span></div>`; return; }
  const W = Math.max(320, el.clientWidth), H = el.clientHeight || 210;
  const m = { l: 34, r: 6, t: 18, b: 24 };
  const iw = W - m.l - m.r, ih = H - m.t - m.b;
  const max = niceMax(Math.max(...items.map((d) => d.v)));
  const slot = iw / items.length, bw = Math.max(4, Math.min(34, slot - 2));
  const y = (v) => m.t + ih - (v / max) * ih;
  const r = Math.min(4, bw / 2);
  const bars = items.map((d, i) => {
    const cx = m.l + slot * i + slot / 2, x0 = cx - bw / 2, top = y(d.v), h = m.t + ih - top;
    const shape = h <= 0 ? '' : h < r
      ? `<rect x="${x0}" y="${top}" width="${bw}" height="${h}" fill="var(--series-1)"/>`
      : `<path d="M${x0},${m.t + ih}V${top + r}Q${x0},${top} ${x0 + r},${top}H${x0 + bw - r}Q${x0 + bw},${top} ${x0 + bw},${top + r}V${m.t + ih}Z" fill="var(--series-1)"/>`;
    const lblEvery = items.length > 24 ? 3 : items.length > 14 ? 2 : 1;
    return `<g data-tip="${esc(d.tip)}">
      <rect x="${m.l + slot * i}" y="${m.t}" width="${slot}" height="${ih}" fill="transparent"/>${shape}
      ${d.top ? `<text x="${cx}" y="${top - 6}" text-anchor="middle" class="vlabel">${fmt(d.v)}</text>` : ''}
      ${i % lblEvery === 0 ? `<text x="${cx}" y="${H - 6}" text-anchor="middle">${esc(d.label)}</text>` : ''}</g>`;
  }).join('');
  el.innerHTML = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Kolomgrafiek">
    <g class="axis">${[0, max / 2, max].map((t) => `<line class="grid-line" x1="${m.l}" x2="${W - m.r}" y1="${y(t)}" y2="${y(t)}"/><text x="${m.l - 8}" y="${y(t) + 4}" text-anchor="end">${fmt(t)}</text>`).join('')}
    <line class="baseline" x1="${m.l}" x2="${W - m.r}" y1="${y(0)}" y2="${y(0)}"/>${bars}</g></svg>`;
  $$('.vlabel', el).forEach((t) => { t.style.fill = 'var(--text-secondary)'; t.style.fontWeight = 600; });
}

function hbars(el, items, emptyText) {
  if (!items.length) { el.innerHTML = `<div class="empty"><span>${emptyText}</span></div>`; return; }
  const max = Math.max(...items.map((d) => d.v), 1);
  el.innerHTML = `<div class="hbars">${items.map((d) => `
    <div class="hbar" data-tip="${esc(d.tip)}">
      <span class="name">${d.icon ? `<svg style="color:${d.color}"><use href="#${d.icon}"/></svg>` : ''}${esc(d.name)}</span>
      <span class="track"><span class="fill" style="width:${(d.v / max) * 100}%;background:${d.color || 'var(--series-1)'}"></span></span>
      <span class="num">${fmt(d.v)}</span>
    </div>`).join('')}</div>`;
}

// ---------------------------------------------------------------- views
function aps() { return S.devices.filter((d) => d.kind === 'ap'); }

function renderKpis() {
  const st = S.status || {};
  const all = S.devices, ap = aps();
  const clients = all.filter((d) => d.kind === 'client');
  const bt = all.filter((d) => d.kind === 'bt');
  const fresh = all.filter((d) => d.first && d.first > S.now - 300).length;
  const active = all.filter((d) => d.last && d.last > S.now - 60).length;
  const hidden = ap.filter((d) => d.cloaked || !d.ssid).length;
  const rnd = clients.length ? Math.round((clients.filter((d) => d.random).length / clients.length) * 100) : 0;
  const total = st['kismet.system.devices.count'] ?? all.length;
  const k = [
    ['i-radar', 'Apparaten', total, `+${fmt(fresh)} in 5 min`],
    ['i-wifi', 'Wi-Fi-netwerken', ap.length, `${fmt(hidden)} verborgen`],
    ['i-devices', 'Wi-Fi-clients', clients.length, clients.length ? `${rnd}% willekeurig MAC` : '—'],
    ['i-bt', 'Bluetooth', bt.length, bt.length ? 'BR/EDR + BLE' : 'geen bron actief'],
    ['i-eye', 'Actief (60 s)', active, `${fmt(all.reduce((s, d) => s + d.packets, 0))} pakketten`],
  ];
  $('#kpis').innerHTML = k.map(([ic, l, v, dl]) => `<div class="kpi"><div class="lbl"><svg><use href="#${ic}"/></svg>${l}</div><div class="val">${fmt(v)}</div><div class="delta">${esc(dl)}</div></div>`).join('');
  $('[data-count="aps"]').textContent = ap.length ? fmt(ap.length) : '';
  $('[data-count="devices"]').textContent = all.length ? fmt(all.length) : '';
  $('[data-count="alerts"]').textContent = S.alerts.length ? fmt(S.alerts.length) : '';
}

function renderOverview() {
  renderKpis();
  // pakketten/sec
  const pts = rrdSeries(S.pkt?.['kismet.packetchain.packets_rrd'], S.now);
  $('#pps-now').textContent = pts.length ? `nu ${fmt(pts[pts.length - 2]?.v || 0)}/s · piek ${fmt(Math.max(...pts.map((p) => p.v)))}/s` : '';
  lineChart($('#chart-pps'), pts, 'pakketten/s');

  // beveiliging
  const ap = aps();
  const counts = {};
  ap.forEach((d) => { counts[d.sec] = (counts[d.sec] || 0) + 1; });
  const order = ['wpa3', 'mixed', 'owe', 'wpa2', 'wpa1', 'wep', 'open', 'unk'];
  $('#sec-total').textContent = ap.length ? `${fmt(ap.length)} netwerken` : '';
  hbars($('#chart-sec'), order.filter((k) => counts[k]).map((k) => ({
    name: SEC[k].label, icon: SEC[k].icon, v: counts[k], color: TONE_COLOR[SEC[k].tone],
    tip: `<div class="t">${SEC[k].label}</div><div class="v">${fmt(counts[k])} netwerken · ${Math.round((counts[k] / ap.length) * 100)}%</div>`,
  })), 'Nog geen netwerken gezien. Start een bron onder <a href="#bronnen">Bronnen</a>.');

  // kanalen
  $$('#band-seg button').forEach((b) => b.classList.toggle('on', b.dataset.band === S.band));
  const byCh = {};
  ap.filter((d) => d.band === S.band).forEach((d) => { const c = String(d.channel || '?').split(/[^0-9]/)[0] || '?'; byCh[c] = (byCh[c] || 0) + 1; });
  const chans = Object.keys(byCh).sort((a, b) => Number(a) - Number(b));
  const base = S.band === '24' ? ['1', '2', '3', '4', '5', '6', '7', '8', '9', '10', '11', '12', '13'] : [];
  const keys = [...new Set([...base, ...chans])].sort((a, b) => Number(a) - Number(b));
  const peak = Math.max(0, ...Object.values(byCh));
  columnChart($('#chart-chan'), chans.length ? keys.map((c) => ({
    label: c, v: byCh[c] || 0, top: peak > 0 && byCh[c] === peak,
    tip: `<div class="t">Kanaal ${esc(c)}</div><div class="v">${fmt(byCh[c] || 0)} netwerken</div>`,
  })) : [], `Geen netwerken op ${S.band === '24' ? '2,4' : S.band} GHz gezien.`);

  // fabrikanten
  const man = {};
  S.devices.forEach((d) => { const k = d.manuf || (d.random ? 'Willekeurig MAC' : 'Onbekend'); man[k] = (man[k] || 0) + 1; });
  const top = Object.entries(man).sort((a, b) => b[1] - a[1]).slice(0, 7);
  hbars($('#chart-manuf'), top.map(([n, v]) => ({
    name: n, v, color: (n === 'Onbekend' || n === 'Willekeurig MAC') ? 'var(--neutral)' : 'var(--series-1)',
    tip: `<div class="t">${esc(n)}</div><div class="v">${fmt(v)} apparaten</div>`,
  })), 'Nog geen apparaten.');

  renderAlerts($('#alerts-mini'), S.alerts.slice(0, 5), true);
  renderSources($('#sources-mini'), true);
}

function sevTone(s) { return s >= 15 ? 'critical' : s >= 10 ? 'serious' : s >= 5 ? 'warning' : 'neutral'; }
function renderAlerts(el, list, compact) {
  if (!list.length) {
    el.innerHTML = `<li style="grid-template-columns:1fr"><div class="empty" style="min-height:${compact ? 90 : 200}px"><span><svg style="color:var(--good);width:22px;height:22px"><use href="#i-check"/></svg><br>Geen alerts. Kismet meldt hier deauth-aanvallen, nep-access points en spoofing.</span></div></li>`;
    return;
  }
  el.innerHTML = list.map((a) => {
    const tone = sevTone(a['kismet.alert.severity'] || 0);
    const ts = Math.floor(a['kismet.alert.timestamp'] || 0);
    return `<li><span class="sev badge b-${tone}" style="padding:0;width:22px;justify-content:center"><svg><use href="#${tone === 'neutral' ? 'i-bell' : 'i-warn'}"/></svg></span>
      <div><div class="hd">${esc(a['kismet.alert.header'] || 'ALERT')}</div><div class="tx">${esc(maskInText(a['kismet.alert.text'] || ''))}</div></div>
      <span class="tm" title="${esc(new Date(ts * 1000).toLocaleString('nl-NL'))}">${ago(ts)}</span></li>`;
  }).join('');
}

function srcState(s) {
  if (s['kismet.datasource.error']) return ['critical', 'Fout'];
  if (s['kismet.datasource.paused']) return ['warning', 'Gepauzeerd'];
  if (s['kismet.datasource.running']) return ['good', 'Actief'];
  return ['neutral', 'Gestopt'];
}
function renderSources(el, compact) {
  if (!S.sources.length) {
    el.innerHTML = `<li><div class="src-main"><div class="src-name">Geen actieve bron</div><div class="src-meta">Kismet vangt nog niets op.</div></div>${compact ? '<a class="btn small" href="#bronnen">Starten</a>' : ''}</li>`;
    return;
  }
  el.innerHTML = S.sources.map((s) => {
    const [tone, lbl] = srcState(s);
    const ch = s['kismet.datasource.hopping'] ? `hopt ${s['kismet.datasource.hop_rate'] || ''}/s` : `kanaal ${s['kismet.datasource.channel'] || '—'}`;
    const err = s['kismet.datasource.error'] ? ` · ${s['kismet.datasource.error_reason'] || ''}` : '';
    const uuid = s['kismet.datasource.uuid'];
    const act = compact ? '' : s['kismet.datasource.error']
      ? '<span class="src-meta" style="white-space:normal;max-width:180px;text-align:right">Verdwijnt na herstart van Kismet</span>'
      : (s['kismet.datasource.paused']
      ? `<button class="btn ghost small" data-src="resume" data-uuid="${esc(uuid)}"><svg><use href="#i-play"/></svg>Hervat</button>`
      : `<button class="btn ghost small" data-src="pause" data-uuid="${esc(uuid)}"><svg><use href="#i-pause"/></svg>Pauzeer</button>`);
    return `<li><span class="dot" style="background:${TONE_COLOR[tone]}"></span>
      <div class="src-main"><div class="src-name">${esc(s['kismet.datasource.name'] || s['kismet.datasource.interface'])} <span class="badge b-${tone}" style="margin-left:6px">${lbl}</span></div>
      <div class="src-meta">${esc(s['kismet.datasource.type_driver']?.['kismet.datasource.driver.type'] || s['kismet.datasource.hardware'] || '')} · ${esc(s['kismet.datasource.interface'] || '')} · ${esc(ch)} · ${fmt(s['kismet.datasource.num_packets'])} pakketten${esc(err)}</div></div>${act}</li>`;
  }).join('');
}

function renderIfaces() {
  const el = $('#ifaces');
  if (!S.ifaces.length) { el.innerHTML = '<li><div class="src-main"><div class="src-meta">Geen interfaces gevonden.</div></div></li>'; return; }
  el.innerHTML = S.ifaces.map((i) => {
    const name = i['kismet.datasource.probed.interface'];
    const hw = i['kismet.datasource.probed.hardware'] || i['kismet.datasource.type_driver']?.['kismet.datasource.driver.type'] || '';
    const used = i['kismet.datasource.probed.in_use_uuid'] && !/^0{8}-/.test(i['kismet.datasource.probed.in_use_uuid']);
    const unsupported = UNSUPPORTED_HW[hw];
    const action = used ? '<span class="badge b-good">In gebruik</span>'
      : unsupported ? `<span class="badge b-neutral" data-tip="${esc(unsupported)}">Niet geschikt</span>`
      : `<button class="btn small" data-add="${esc(name)}"><svg><use href="#i-play"/></svg>Start</button>`;
    return `<li><svg style="color:var(--text-muted)"><use href="#i-antenna"/></svg><div class="src-main"><div class="src-name">${esc(name)}</div><div class="src-meta">${esc(hw)}</div></div>${action}</li>`;
  }).join('');
  const hws = S.ifaces.map((i) => i['kismet.datasource.probed.hardware']);
  const notes = [];
  if (hws.includes('brcmfmac')) notes.push('De interne wifi van een Raspberry Pi (Broadcom, <code>brcmfmac</code>) kan niet meeluisteren zonder nexmon-patch. Sluit een USB-adapter met een MT7612U- of MT7921AU-chip aan; die verschijnt hier vanzelf.');
  if (hws.includes('osxcorewlan')) notes.push('Op macOS vangt <code>en0</code> via CoreWLAN, maar je Mac verliest dan zijn wifi-verbinding zolang de bron draait.');
  if (S.ifaces.some((i) => /hci|bluetooth/i.test(i['kismet.datasource.probed.hardware'] || ''))) notes.push('Bluetooth (<code>hci</code>) ziet telefoons, oordopjes, horloges en trackers in de buurt.');
  $('#iface-note').innerHTML = notes.join('<br><br>');
}
// Hardware die Kismet wel ziet maar niet in monitor mode krijgt (zonder extra patches).
const UNSUPPORTED_HW = {
  brcmfmac: 'Broadcom-chip van de Raspberry Pi: monitor mode alleen met nexmon-patch. Gebruik een USB-adapter (MT7612U/MT7921AU).',
};

// ---------- tabellen
function sortRows(rows, sort, getters) {
  const g = getters[sort.k];
  return rows.slice().sort((a, b) => {
    const x = g(a), y = g(b);
    return (typeof x === 'string' ? x.localeCompare(y, 'nl') : (x - y)) * sort.dir;
  });
}
function thead(cols, sort) {
  return `<thead><tr>${cols.map(([k, l, cls]) => `<th data-k="${k}" class="${cls || ''}" ${sort.k === k ? `aria-sort="${sort.dir > 0 ? 'ascending' : 'descending'}"` : ''}>${l}</th>`).join('')}</tr></thead>`;
}
function sigCell(dbm) {
  if (!dbm) return '<span class="muted">—</span>';
  const lvl = dbm >= -55 ? 5 : dbm >= -65 ? 4 : dbm >= -72 ? 3 : dbm >= -80 ? 2 : 1;
  return `<span class="sig"><span class="bars">${[1, 2, 3, 4, 5].map((n) => `<i class="${n <= lvl ? 'on' : ''}"></i>`).join('')}</span><b>${dbm} dBm</b></span>`;
}
function secBadge(k) { const s = SEC[k] || SEC.unk; return `<span class="badge b-${s.tone}"><svg><use href="#${s.icon}"/></svg>${s.label}</span>`; }

function chipRow(el, opts, cur, attr) {
  el.innerHTML = opts.map(([k, l, n]) => `<button type="button" class="chip ${cur === k ? 'on' : ''}" data-${attr}="${k}">${l}<span>${fmt(n)}</span></button>`).join('');
}

function renderAps() {
  const all = aps();
  const q = S.qAps.trim().toLowerCase();
  const secOpts = [['all', 'Alle', all.length], ...['open', 'wep', 'wpa1', 'wpa2', 'mixed', 'wpa3', 'owe'].map((k) => [k, SEC[k].label, all.filter((d) => d.sec === k).length]).filter((o) => o[2])];
  chipRow($('#sec-filter'), secOpts, S.secFilter, 'sec');
  let rows = all.filter((d) => (S.secFilter === 'all' || d.sec === S.secFilter) &&
    (!q || `${d.ssid} ${d.mac} ${d.manuf}`.toLowerCase().includes(q)));
  const G = { ssid: (d) => d.ssid || '~', mac: (d) => d.mac, sec: (d) => SEC[d.sec].rank, pmf: (d) => (d.mfpReq ? 2 : d.mfpSup ? 1 : 0), channel: (d) => parseInt(d.channel, 10) || 0, signal: (d) => d.signal || -999, clients: (d) => d.clients, manuf: (d) => d.manuf || '~', last: (d) => d.last };
  rows = sortRows(rows, S.apSort, G);
  const cols = [['ssid', 'SSID'], ['mac', 'BSSID'], ['sec', 'Beveiliging'], ['pmf', 'PMF'], ['channel', 'Kanaal', 'num'], ['signal', 'Signaal'], ['clients', 'Clients', 'num'], ['manuf', 'Fabrikant'], ['last', 'Laatst', 'num']];
  $('#t-aps').innerHTML = thead(cols, S.apSort) + '<tbody>' + (rows.length ? rows.map((d) => `<tr>
    <td class="ssid ${d.ssid ? '' : 'hidden'}">${d.ssid ? esc(maskText(d.ssid)) : 'verborgen'}</td>
    <td class="mono">${esc(maskMac(d.mac))}</td>
    <td>${secBadge(d.sec)}</td>
    <td>${d.mfpReq ? '<span class="badge b-good">Verplicht</span>' : d.mfpSup ? '<span class="badge b-neutral">Optioneel</span>' : '<span class="muted">—</span>'}</td>
    <td class="num mono">${esc(d.channel || '—')}</td>
    <td>${sigCell(d.signal)}</td>
    <td class="num mono">${fmt(d.clients)}</td>
    <td class="clip muted">${esc(d.manuf || '—')}</td>
    <td class="num mono">${ago(d.last)}</td></tr>`).join('') : `<tr class="table-empty"><td colspan="${cols.length}">${all.length ? 'Niets gevonden met dit filter.' : 'Nog geen netwerken. Start een bron onder Bronnen.'}</td></tr>`) + '</tbody>';
}

const KIND_LABEL = { ap: 'Access point', client: 'Wi-Fi-client', bt: 'Bluetooth', other: 'Overig' };
function renderDevices() {
  const all = S.devices;
  const q = S.qDev.trim().toLowerCase();
  const opts = [['all', 'Alle', all.length], ...['ap', 'client', 'bt', 'other'].map((k) => [k, KIND_LABEL[k], all.filter((d) => d.kind === k).length]).filter((o) => o[2]), ['random', 'Willekeurig MAC', all.filter((d) => d.random).length]];
  chipRow($('#type-filter'), opts, S.typeFilter, 'type');
  let rows = all.filter((d) => (S.typeFilter === 'all' || (S.typeFilter === 'random' ? d.random : d.kind === S.typeFilter)) &&
    (!q || `${d.mac} ${d.name} ${d.manuf} ${d.ssid}`.toLowerCase().includes(q)));
  const G = { type: (d) => d.type, mac: (d) => d.mac, name: (d) => d.name || '~', manuf: (d) => d.manuf || '~', channel: (d) => parseInt(d.channel, 10) || 0, signal: (d) => d.signal || -999, packets: (d) => d.packets, first: (d) => d.first, last: (d) => d.last };
  rows = sortRows(rows, S.devSort, G).slice(0, 1500);
  const cols = [['type', 'Type'], ['mac', 'MAC-adres'], ['name', 'Naam'], ['manuf', 'Fabrikant'], ['channel', 'Kanaal', 'num'], ['signal', 'Signaal'], ['packets', 'Pakketten', 'num'], ['first', 'Eerst', 'num'], ['last', 'Laatst', 'num']];
  $('#t-dev').innerHTML = thead(cols, S.devSort) + '<tbody>' + (rows.length ? rows.map((d) => {
    const nm = d.name && d.name !== d.mac ? maskText(d.name) : '';
    return `<tr>
    <td>${esc(d.type || KIND_LABEL[d.kind])}</td>
    <td class="mono">${esc(maskMac(d.mac))}${d.random ? ' <span class="badge b-neutral" title="Locally administered bit gezet: telefoon/laptop met MAC-randomisatie">random</span>' : ''}</td>
    <td class="clip">${nm ? esc(nm) : '<span class="muted">—</span>'}</td>
    <td class="clip muted">${esc(d.manuf || '—')}</td>
    <td class="num mono">${esc(d.channel || '—')}</td>
    <td>${sigCell(d.signal)}</td>
    <td class="num mono">${fmt(d.packets)}</td>
    <td class="num mono">${ago(d.first)}</td>
    <td class="num mono">${ago(d.last)}</td></tr>`;
  }).join('') : `<tr class="table-empty"><td colspan="${cols.length}">${all.length ? 'Niets gevonden met dit filter.' : 'Nog geen apparaten.'}</td></tr>`) + '</tbody>';
}

// ---------------------------------------------------------------- banner, live, render
function renderBanner() {
  const b = $('#banner');
  const running = S.sources.some((s) => s['kismet.datasource.running'] && !s['kismet.datasource.error']);
  const err = S.sources.find((s) => s['kismet.datasource.error']);
  if (err) {
    b.hidden = false;
    b.innerHTML = `<svg><use href="#i-warn"/></svg><span><strong>Bron ${esc(err['kismet.datasource.name'])} geeft een fout:</strong> ${esc(err['kismet.datasource.error_reason'] || 'onbekend')}</span>`;
  } else if (!running) {
    b.hidden = false;
    b.innerHTML = `<svg><use href="#i-warn"/></svg><span><strong>Kismet luistert nog niet.</strong> Start een bron onder <a href="#bronnen">Bronnen</a> (op je Mac: <code>en0</code>).</span>`;
  } else b.hidden = true;
}

function setLive(ok, text) {
  const l = $('#live'); l.classList.toggle('ok', ok); l.classList.toggle('err', !ok);
  $('#live-text').textContent = text;
}

function render() {
  renderBanner();
  if (S.tab === 'overzicht') renderOverview();
  else { renderKpis(); }
  if (S.tab === 'netwerken') renderAps();
  if (S.tab === 'apparaten') renderDevices();
  if (S.tab === 'alerts') renderAlerts($('#alerts-full'), S.alerts, false);
  if (S.tab === 'bronnen') { renderSources($('#sources-full'), false); renderIfaces(); }
  const v = S.status?.['kismet.system.version'];
  if (v) $('#version').textContent = `Kismet ${v}`;
}

function setTab(t) {
  if (!TABS[t]) t = 'overzicht';
  S.tab = t;
  $$('.tab').forEach((s) => { s.hidden = s.id !== 'tab-' + t; });
  $$('#nav a').forEach((a) => a.classList.toggle('on', a.dataset.tab === t));
  $('#page-title').textContent = TABS[t][0];
  $('#page-sub').textContent = TABS[t][1];
  document.title = `${TABS[t][0]} · Radar`;
  if (t === 'bronnen') loadIfaces().then(render).catch(onError);
  render();
}

function applyPrivacy() {
  const b = $('#privacy');
  b.setAttribute('aria-pressed', String(S.privacy));
  b.innerHTML = `<svg><use href="#${S.privacy ? 'i-eye-off' : 'i-eye'}"/></svg><span>${S.privacy ? 'Privacy aan' : 'Privacy uit'}</span>`;
}

// ---------------------------------------------------------------- login
function openLogin() {
  if (S.loginOpen) return;
  S.loginOpen = true;
  setLive(false, 'Login nodig');
  $('#login').showModal();
}
$('#login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = new FormData(e.target);
  const r = await fetch('/session/check_login', { credentials: 'same-origin', headers: { Authorization: 'Basic ' + btoa(`${f.get('u')}:${f.get('p')}`) } });
  if (r.ok) { $('#login-err').hidden = true; $('#login').close(); S.loginOpen = false; poll(true); }
  else $('#login-err').hidden = false;
});

// ---------------------------------------------------------------- events
window.addEventListener('hashchange', () => setTab(location.hash.slice(1)));
$('#privacy').addEventListener('click', () => { S.privacy = !S.privacy; store.set('privacy', S.privacy); applyPrivacy(); render(); });
$('#band-seg').addEventListener('click', (e) => { const b = e.target.closest('[data-band]'); if (!b) return; S.band = b.dataset.band; store.set('band', S.band); renderOverview(); });
$('#q-aps').addEventListener('input', (e) => { S.qAps = e.target.value; renderAps(); });
$('#q-dev').addEventListener('input', (e) => { S.qDev = e.target.value; renderDevices(); });
$('#sec-filter').addEventListener('click', (e) => { const c = e.target.closest('[data-sec]'); if (c) { S.secFilter = c.dataset.sec; renderAps(); } });
$('#type-filter').addEventListener('click', (e) => { const c = e.target.closest('[data-type]'); if (c) { S.typeFilter = c.dataset.type; renderDevices(); } });
function sortHandler(key, fn) {
  return (e) => {
    const th = e.target.closest('th[data-k]'); if (!th) return;
    const s = S[key]; const k = th.dataset.k;
    S[key] = s.k === k ? { k, dir: -s.dir } : { k, dir: ['ssid', 'mac', 'manuf', 'name', 'type'].includes(k) ? 1 : -1 };
    fn();
  };
}
$('#t-aps').addEventListener('click', sortHandler('apSort', renderAps));
$('#t-dev').addEventListener('click', sortHandler('devSort', renderDevices));
document.addEventListener('click', async (e) => {
  const add = e.target.closest('[data-add]');
  const src = e.target.closest('[data-src]');
  try {
    if (add) {
      add.disabled = true; add.textContent = 'Starten…';
      await api('/datasource/add_source.cmd', { definition: `${add.dataset.add}:name=${add.dataset.add}` });
      await Promise.all([loadFast(), loadIfaces()]); render();
    } else if (src) {
      src.disabled = true;
      await api(`/datasource/by-uuid/${src.dataset.uuid}/${src.dataset.src === 'pause' ? 'pause_source' : 'resume_source'}.cmd`, {});
      await loadFast(); render();
    }
  } catch (err) { onError(err); alertBanner(`Actie mislukt: ${err.message}`); }
});
function alertBanner(msg) { const b = $('#banner'); b.hidden = false; b.innerHTML = `<svg><use href="#i-warn"/></svg><span>${esc(msg)}</span>`; }
let rz; window.addEventListener('resize', () => { clearTimeout(rz); rz = setTimeout(render, 120); });

// ---------------------------------------------------------------- poll loop
function onError(e) {
  if (e instanceof AuthError) { openLogin(); return; }
  console.warn('[radar]', e);
  setLive(false, 'Geen verbinding');
}

let timer;
async function poll(force) {
  clearTimeout(timer);
  try {
    const jobs = [loadFast()];
    if (force || S.tick % 2 === 0 || S.tab === 'apparaten' || S.tab === 'netwerken') jobs.push(loadDevices());
    if (force && S.tab === 'bronnen') jobs.push(loadIfaces());
    await Promise.all(jobs);
    S.tick++;
    setLive(true, `Live · ${new Date(S.now * 1000).toLocaleTimeString('nl-NL')}`);
    render();
  } catch (e) { onError(e); }
  if (!S.loginOpen) timer = setTimeout(poll, document.hidden ? 10000 : 3000);
}
document.addEventListener('visibilitychange', () => { if (!document.hidden) poll(); });

applyPrivacy();
setTab(location.hash.slice(1) || 'overzicht');
poll(true);
