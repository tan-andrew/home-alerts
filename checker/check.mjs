// Home Alerts checker.
// Reads public UK feeds for the places in config.json, writes site/status.json
// for the phone page, and sends a push notification (via ntfy) for anything new.
// Runs on GitHub Actions every 15 minutes. Needs Node 18 or newer, no packages.

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = path.join(ROOT, 'site');
const cfg = JSON.parse(await fs.readFile(path.join(ROOT, 'config.json'), 'utf8'));
const T = cfg.thresholds || {};
const N = cfg.notifications || {};
const NOW = new Date();
const UA = { 'User-Agent': 'home-alerts/1.0 (self-hosted personal alerts)', Accept: '*/*' };

// ---------- helpers ----------

const FIXTURES = process.env.FIXTURES; // test mode: read canned responses from a folder
async function get(url, type = 'json') {
  if (FIXTURES) {
    const key = url.replace(/^https?:\/\//, '').replace(/[^a-z0-9]+/gi, '_').slice(0, 150);
    const file = path.join(FIXTURES, key + (type === 'json' ? '.json' : '.txt'));
    const body = await fs.readFile(file, 'utf8').catch(() => { throw new Error('no fixture ' + key); });
    return type === 'json' ? JSON.parse(body) : body;
  }
  let lastErr;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const r = await fetch(url, { headers: UA, signal: AbortSignal.timeout(20000) });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return type === 'json' ? await r.json() : await r.text();
    } catch (e) { lastErr = e; await new Promise(s => setTimeout(s, 2000)); }
  }
  throw lastErr;
}

const londonParts = (d = NOW) => Object.fromEntries(
  new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/London', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23' })
    .formatToParts(d).map(p => [p.type, p.value]));
const LP = londonParts();
const TODAY = `${LP.year}-${LP.month}-${LP.day}`;
const MONTH = Number(LP.month);
const HOUR = Number(LP.hour);

const decode = s => s
  .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
  .replace(/<[^>]+>/g, ' ')
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'")
  .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(n)).replace(/&amp;/g, '&')
  .replace(/\s+/g, ' ').trim();
const tag = (xml, name) => { const m = xml.match(new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`, 'i')); return m ? decode(m[1]) : ''; };
const levelFromText = t => (/\bred\b/i.test(t) ? 'red' : /\bamber\b/i.test(t) ? 'amber' : /\byellow\b/i.test(t) ? 'yellow' : 'info');
const RANK = { red: 4, amber: 3, yellow: 2, info: 1 };

const active = cfg.locations.filter(l => !l.months || l.months.includes(MONTH));
const sources = {};
const alerts = [];
function add(a) {
  const existing = alerts.find(x => x.id === a.id);
  if (existing) { for (const p of a.places) if (!existing.places.includes(p)) existing.places.push(p); return; }
  alerts.push(a);
}
async function source(name, fn) {
  try { await fn(); sources[name] = { ok: true, checkedAt: NOW.toISOString() }; }
  catch (e) { sources[name] = { ok: false, checkedAt: NOW.toISOString(), error: String(e.message || e) }; console.error(`[${name}]`, e.message || e); }
}
const placesFor = pred => active.filter(pred).map(l => l.name);

// ---------- 1. Met Office severe weather warnings (official) ----------

await source('Met Office warnings', async () => {
  for (const region of [...new Set(active.map(l => l.metOfficeRegion).filter(Boolean))]) {
    const xml = await get(`https://weather.metoffice.gov.uk/public/data/PWSCache/WarningsRSS/Region/${region}`, 'text');
    if (!/<rss|<channel/i.test(xml)) throw new Error('unexpected reply');
    for (const [, item] of xml.matchAll(/<item>([\s\S]*?)<\/item>/gi)) {
      const title = tag(item, 'title');
      const detail = tag(item, 'description');
      const guid = tag(item, 'guid') || tag(item, 'link') || title;
      add({
        id: 'metoffice:' + guid,
        source: 'Met Office',
        official: true,
        level: levelFromText(title),
        title,
        detail,
        places: placesFor(l => l.metOfficeRegion === region),
        url: tag(item, 'link') || 'https://weather.metoffice.gov.uk/warnings-and-advice/uk-warnings',
      });
    }
  }
});

// ---------- 2. Environment Agency flood warnings (official, England) ----------

const FLOOD = { 1: ['red', 'Severe flood warning'], 2: ['amber', 'Flood warning'], 3: ['yellow', 'Flood alert'] };
await source('Environment Agency floods', async () => {
  for (const l of active) {
    const data = await get(`https://environment.data.gov.uk/flood-monitoring/id/floods?lat=${l.lat}&long=${l.lon}&dist=${l.floodRadiusKm || 5}`);
    for (const f of data.items || []) {
      const sev = FLOOD[f.severityLevel];
      if (!sev) continue; // 4 = no longer in force
      const areaId = f.floodAreaID || (f.floodArea && f.floodArea.notation) || '';
      add({
        id: `ea:${areaId}:${f.severityLevel}`,
        source: 'Environment Agency',
        official: true,
        level: sev[0],
        title: `${sev[1]}: ${f.description || f.eaAreaName || 'area near ' + l.name}`,
        detail: (f.message || '').replace(/\s+/g, ' ').trim().slice(0, 600),
        places: [l.name],
        url: areaId ? `https://check-for-flooding.service.gov.uk/target-area/${areaId}` : 'https://check-for-flooding.service.gov.uk/',
        since: f.timeRaised || f.timeSeverityChanged,
      });
    }
  }
});

// ---------- 3. UKHSA cold and heat health alerts (official, England) ----------
// This endpoint feeds the UKHSA dashboard. It is public but not formally documented,
// so the page marks it as best effort if it stops answering.

await source('UKHSA health alerts', async () => {
  for (const code of [...new Set(active.map(l => l.healthRegion).filter(Boolean))]) {
    for (const kind of ['cold', 'heat']) {
      const a = await get(`https://ukhsa-dashboard.data.gov.uk/api/proxy/alerts/v1/${kind}/${code}`);
      const status = String(a.status || '').toLowerCase();
      if (!['yellow', 'amber', 'red'].includes(status)) continue;
      const word = kind === 'cold' ? 'Cold' : 'Heat';
      add({
        id: `ukhsa:${kind}:${code}:${status}:${a.period_start || ''}`,
        source: 'UKHSA',
        official: true,
        level: status,
        title: `${status[0].toUpperCase() + status.slice(1)} ${word.toLowerCase()} health alert, ${a.geography_name || 'your region'}`,
        detail: (a.text || '').replace(/\s+/g, ' ').trim().slice(0, 600),
        places: placesFor(l => l.healthRegion === code),
        url: `https://ukhsa-dashboard.data.gov.uk/weather-health-alerts/${kind}`,
        start: a.period_start, end: a.period_end,
        forVulnerable: true,
      });
    }
  }
});

// ---------- 4. Forecast heads-ups from Open-Meteo (not official) ----------

const forecasts = {};
await source('Forecast (Open-Meteo)', async () => {
  for (const l of active) {
    const f = await get(`https://api.open-meteo.com/v1/forecast?latitude=${l.lat}&longitude=${l.lon}` +
      '&daily=temperature_2m_min,temperature_2m_max,wind_gusts_10m_max,snowfall_sum,precipitation_sum,weather_code' +
      '&forecast_days=3&timezone=Europe%2FLondon&wind_speed_unit=mph');
    const d = f.daily;
    const days = d.time.map((date, i) => ({
      date, min: d.temperature_2m_min[i], max: d.temperature_2m_max[i], gust: d.wind_gusts_10m_max[i],
      snow: d.snowfall_sum[i], rain: d.precipitation_sum[i], code: d.weather_code[i],
    }));
    forecasts[l.id] = days;
    for (const day of days) {
      const when = day.date === TODAY ? 'today' : new Date(day.date + 'T12:00:00Z').toLocaleDateString('en-GB', { weekday: 'long', timeZone: 'UTC' });
      const heads = []; // [kind, title, onlyThisPlace]
      const who = l.who ? ` (${l.who})` : '';
      if (T.gustMph && day.gust >= T.gustMph) heads.push(['wind', `Gusts up to ${Math.round(day.gust)} mph ${when}`]);
      if (T.snowCm && day.snow >= T.snowCm) heads.push(['snow', `About ${Math.round(day.snow)} cm of snow ${when}`]);
      if (T.rainMm && day.rain >= T.rainMm) heads.push(['rain', `About ${Math.round(day.rain)} mm of rain ${when}`]);
      if (T.coldC != null && day.min <= T.coldC) heads.push(['cold', `Down to ${Math.round(day.min)}°C ${when}`]);
      if (T.hotC != null && day.max >= T.hotC) heads.push(['hot', `Up to ${Math.round(day.max)}°C ${when}`]);
      if (l.vulnerable && T.coldC != null && day.min <= T.coldC) heads.push(['call-cold', `${l.name}${who}: down to ${Math.round(day.min)}°C ${when}. Worth a call to check the heating is on.`, true]);
      if (l.vulnerable && T.hotC != null && day.max >= T.hotC) heads.push(['call-hot', `${l.name}${who}: up to ${Math.round(day.max)}°C ${when}. Worth a call to check they are keeping cool.`, true]);
      if (l.rabbitChecks && T.rabbitFrostC != null && day.min <= T.rabbitFrostC) heads.push(['rabbits-frost', `Frost for the rabbits ${when} (${Math.round(day.min)}°C). Check water bottles and bedding.`, true]);
      if (l.rabbitChecks && T.rabbitHeatC != null && day.max >= T.rabbitHeatC) heads.push(['rabbits-heat', `Warm for the rabbits ${when} (${Math.round(day.max)}°C). Shade and extra water.`, true]);
      for (const [kind, title, own] of heads) add({
        id: own ? `forecast:${l.id}:${kind}:${day.date}` : `forecast:${kind}:${day.date}`,
        source: 'Forecast', official: false, level: 'info',
        title, detail: '', places: [l.name],
        url: `https://weather.metoffice.gov.uk/forecast/search?q=${encodeURIComponent(l.name)}`,
      });
    }
  }
});

// ---------- 5. Air quality heads-up from Open-Meteo (not official) ----------

await source('Air quality (Open-Meteo)', async () => {
  if (!T.airQualityEAQI) return;
  for (const l of active.filter(l => l.id === active[0].id || l.vulnerable)) {
    const q = await get(`https://air-quality-api.open-meteo.com/v1/air-quality?latitude=${l.lat}&longitude=${l.lon}&hourly=european_aqi&forecast_days=2&timezone=Europe%2FLondon`);
    const vals = (q.hourly?.european_aqi || []).slice(0, 24).filter(v => v != null);
    const worst = vals.length ? Math.max(...vals) : 0;
    if (worst >= T.airQualityEAQI) add({
      id: `air:${l.id}:${TODAY}`, source: 'Forecast', official: false, level: 'info',
      title: `${l.name}: poor air quality expected in the next 24 hours (index ${Math.round(worst)})`,
      detail: 'Worth keeping windows shut and limiting time outdoors for anyone with heart or lung conditions.',
      places: [l.name], url: 'https://uk-air.defra.gov.uk/forecasting/',
    });
  }
});

// ---------- compare with last run, notify, write ----------

let prev = {};
const prevUrl = process.env.PREV_URL || (process.env.GITHUB_REPOSITORY
  ? `https://${process.env.GITHUB_REPOSITORY.split('/')[0].toLowerCase()}.github.io/${process.env.GITHUB_REPOSITORY.split('/')[1]}/status.json`
  : '');
try {
  if (process.env.PREV_FILE) prev = JSON.parse(await fs.readFile(process.env.PREV_FILE, 'utf8'));
  else if (prevUrl) { const r = await fetch(prevUrl + '?t=' + Date.now(), { signal: AbortSignal.timeout(15000) }); if (r.ok) prev = await r.json(); }
} catch { /* first run */ }
const firstRun = !prev.generatedAt;

// Keep forecast heads-ups from a source that failed this time, so a blip does not look like an all-clear.
for (const a of prev.alerts || []) {
  const srcName = { 'Met Office': 'Met Office warnings', 'Environment Agency': 'Environment Agency floods', UKHSA: 'UKHSA health alerts', Forecast: a.id.startsWith('air:') ? 'Air quality (Open-Meteo)' : 'Forecast (Open-Meteo)' }[a.source];
  if (srcName && sources[srcName] && !sources[srcName].ok && !alerts.find(x => x.id === a.id)) alerts.push({ ...a, stale: true });
}

const prevMap = new Map((prev.alerts || []).map(a => [a.id, a]));
for (const a of alerts) a.firstSeen = prevMap.get(a.id)?.firstSeen || NOW.toISOString();
alerts.sort((a, b) => RANK[b.level] - RANK[a.level] || (b.official - a.official) || a.title.localeCompare(b.title));

const fails = {};
for (const [name, s] of Object.entries(sources)) {
  fails[name] = s.ok ? 0 : ((prev.sourceFails || {})[name] || 0) + 1;
  s.fails = fails[name];
}

const notes = [];
const newAlerts = alerts.filter(a => !prevMap.has(a.id) && !a.stale);
for (const a of newAlerts) {
  if (!a.official && !N.sendForecastHeadsUps) continue;
  notes.push({
    title: a.official ? `${a.source}: ${a.title}` : a.title,
    body: [a.places.length ? 'For ' + a.places.join(', ') : '', a.detail].filter(Boolean).join('. ').slice(0, 400),
    priority: { red: 5, amber: 4, yellow: 3, info: 2 }[a.level],
    tags: { red: 'rotating_light', amber: 'warning', yellow: 'yellow_circle', info: 'information_source' }[a.level],
    url: a.url,
  });
}
if (N.tellMeWhenWarningsEnd) {
  const nowIds = new Set(alerts.map(a => a.id));
  for (const a of prev.alerts || []) {
    if (a.official && RANK[a.level] >= RANK.yellow && !nowIds.has(a.id) && sources[{ 'Met Office': 'Met Office warnings', 'Environment Agency': 'Environment Agency floods', UKHSA: 'UKHSA health alerts' }[a.source]]?.ok) {
      notes.push({ title: `Ended: ${a.title}`, body: `${a.source} no longer lists this.`, priority: 2, tags: 'white_check_mark', url: a.url });
    }
  }
}
for (const [name, n] of Object.entries(fails)) {
  if (n === 8) notes.push({ title: `Home Alerts cannot reach ${name}`, body: 'It has failed for about 2 hours. Check the official site directly until it recovers.', priority: 3, tags: 'electric_plug' });
}

let lastSummaryDate = prev.lastSummaryDate || '';
if (N.dailySummaryHour != null && HOUR >= N.dailySummaryHour && lastSummaryDate !== TODAY) {
  lastSummaryDate = TODAY;
  const official = alerts.filter(a => a.official);
  const home = forecasts[active[0]?.id]?.[0];
  notes.push({
    title: official.length ? `Morning check: ${official.length} official warning${official.length > 1 ? 's' : ''} in force` : 'Morning check: no official warnings',
    body: [
      ...official.slice(0, 4).map(a => '• ' + a.title),
      home ? `${active[0].name} today: ${Math.round(home.min)} to ${Math.round(home.max)}°C, gusts ${Math.round(home.gust)} mph.` : '',
    ].filter(Boolean).join('\n'),
    priority: official.some(a => RANK[a.level] >= RANK.amber) ? 3 : 1,
    tags: 'sunrise',
  });
}

// On the very first run, send one "it works" message instead of a flood of old warnings.
const toSend = firstRun
  ? [{ title: 'Home Alerts is set up', body: `Watching ${active.map(l => l.name).join(', ')}. ${alerts.filter(a => a.official).length} official warnings in force right now.`, priority: 3, tags: 'white_check_mark' }]
  : notes;

const topic = process.env.NTFY_TOPIC;
const server = (process.env.NTFY_SERVER || 'https://ntfy.sh').replace(/\/$/, '');
for (const n of toSend) {
  if (!topic || FIXTURES) { console.log('[would notify]', n.title, '|', n.body.replace(/\n/g, ' / ')); continue; }
  try {
    const headers = { Title: /^[\x20-\x7e]*$/.test(n.title) ? n.title : '=?UTF-8?B?' + Buffer.from(n.title).toString('base64') + '?=', Priority: String(n.priority), Tags: n.tags || '' };
    if (n.url) headers.Click = n.url;
    const r = await fetch(`${server}/${encodeURIComponent(topic)}`, { method: 'POST', body: n.body || n.title, headers, signal: AbortSignal.timeout(15000) });
    if (!r.ok) console.error('ntfy', r.status, await r.text());
  } catch (e) { console.error('ntfy failed', e.message); }
}

const status = {
  generatedAt: NOW.toISOString(),
  locations: cfg.locations.map(l => ({ id: l.id, name: l.name, who: l.who, watching: active.includes(l), forecast: forecasts[l.id] || null })),
  alerts,
  sources,
  sourceFails: fails,
  lastSummaryDate,
};
await fs.mkdir(OUT_DIR, { recursive: true });
await fs.writeFile(path.join(OUT_DIR, 'status.json'), JSON.stringify(status, null, 1));
console.log(`Done: ${alerts.length} alerts (${newAlerts.length} new), ${toSend.length} notifications, sources: ` +
  Object.entries(sources).map(([k, v]) => `${k}=${v.ok ? 'ok' : 'FAIL'}`).join(', '));
