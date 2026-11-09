/*
 * Ponte do Painel da Casa — Cloudflare Worker  (versão 2)
 * - Luzes e tomadas da Smart Life (Tuya Cloud). A chave secreta da Tuya fica aqui, não no iPad.
 * - Google Calendar: lê o endereço iCal (privado ou público) e devolve os eventos já com as repetições.
 *
 * Variáveis a criar no Worker (Settings → Variables and Secrets):
 *   PAINEL_CHAVE        Uma palavra-passe à sua escolha, a mesma que põe no painel (tipo Secret)
 *   TUYA_ACCESS_ID      Access ID / Client ID do projeto em iot.tuya.com
 *   TUYA_ACCESS_SECRET  Access Secret / Client Secret do projeto  (tipo Secret)
 *   TUYA_REGIAO         Opcional: eu (predefinido), weu, us, cn, in
 *   CALENDARIO_ICAL     Opcional: endereço(s) iCal, separados por espaço (em alternativa ao campo do painel)
 */

const HOSTS = {
  eu: 'openapi.tuyaeu.com',
  weu: 'openapi-weaz.tuyaeu.com',
  us: 'openapi.tuyaus.com',
  use: 'openapi-ueaz.tuyaus.com',
  cn: 'openapi.tuyacn.com',
  in: 'openapi.tuyain.com'
};

const LIGHT_CATS = ['dj', 'dd', 'xdd', 'fwd', 'dc', 'fsd', 'tyndj', 'gyd', 'sxd', 'tgq', 'tgkg', 'fs'];
const PLUG_CATS = ['cz', 'pc', 'wkcz'];
const SWITCH_CODES = ['switch_led', 'switch', 'switch_1', 'switch_2', 'switch_3', 'switch_4', 'switch_5', 'switch_6', 'switch_led_1', 'switch_led_2'];

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Max-Age': '600'
};

let tokenCache = null; // { token, exp, key }

// ---------- utilitários ----------
const enc = (s) => new TextEncoder().encode(s);
const hex = (buf) => Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, '0')).join('');

async function sha256Hex(text) {
  return hex(await crypto.subtle.digest('SHA-256', enc(text)));
}

async function hmacUpper(secret, msg) {
  const key = await crypto.subtle.importKey('raw', enc(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return hex(await crypto.subtle.sign('HMAC', key, enc(msg))).toUpperCase();
}

/**
 * Assinatura Tuya (algoritmo novo, 2021+).
 * str = client_id + [access_token] + t + nonce + stringToSign
 * stringToSign = METHOD \n SHA256(body) \n headers \n url-com-query-ordenada
 */
export async function tuyaSign({ clientId, secret, t, accessToken = '', nonce = '', method, path, query = null, body = '', signHeaders = null }) {
  let url = path;
  if (query && Object.keys(query).length) {
    url += '?' + Object.keys(query).sort().map((k) => k + '=' + query[k]).join('&');
  }
  let headerStr = '';
  if (signHeaders) {
    for (const k of Object.keys(signHeaders)) headerStr += k + ':' + signHeaders[k] + '\n';
  }
  const stringToSign = [method.toUpperCase(), await sha256Hex(body || ''), headerStr, url].join('\n');
  return hmacUpper(secret, clientId + accessToken + t + nonce + stringToSign);
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...CORS }
  });
}

function friendlyError(code, msg) {
  const c = String(code || '');
  if (c === '1004') return 'Assinatura recusada: confirme o TUYA_ACCESS_SECRET.';
  if (c === '1005' || c === '2009') return 'Access ID inválido ou região errada (TUYA_REGIAO).';
  if (c === '1106' || c === '1100') return 'Sem permissão: confirme que a conta Smart Life está ligada ao projeto Tuya e que o IoT Core está ativo.';
  if (c === '28841002' || c === '28841101' || /expire/i.test(msg || '')) return 'O período gratuito do IoT Core expirou. Renove em iot.tuya.com → Cloud → Cloud Services → IoT Core → Extend Trial Period.';
  if (c === '2008' || c === '1109') return 'Comando não suportado por este equipamento.';
  return 'Tuya: ' + (msg || 'erro ' + c);
}

class TuyaError extends Error {
  constructor(code, msg) {
    super(friendlyError(code, msg));
    this.code = code;
  }
}

// ---------- cliente Tuya ----------
function host(env) {
  return HOSTS[(env.TUYA_REGIAO || 'eu').toLowerCase()] || HOSTS.eu;
}

async function getToken(env, force = false) {
  const cacheKey = env.TUYA_ACCESS_ID + '@' + host(env);
  if (!force && tokenCache && tokenCache.key === cacheKey && tokenCache.exp > Date.now() + 60000) {
    return tokenCache.token;
  }
  const t = String(Date.now());
  const path = '/v1.0/token';
  const query = { grant_type: '1' };
  const sign = await tuyaSign({ clientId: env.TUYA_ACCESS_ID, secret: env.TUYA_ACCESS_SECRET, t, method: 'GET', path, query });
  const res = await fetch('https://' + host(env) + path + '?grant_type=1', {
    headers: { client_id: env.TUYA_ACCESS_ID, sign, t, sign_method: 'HMAC-SHA256' }
  });
  const data = await res.json();
  if (!data.success) throw new TuyaError(data.code, data.msg);
  tokenCache = {
    token: data.result.access_token,
    exp: Date.now() + (Number(data.result.expire_time) || 3600) * 1000,
    key: cacheKey
  };
  return tokenCache.token;
}

async function tuya(env, method, path, { query = null, body = null } = {}, retried = false) {
  const token = await getToken(env);
  const t = String(Date.now());
  const bodyStr = body === null ? '' : JSON.stringify(body);
  const sign = await tuyaSign({
    clientId: env.TUYA_ACCESS_ID, secret: env.TUYA_ACCESS_SECRET, t, accessToken: token,
    method, path, query, body: bodyStr
  });
  let url = 'https://' + host(env) + path;
  if (query && Object.keys(query).length) {
    url += '?' + Object.keys(query).sort().map((k) => k + '=' + encodeURIComponent(query[k])).join('&');
  }
  const headers = { client_id: env.TUYA_ACCESS_ID, access_token: token, sign, t, sign_method: 'HMAC-SHA256' };
  if (bodyStr) headers['Content-Type'] = 'application/json';
  const res = await fetch(url, { method, headers, body: bodyStr || undefined });
  const data = await res.json();
  if (!data.success) {
    const c = String(data.code);
    if (!retried && (c === '1010' || c === '1011' || /token/i.test(data.msg || ''))) {
      tokenCache = null;
      return tuya(env, method, path, { query, body }, true);
    }
    throw new TuyaError(data.code, data.msg);
  }
  return data.result;
}

// ---------- normalização dos equipamentos ----------
function statusMap(dev) {
  const m = {};
  (dev.status || []).forEach((s) => { m[s.code] = s.value; });
  return m;
}

function parseColour(v) {
  if (!v) return null;
  try { return typeof v === 'string' ? JSON.parse(v) : v; } catch (e) { return null; }
}

export function normalizeDevice(dev) {
  const st = statusMap(dev);
  const cat = dev.category || '';
  const isLightCat = LIGHT_CATS.indexOf(cat) > -1;
  const switches = SWITCH_CODES.filter((c) => typeof st[c] === 'boolean');
  if (!switches.length) return [];
  const out = [];
  switches.forEach((sw, i) => {
    const isLight = sw.indexOf('switch_led') === 0 || isLightCat;
    const tipo = isLight ? 'luz' : (PLUG_CATS.indexOf(cat) > -1 ? 'tomada' : 'interruptor');
    const d = {
      id: dev.id,
      chave: dev.id + ':' + sw,
      nome: (dev.name || 'Equipamento') + (switches.length > 1 && sw !== 'switch_led' ? ' ' + (i + 1) : ''),
      tipo,
      categoria: cat,
      online: dev.online !== false,
      ligado: st[sw] === true,
      sw
    };
    if (sw === 'switch_led' || switches.length === 1) {
      if (typeof st.bright_value_v2 === 'number') d.brilho = { code: 'bright_value_v2', min: 10, max: 1000, valor: st.bright_value_v2 };
      else if (typeof st.bright_value === 'number') d.brilho = { code: 'bright_value', min: 25, max: 255, valor: st.bright_value };
      if ('colour_data_v2' in st) d.cor = { code: 'colour_data_v2', smax: 1000, vmax: 1000, valor: parseColour(st.colour_data_v2) };
      else if ('colour_data' in st) d.cor = { code: 'colour_data', smax: 255, vmax: 255, valor: parseColour(st.colour_data) };
      if ('work_mode' in st) d.modo = { code: 'work_mode', valor: st.work_mode };
      if (typeof st.temp_value_v2 === 'number') d.temp = { code: 'temp_value_v2', min: 0, max: 1000 };
      else if (typeof st.temp_value === 'number') d.temp = { code: 'temp_value', min: 0, max: 255 };
    }
    out.push(d);
  });
  return out;
}

async function listDevices(env) {
  let all = [];
  const query = { size: '50' };
  for (let page = 0; page < 6; page++) {
    const r = await tuya(env, 'GET', '/v1.0/iot-01/associated-users/devices', { query });
    const list = (r && (r.devices || r.list)) || [];
    all = all.concat(list);
    if (!r || !r.has_more || !r.last_row_key) break;
    query.last_row_key = r.last_row_key;
  }
  const uid = (all.find((d) => d.uid) || {}).uid || null;
  const dispositivos = [];
  all.forEach((d) => { normalizeDevice(d).forEach((x) => dispositivos.push(x)); });
  dispositivos.sort((a, b) => (a.tipo === b.tipo ? a.nome.localeCompare(b.nome, 'pt') : (a.tipo === 'luz' ? -1 : (b.tipo === 'luz' ? 1 : 0))));
  return { dispositivos, uid, total: all.length };
}

async function listScenes(env, knownUid) {
  const uid = knownUid || (await listDevices(env)).uid;
  if (!uid) return [];
  const homes = (await tuya(env, 'GET', '/v1.0/users/' + uid + '/homes')) || [];
  const cenas = [];
  for (const h of homes.slice(0, 3)) {
    const homeId = String(h.home_id || h.id);
    let list = [];
    try { list = (await tuya(env, 'GET', '/v1.1/homes/' + homeId + '/scenes')) || []; } catch (e) { list = []; }
    if (list && list.list) list = list.list;
    list.forEach((s) => {
      if (s.enabled === false) return;
      cenas.push({ casa: homeId, id: String(s.scene_id || s.id), nome: s.name || 'Cena' });
    });
  }
  return cenas;
}

async function sendCommands(env, id, comandos) {
  const path = '/v1.0/iot-03/devices/' + encodeURIComponent(id) + '/commands';
  try {
    return await tuya(env, 'POST', path, { body: { commands: comandos } });
  } catch (e) {
    // Alguns equipamentos querem os valores de cor como texto JSON: tenta outra vez.
    const hasObj = comandos.some((c) => c.value !== null && typeof c.value === 'object');
    if (!hasObj) throw e;
    const asText = comandos.map((c) => (c.value !== null && typeof c.value === 'object' ? { code: c.code, value: JSON.stringify(c.value) } : c));
    return tuya(env, 'POST', path, { body: { commands: asText } });
  }
}

function sameKey(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}


// ---------- Google Calendar (iCal) ----------
const DAY = 86400000;
const CAL_HOSTS = /^(calendar\.google\.com|outlook\.office365\.com|outlook\.live\.com|[a-z0-9-]+\.icloud\.com)$/i;
const WIN_TZ = {
  'GMT Standard Time': 'Europe/London', 'W. Europe Standard Time': 'Europe/Berlin', 'Romance Standard Time': 'Europe/Paris',
  'Central European Standard Time': 'Europe/Warsaw', 'Central Europe Standard Time': 'Europe/Budapest', 'UTC': 'UTC',
  'Eastern Standard Time': 'America/New_York', 'Pacific Standard Time': 'America/Los_Angeles', 'E. South America Standard Time': 'America/Sao_Paulo'
};
const calCache = new Map(); // url -> { t, text }

export function calUrl(src) {
  src = String(src || '').trim();
  if (!src) return null;
  if (/^webcal:\/\//i.test(src)) src = 'https://' + src.slice(9);
  if (/^https:\/\//i.test(src)) {
    let u;
    try { u = new URL(src); } catch (e) { return null; }
    return CAL_HOSTS.test(u.hostname) ? u.toString() : null;
  }
  if (/^[^\s/@]+@[^\s/@]+\.[^\s/@]+$/.test(src)) {
    return 'https://calendar.google.com/calendar/ical/' + encodeURIComponent(src) + '/public/basic.ics';
  }
  return null;
}

const dtfCache = {};
function validTz(tz) {
  if (!tz) return null;
  tz = WIN_TZ[tz] || tz;
  if (tz === 'UTC') return tz;
  try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); return tz; } catch (e) { return null; }
}
function tzOffset(utcMs, tz) {
  if (tz === 'UTC') return 0;
  let f = dtfCache[tz];
  if (!f) {
    f = dtfCache[tz] = new Intl.DateTimeFormat('en-US', {
      timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit'
    });
  }
  const p = {};
  for (const x of f.formatToParts(new Date(utcMs))) p[x.type] = x.value;
  const asUtc = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour % 24, +p.minute, +p.second);
  return asUtc - Math.floor(utcMs / 1000) * 1000;
}
// hora "de parede" (escrita como se fosse UTC) num fuso → instante real
export function wallToUtc(wallMs, tz) {
  if (tz === 'UTC') return wallMs;
  const off = tzOffset(wallMs, tz);
  let utc = wallMs - off;
  const off2 = tzOffset(utc, tz);
  if (off2 !== off) utc = wallMs - off2;
  return utc;
}

function unescapeText(v) {
  return String(v).replace(/\\n/gi, '\n').replace(/\\([,;\\])/g, '$1').trim();
}

function parseLine(line) {
  let inQ = false, i = 0;
  for (; i < line.length; i++) {
    const c = line[i];
    if (c === '"') inQ = !inQ;
    else if (c === ':' && !inQ) break;
  }
  if (i >= line.length) return null;
  const head = line.slice(0, i), value = line.slice(i + 1);
  const parts = head.match(/("[^"]*"|[^;])+/g) || [head];
  const params = {};
  for (const p of parts.slice(1)) {
    const k = p.indexOf('=');
    if (k > 0) params[p.slice(0, k).toUpperCase()] = p.slice(k + 1).replace(/^"|"$/g, '');
  }
  return { name: parts[0].toUpperCase(), params, value };
}

function parseDate(value, params, defTz) {
  const v = String(value).trim();
  if (params.VALUE === 'DATE' || /^\d{8}$/.test(v)) {
    const y = +v.slice(0, 4), m = +v.slice(4, 6), d = +v.slice(6, 8);
    return { allDay: true, wall: Date.UTC(y, m - 1, d), tz: null };
  }
  const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z?)$/.exec(v);
  if (!m) return null;
  const wall = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]);
  const tz = m[7] ? 'UTC' : (validTz(params.TZID) || defTz);
  return { allDay: false, wall, tz };
}
function instantOf(dt) { return dt.allDay ? dt.wall : wallToUtc(dt.wall, dt.tz); }
function dateKey(ms) { return new Date(ms).toISOString().slice(0, 10); }

function parseDuration(v) {
  const m = /^([+-])?P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/.exec(String(v || '').trim());
  if (!m) return null;
  const ms = ((+m[2] || 0) * 7 * DAY) + ((+m[3] || 0) * DAY) + ((+m[4] || 0) * 3600000) + ((+m[5] || 0) * 60000) + ((+m[6] || 0) * 1000);
  return m[1] === '-' ? -ms : ms;
}

export function parseICS(text) {
  const lines = String(text).replace(/\r\n?/g, '\n').replace(/\n[ \t]/g, '').split('\n');
  let calTz = null, cur = null, inAlarm = 0;
  const events = [];
  for (const raw of lines) {
    const line = raw.trimEnd();
    if (!line) continue;
    if (line === 'BEGIN:VEVENT') { cur = []; continue; }
    if (line === 'END:VEVENT') { if (cur) events.push(cur); cur = null; continue; }
    if (/^BEGIN:/.test(line) && cur) { inAlarm++; continue; }
    if (/^END:/.test(line) && cur && inAlarm) { inAlarm--; continue; }
    const p = parseLine(line);
    if (!p) continue;
    if (cur && !inAlarm) cur.push(p);
    else if (!cur && p.name === 'X-WR-TIMEZONE') calTz = validTz(p.value.trim());
  }
  return { calTz, events };
}

function parseRule(v) {
  const r = {};
  for (const part of String(v).split(';')) {
    const k = part.indexOf('=');
    if (k > 0) r[part.slice(0, k).toUpperCase()] = part.slice(k + 1);
  }
  return r;
}
const WD = { SU: 0, MO: 1, TU: 2, WE: 3, TH: 4, FR: 5, SA: 6 };
function daysInMonth(y, m0) { return new Date(Date.UTC(y, m0 + 1, 0)).getUTCDate(); }
function nthWeekday(y, m0, wd, n) {
  const dim = daysInMonth(y, m0);
  if (n > 0) {
    const first = new Date(Date.UTC(y, m0, 1)).getUTCDay();
    const d = 1 + ((wd - first + 7) % 7) + (n - 1) * 7;
    return d <= dim ? d : null;
  }
  const last = new Date(Date.UTC(y, m0, dim)).getUTCDay();
  const d = dim - ((last - wd + 7) % 7) + (n + 1) * 7;
  return d >= 1 ? d : null;
}
function monthDays(y, m0, rule, startDay) {
  const dim = daysInMonth(y, m0);
  let days = [];
  if (rule.BYMONTHDAY) {
    for (const x of rule.BYMONTHDAY.split(',')) {
      const n = parseInt(x, 10);
      const d = n < 0 ? dim + n + 1 : n;
      if (d >= 1 && d <= dim) days.push(d);
    }
  } else if (rule.BYDAY) {
    for (const x of rule.BYDAY.split(',')) {
      const mm = /^([+-]?\d+)?([A-Z]{2})$/.exec(x.trim());
      if (!mm || !(mm[2] in WD)) continue;
      const wd = WD[mm[2]];
      if (mm[1]) { const d = nthWeekday(y, m0, wd, parseInt(mm[1], 10)); if (d) days.push(d); }
      else { for (let d = 1; d <= dim; d++) if (new Date(Date.UTC(y, m0, d)).getUTCDay() === wd) days.push(d); }
    }
  } else if (startDay <= dim) {
    days.push(startDay);
  }
  return Array.from(new Set(days)).sort((a, b) => a - b);
}

// Devolve as horas "de parede" de cada ocorrência, por ordem, até ao fim da janela.
export function expandRule(startWall, ruleText, endWall, untilCheck) {
  const rule = parseRule(ruleText);
  const freq = rule.FREQ;
  const interval = Math.max(1, parseInt(rule.INTERVAL, 10) || 1);
  const count = rule.COUNT ? parseInt(rule.COUNT, 10) : Infinity;
  const tod = ((startWall % DAY) + DAY) % DAY;
  const s = new Date(startWall);
  const sy = s.getUTCFullYear(), sm = s.getUTCMonth(), sd = s.getUTCDate();
  const byday = rule.BYDAY ? rule.BYDAY.split(',').map((x) => /([A-Z]{2})$/.exec(x.trim())).filter(Boolean).map((m) => WD[m[1]]) : null;
  const bymonth = rule.BYMONTH ? rule.BYMONTH.split(',').map((x) => parseInt(x, 10) - 1) : null;
  const out = [];
  let n = 0, guard = 0;
  const push = (w) => {
    if (w < startWall) return true;
    if (n >= count || w > endWall || (untilCheck && !untilCheck(w))) return false;
    n++; out.push(w); return true;
  };
  if (freq === 'DAILY') {
    for (let i = 0; guard++ < 40000; i++) {
      const w = startWall + i * interval * DAY;
      if (w > endWall || n >= count || (untilCheck && !untilCheck(w))) break;
      const d = new Date(w);
      if (byday && byday.indexOf(d.getUTCDay()) < 0) continue;
      if (bymonth && bymonth.indexOf(d.getUTCMonth()) < 0) continue;
      if (!push(w)) break;
    }
  } else if (freq === 'WEEKLY') {
    const wkst = WD[rule.WKST] !== undefined ? WD[rule.WKST] : 1;
    const days = (byday && byday.length ? byday : [s.getUTCDay()]).slice().sort((a, b) => ((a - wkst + 7) % 7) - ((b - wkst + 7) % 7));
    const weekStart = startWall - ((s.getUTCDay() - wkst + 7) % 7) * DAY;
    outer: for (let w = 0; guard++ < 10000; w++) {
      const base = weekStart + w * interval * 7 * DAY;
      if (base > endWall) break;
      for (const wd of days) {
        const cand = base + ((wd - wkst + 7) % 7) * DAY;
        if (!push(cand)) break outer;
      }
    }
  } else if (freq === 'MONTHLY') {
    outer: for (let k = 0; guard++ < 3000; k++) {
      const mi = sm + k * interval, y = sy + Math.floor(mi / 12), m0 = ((mi % 12) + 12) % 12;
      if (Date.UTC(y, m0, 1) > endWall) break;
      if (bymonth && bymonth.indexOf(m0) < 0) continue;
      for (const d of monthDays(y, m0, rule, sd)) {
        if (!push(Date.UTC(y, m0, d) + tod)) break outer;
      }
    }
  } else if (freq === 'YEARLY') {
    outer: for (let k = 0; guard++ < 400; k++) {
      const y = sy + k * interval;
      if (Date.UTC(y, 0, 1) > endWall) break;
      const months = bymonth || [sm];
      for (const m0 of months) {
        const r2 = (rule.BYDAY && !bymonth) ? { BYMONTHDAY: rule.BYMONTHDAY } : rule;
        for (const d of monthDays(y, m0, r2, sd)) {
          if (!push(Date.UTC(y, m0, d) + tod)) break outer;
        }
      }
    }
  } else {
    push(startWall);
  }
  return out;
}

function propsOf(ev) {
  const one = {}, many = {};
  for (const p of ev) {
    if (!(p.name in one)) one[p.name] = p;
    (many[p.name] = many[p.name] || []).push(p);
  }
  return { one, many };
}

export function eventsFromICS(text, fromMs, toMs, calIndex, defTz) {
  const { calTz, events } = parseICS(text);
  const tz0 = calTz || defTz || 'Europe/Lisbon';
  const out = [];
  const overrides = {}; // uid -> Set(chaves de ocorrência substituídas)
  const parsed = [];
  for (const ev of events) {
    const { one, many } = propsOf(ev);
    if (!one.DTSTART) continue;
    const st = parseDate(one.DTSTART.value, one.DTSTART.params, tz0);
    if (!st) continue;
    const uid = one.UID ? one.UID.value.trim() : Math.random().toString(36);
    let durMs;
    if (one.DTEND) {
      const en = parseDate(one.DTEND.value, one.DTEND.params, tz0);
      durMs = en ? instantOf(en) - instantOf(st) : 0;
    } else if (one.DURATION) {
      durMs = parseDuration(one.DURATION.value) || 0;
    } else {
      durMs = st.allDay ? DAY : 0;
    }
    if (st.allDay && durMs < DAY) durMs = DAY;
    const item = { one, many, st, uid, durMs, cancelled: one.STATUS && /CANCELLED/i.test(one.STATUS.value) };
    if (one['RECURRENCE-ID']) {
      const rid = parseDate(one['RECURRENCE-ID'].value, one['RECURRENCE-ID'].params, tz0);
      if (rid) (overrides[uid] = overrides[uid] || new Set()).add(rid.allDay ? dateKey(rid.wall) : String(instantOf(rid)));
      item.isOverride = true;
    }
    parsed.push(item);
  }
  const emit = (item, startInstant) => {
    if (item.cancelled) return;
    const endInstant = startInstant + item.durMs;
    if (endInstant <= fromMs || startInstant >= toMs) return;
    const t = item.one.SUMMARY ? unescapeText(item.one.SUMMARY.value) : '(sem título)';
    const loc = item.one.LOCATION ? unescapeText(item.one.LOCATION.value) : '';
    const e = item.st.allDay ?
      { t, dia: true, ini: dateKey(startInstant), fim: dateKey(endInstant) } :
      { t, dia: false, ini: new Date(startInstant).toISOString(), fim: new Date(endInstant).toISOString() };
    if (loc) e.local = loc.slice(0, 120);
    e.cal = calIndex;
    e.id = (item.uid + '@' + e.ini).slice(0, 200);
    out.push(e);
  };
  for (const item of parsed) {
    if (item.isOverride || !item.one.RRULE) { emit(item, instantOf(item.st)); continue; }
    const st = item.st;
    const ex = new Set();
    for (const p of item.many.EXDATE || []) {
      for (const v of p.value.split(',')) {
        const d = parseDate(v, p.params, st.tz || tz0);
        if (d) ex.add(st.allDay ? dateKey(d.wall) : String(instantOf(d)));
      }
    }
    const ov = overrides[item.uid] || new Set();
    const rule = parseRule(item.one.RRULE.value);
    let untilCheck = null;
    if (rule.UNTIL) {
      const u = parseDate(rule.UNTIL, {}, st.tz || tz0);
      if (u) {
        const uInst = u.allDay ? u.wall + DAY - 1 : instantOf(u);
        untilCheck = st.allDay ? (w) => w <= uInst : (w) => wallToUtc(w, st.tz) <= uInst;
      }
    }
    // fim da janela em hora "de parede" (folga de 2 dias para fusos)
    const endWall = toMs + 2 * DAY;
    const walls = expandRule(st.wall, item.one.RRULE.value, endWall, untilCheck);
    for (const w of walls) {
      const inst = st.allDay ? w : wallToUtc(w, st.tz);
      const key = st.allDay ? dateKey(w) : String(inst);
      if (ex.has(key) || ov.has(key)) continue;
      if (inst + item.durMs < fromMs - DAY) continue;
      emit(item, inst);
    }
  }
  out.sort((a, b) => (a.ini < b.ini ? -1 : a.ini > b.ini ? 1 : 0));
  return out;
}

async function fetchIcs(url) {
  const c = calCache.get(url);
  if (c && Date.now() - c.t < 10 * 60000) return c.text;
  const res = await fetch(url, { headers: { 'User-Agent': 'PainelDaCasa/2' }, redirect: 'follow' });
  if (!res.ok) {
    const e = new Error(res.status === 404 || res.status === 403 ?
      'Calendário não encontrado ou privado. Use o "endereço secreto no formato iCal" do Google Calendar.' :
      'O calendário respondeu com erro ' + res.status + '.');
    e.code = 'cal' + res.status;
    throw e;
  }
  const text = await res.text();
  if (text.indexOf('BEGIN:VCALENDAR') < 0) {
    const e = new Error('O endereço não devolveu um calendário iCal. Confirme que copiou o "endereço secreto no formato iCal".');
    e.code = 'calformato';
    throw e;
  }
  calCache.set(url, { t: Date.now(), text });
  return text;
}

async function calendar(env, req) {
  const srcs = [];
  const add = (s) => { const u = calUrl(s); if (u && srcs.indexOf(u) < 0) srcs.push(u); };
  (Array.isArray(req.fontes) ? req.fontes : []).slice(0, 6).forEach(add);
  String(env.CALENDARIO_ICAL || '').split(/[\s,]+/).forEach(add);
  const bad = (Array.isArray(req.fontes) ? req.fontes : []).filter((s) => String(s || '').trim() && !calUrl(s));
  const isoDay = /^\d{4}-\d{2}-\d{2}$/;
  let from = isoDay.test(req.de || '') ? Date.parse(req.de + 'T00:00:00Z') : Date.now() - DAY;
  let to = isoDay.test(req.ate || '') ? Date.parse(req.ate + 'T00:00:00Z') + DAY : Date.now() + 62 * DAY;
  if (!(to > from)) to = from + 62 * DAY;
  if (to - from > 400 * DAY) to = from + 400 * DAY;
  const eventos = [], erros = [];
  if (bad.length) erros.push('Endereço não reconhecido: use o endereço iCal do Google Calendar.');
  for (let i = 0; i < srcs.length; i++) {
    try {
      const text = await fetchIcs(srcs[i]);
      eventosPush(eventos, eventsFromICS(text, from, to, i, 'Europe/Lisbon'));
    } catch (e) {
      erros.push(e.message);
    }
  }
  eventos.sort((a, b) => (a.ini < b.ini ? -1 : a.ini > b.ini ? 1 : 0));
  return { eventos: eventos.slice(0, 600), erros, fontes: srcs.length };
}
function eventosPush(arr, list) { for (const e of list) arr.push(e); }

// ---------- pedidos ----------
export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });

    const hasKey = !!env.PAINEL_CHAVE;
    const hasTuya = !!(env.TUYA_ACCESS_ID && env.TUYA_ACCESS_SECRET);

    if (request.method === 'GET') {
      const html = '<!DOCTYPE html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">' +
        '<title>Ponte do painel</title><body style="font-family:-apple-system,sans-serif;background:#2a0610;color:#fff8ec;padding:32px">' +
        '<h1 style="color:#f3d77c">🎄 Ponte do painel</h1><p>' +
        (hasKey ? 'A ponte está ativa (versão 2). Ponha este endereço e a sua chave nas definições do painel.' :
          'Falta configurar a variável PAINEL_CHAVE (Settings → Variables and Secrets).') +
        '</p><p>Luzes Smart Life: ' + (hasTuya ? 'configuradas' : 'falta TUYA_ACCESS_ID e TUYA_ACCESS_SECRET') + '</p></body>';
      return new Response(html, { headers: { 'Content-Type': 'text/html; charset=utf-8', ...CORS } });
    }

    if (request.method !== 'POST') return json({ ok: false, erro: 'Método não suportado.' }, 405);
    if (!hasKey) return json({ ok: false, erro: 'A ponte ainda não tem a variável PAINEL_CHAVE.' });

    let req;
    try { req = JSON.parse(await request.text()); } catch (e) { return json({ ok: false, erro: 'Pedido inválido.' }, 400); }
    if (!req || !sameKey(String(req.chave || ''), String(env.PAINEL_CHAVE))) {
      return json({ ok: false, erro: 'Chave errada.', codigo: 'chave' }, 401);
    }
    const TUYA_ACTIONS = ['estado', 'dispositivos', 'comando', 'cenas', 'cena'];
    if (TUYA_ACTIONS.indexOf(req.acao) > -1 && !hasTuya) {
      return json({ ok: false, erro: 'A ponte ainda não tem as variáveis TUYA_ACCESS_ID e TUYA_ACCESS_SECRET.' });
    }

    try {
      switch (req.acao) {
        case 'ping': {
          return json({ ok: true, versao: 2, tuya: hasTuya, calendario: !!env.CALENDARIO_ICAL });
        }
        case 'calendario': {
          const r = await calendar(env, req);
          return json({ ok: true, eventos: r.eventos, erros: r.erros, fontes: r.fontes });
        }
        case 'estado': {
          await getToken(env, true);
          return json({ ok: true });
        }
        case 'dispositivos': {
          const r = await listDevices(env);
          return json({ ok: true, dispositivos: r.dispositivos, total: r.total, uid: r.uid });
        }
        case 'comando': {
          const comandos = Array.isArray(req.comandos) ? req.comandos.slice(0, 10) : [];
          if (!req.id || !comandos.length) return json({ ok: false, erro: 'Comando incompleto.' }, 400);
          const clean = comandos.filter((c) => c && typeof c.code === 'string').map((c) => ({ code: c.code, value: c.value }));
          await sendCommands(env, String(req.id), clean);
          return json({ ok: true });
        }
        case 'cenas': {
          const uid = typeof req.uid === 'string' && /^[A-Za-z0-9_-]{4,64}$/.test(req.uid) ? req.uid : null;
          return json({ ok: true, cenas: await listScenes(env, uid) });
        }
        case 'cena': {
          if (!req.casa || !req.id) return json({ ok: false, erro: 'Cena incompleta.' }, 400);
          await tuya(env, 'POST', '/v1.0/homes/' + encodeURIComponent(req.casa) + '/scenes/' + encodeURIComponent(req.id) + '/trigger');
          return json({ ok: true });
        }
        default:
          return json({ ok: false, erro: 'Ação desconhecida.' }, 400);
      }
    } catch (e) {
      return json({ ok: false, erro: e.message || 'Erro na ponte.', codigo: e.code || null }, 200);
    }
  }
};
