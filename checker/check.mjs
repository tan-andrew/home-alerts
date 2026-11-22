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
      const r = await fetch(url, { headers: UA, signal: AbortSignal.timeout(30000) });
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
      let where = null;
      if (areaId && !alerts.find(x => x.id === `ea:${areaId}:${f.severityLevel}`)) {
        try { const fa = await get(`https://environment.data.gov.uk/flood-monitoring/id/floodAreas/${areaId}`); const it = Array.isArray(fa.items) ? fa.items[0] : fa.items; if (it && it.lat) where = { lat: it.lat, lon: it.long }; } catch { /* map just shows the place instead */ }
      }
      add({
        polygon: (f.floodArea && f.floodArea.polygon) || (areaId ? `https://environment.data.gov.uk/flood-monitoring/id/floodAreas/${areaId}/polygon` : null),
        where,
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
        detail: decode((a.text || '').replace(/<li[^>]*>/gi, ' • ')).slice(0, 600),
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

// ---------- 6. River levels near chosen places (Environment Agency) ----------

const rivers = [];
const riverNotes = [];
await source('River levels', async () => {
  const errors = [];
  for (const l of active.filter(l => l.riverWithinKm)) { try {
    const st = await get(`https://environment.data.gov.uk/flood-monitoring/id/stations?parameter=level&lat=${l.lat}&long=${l.lon}&dist=${l.riverWithinKm}`);
    const dist = s => Math.hypot((s.lat - l.lat) * 111, (s.long - l.lon) * 111 * Math.cos(l.lat * Math.PI / 180));
    const first = v => Array.isArray(v) ? v[0] : v;
    let found = (st.items || []).map(s => ({ ...s, lat: Number(first(s.lat)), long: Number(first(s.long)), riverName: first(s.riverName) || first(s.label) || '', label: first(s.label) || first(s.riverName) || '' }))
      .filter(s => s.riverName && !isNaN(s.lat)).sort((a, b) => dist(a) - dist(b));
    if (l.rivers && l.rivers.length) {
      const wanted = found.filter(s => l.rivers.some(n => (s.riverName + ' ' + (s.label || '')).toLowerCase().includes(String(n).toLowerCase())));
      if (wanted.length) found = wanted;
      else riverNotes.push(`No ${l.rivers.join(' or ')} gauge within ${l.riverWithinKm} km of ${l.name}${found.length ? `. Nearest: ${found.slice(0, 3).map(s => s.riverName + ' at ' + s.label).join(', ')}` : ''}`);
    }
    if (!found.length) riverNotes.push(`No river gauge within ${l.riverWithinKm} km of ${l.name}`);
    const wantCount = l.maxRiverStations || 2;
    let got = 0;
    const open = found.filter(s => !/closed/i.test(String(s.status || '')));
    if (found.length && !open.length) riverNotes.push(`All gauges near ${l.name} are closed`);
    for (const s of open) { if (got >= wantCount) break; try {
      const ref = s.stationReference || s.notation;
      let detail = s;
      try { const d = await get(`https://environment.data.gov.uk/flood-monitoring/id/stations/${ref}`); detail = Array.isArray(d.items) ? d.items[0] : d.items || s; } catch { /* use list data */ }
      const measures = [].concat(detail.measures || s.measures || []).filter(m => m && m['@id'] && m.parameter === 'level');
      // Prefer the gauge's own scale (m), then height above sea level (mAOD).
      measures.sort((a, b) => (/-m$/.test(b['@id']) - /-m$/.test(a['@id'])) || (/stage/i.test(b.qualifier || '') - /stage/i.test(a.qualifier || '')));
      let vals = [], m = null;
      for (const cand of measures) {
        const r = await get(`${cand['@id'].replace(/^http:/, 'https:')}/readings?_sorted&_limit=16`);
        vals = (r.items || []).filter(x => typeof x.value === 'number');
        if (vals.length && Date.now() - new Date(vals[0].dateTime) < 2 * 864e5) { m = cand; break; }
      }
      if (!m) { riverNotes.push(`${detail.label || s.label} gauge near ${l.name} has no recent readings`); continue; }
      got++;
      const aboveSeaLevel = /mAOD$/i.test(m['@id']);
      const latest = vals[0];
      const threeHoursAgo = vals.find(x => new Date(latest.dateTime) - new Date(x.dateTime) >= 2.75 * 3600e3);
      const scale = typeof detail.stageScale === 'object' ? detail.stageScale : {};
      const river = {
        place: l.name, ref, label: detail.label || s.label, river: detail.riverName || s.riverName,
        level: latest.value, time: latest.dateTime, aboveSeaLevel,
        change3h: threeHoursAgo ? +(latest.value - threeHoursAgo.value).toFixed(2) : null,
        typicalHigh: aboveSeaLevel ? null : scale.typicalRangeHigh ?? null, typicalLow: aboveSeaLevel ? null : scale.typicalRangeLow ?? null,
        url: 'https://check-for-flooding.service.gov.uk/river-and-sea-levels',
      };
      rivers.push(river);
      const name = `${river.river} at ${river.label}`;
      if (river.typicalHigh != null && river.level > river.typicalHigh) add({
        id: `river:${ref}:high:${TODAY}`, source: 'River levels', official: false, level: 'info',
        title: `${name} is above its normal range (${river.level.toFixed(2)} m, normal up to ${river.typicalHigh.toFixed(2)} m)`,
        detail: 'This is a measurement, not a warning. Any flood alert would come from the Environment Agency.', places: [l.name], url: river.url,
      });
      const riseLimit = l.riverRiseM3h !== undefined ? l.riverRiseM3h : (T.riverRiseM3h || 0.3);
      if (riseLimit && river.change3h != null && river.change3h >= riseLimit) add({
        id: `river:${ref}:rising:${TODAY}`, source: 'River levels', official: false, level: 'info',
        title: `${name} is rising fast (up ${river.change3h.toFixed(2)} m in 3 hours)`,
        detail: 'This is a measurement, not a warning. Any flood alert would come from the Environment Agency.', places: [l.name], url: river.url,
      });
    } catch (e) { errors.push(`${l.name} gauge: ${e.message || e}`); } }
  } catch (e) { errors.push(`${l.name}: ${e.message || e}`); } }
  if (errors.length) console.error('[River levels]', errors.join('; '));
  riverNotes.push(...errors);
  if (errors.length && !rivers.length) throw new Error(errors[0]);
});

// ---------- 7. Food and product recalls ----------

const recalls = [];
const RECALL_DAYS = 14;
const since = new Date(NOW - RECALL_DAYS * 864e5);
await source('Food recalls (FSA)', async () => {
  const d = await get('https://data.food.gov.uk/food-alerts/id?_limit=30&_sort=-created');
  for (const a of d.items || []) {
    const id = a.notation || a['@id'] || a.title;
    const type = (String(id).match(/-(AA|PRIN|FAFA)-/) || [])[1] || '';
    if (type === 'AA' && !cfg.recalls?.allergyAlerts) continue;
    const when = new Date(a.modified || a.created);
    if (when < since) continue;
    const risk = [].concat(a.problem || []).map(p => p.riskStatement).filter(Boolean)[0] || '';
    recalls.push({ id: 'fsa:' + id, kind: type === 'AA' ? 'Allergy alert' : 'Food recall', title: decode(a.title || ''), detail: decode(risk), date: (a.created || '').slice(0, 10), url: a.alertURL || `https://www.food.gov.uk/news-alerts/search/alerts` });
  }
});
if (cfg.recalls?.showProductRecalls) await source('Product recalls (GOV.UK)', async () => {
  const xml = await get('https://www.gov.uk/product-safety-alerts-reports-recalls.atom', 'text');
  if (!/<feed/i.test(xml)) throw new Error('unexpected reply');
  for (const [, e] of xml.matchAll(/<entry>([\s\S]*?)<\/entry>/gi)) {
    const updated = tag(e, 'updated');
    if (new Date(updated) < since) continue;
    const link = (e.match(/<link[^>]*href="([^"]+)"/i) || [])[1] || 'https://www.gov.uk/product-safety-alerts-reports-recalls';
    recalls.push({ id: 'opss:' + (tag(e, 'id') || link), kind: 'Product recall', title: tag(e, 'title'), detail: tag(e, 'summary'), date: updated.slice(0, 10), url: link });
  }
});
recalls.sort((a, b) => b.date.localeCompare(a.date));

// ---------- 8. Flu, COVID-19 and RSV (UKHSA dashboard API, England) ----------

const bugs = [];
await source('Flu, COVID and RSV (UKHSA)', async () => {
  const base = 'https://api.ukhsa-dashboard.data.gov.uk/themes/infectious_disease/sub_themes/respiratory/topics';
  const want = [['Influenza', 'Flu'], ['COVID-19', 'COVID-19'], ['RSV', 'RSV']];
  let gotAny = false;
  for (const [topic, label] of want) {
    try {
      const geo = `${base}/${topic}/geography_types/Nation/geographies/England/metrics`;
      const list = await get(`${geo}?format=json`);
      const names = (Array.isArray(list) ? list : list.results || []).map(x => x.name || x.metric || x).filter(x => typeof x === 'string');
      const metric = names.find(n => /positivity/i.test(n) && /week/i.test(n)) || names.find(n => /positivity/i.test(n)) || names.find(n => /admission.*rate/i.test(n));
      if (!metric) continue;
      let rows = [];
      for (const yr of [Number(LP.year) - 1, Number(LP.year)]) {
        const r = await get(`${geo}/${metric}?format=json&page_size=365&year=${yr}&stratum=default&sex=all&age=all`).catch(() => null);
        rows = rows.concat((r && r.results) || []);
      }
      rows = rows.filter(r => r.metric_value != null).sort((a, b) => a.date.localeCompare(b.date));
      if (!rows.length) continue;
      const lastRow = rows[rows.length - 1];
      const twoWeeks = rows.filter(r => new Date(lastRow.date) - new Date(r.date) >= 13 * 864e5).pop();
      const change = twoWeeks ? lastRow.metric_value - twoWeeks.metric_value : null;
      bugs.push({
        label, metric, value: lastRow.metric_value, date: lastRow.date,
        trend: change == null ? 'unknown' : change > 0.5 ? 'rising' : change < -0.5 ? 'falling' : 'steady',
        isPercent: /positivity/i.test(metric),
        spark: rows.slice(-12).map(r => r.metric_value),
        url: `https://ukhsa-dashboard.data.gov.uk/respiratory-viruses/${topic.toLowerCase()}`,
      });
      gotAny = true;
    } catch (e) { console.error(`[UKHSA ${topic}]`, e.message); }
  }
  if (!gotAny) throw new Error('no figures returned');
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
  const srcName = { 'Met Office': 'Met Office warnings', 'Environment Agency': 'Environment Agency floods', UKHSA: 'UKHSA health alerts', 'River levels': 'River levels', Forecast: a.id.startsWith('air:') ? 'Air quality (Open-Meteo)' : 'Forecast (Open-Meteo)' }[a.source];
  if (srcName && sources[srcName] && !sources[srcName].ok && !alerts.find(x => x.id === a.id)) alerts.push({ ...a, stale: true });
}

for (const [key, src] of [['rivers', 'River levels'], ['recalls', null], ['bugs', 'Flu, COVID and RSV (UKHSA)']]) {
  const target = { rivers, recalls, bugs }[key];
  const failed = src ? !sources[src]?.ok : (!sources['Food recalls (FSA)']?.ok && (!cfg.recalls?.showProductRecalls || !sources['Product recalls (GOV.UK)']?.ok));
  if (failed && !target.length && Array.isArray(prev[key])) for (const x of prev[key]) target.push({ ...x, stale: true });
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
const prevRecalls = new Set((prev.recalls || []).map(r => r.id));
for (const r of recalls) {
  if (prevRecalls.has(r.id) || !prev.recalls) continue;
  const want = r.kind === 'Product recall' ? cfg.recalls?.notifyProductRecalls : cfg.recalls?.notifyFoodRecalls;
  if (want) notes.push({ title: `${r.kind}: ${r.title}`.slice(0, 200), body: r.detail || 'Check if you have this at home.', priority: 2, tags: 'shopping_cart', url: r.url });
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
  locations: cfg.locations.map(l => ({ id: l.id, name: l.name, who: l.who, lat: l.lat, lon: l.lon, radiusKm: l.floodRadiusKm || 5, watching: active.includes(l), forecast: forecasts[l.id] || null })),
  alerts,
  sources,
  sourceFails: fails,
  lastSummaryDate,
  rivers,
  riverNotes,
  recalls,
  bugs,
};
await fs.mkdir(OUT_DIR, { recursive: true });
await fs.writeFile(path.join(OUT_DIR, 'status.json'), JSON.stringify(status, null, 1));
console.log(`Done: ${alerts.length} alerts (${newAlerts.length} new), ${toSend.length} notifications, sources: ` +
  Object.entries(sources).map(([k, v]) => `${k}=${v.ok ? 'ok' : 'FAIL'}`).join(', '));
