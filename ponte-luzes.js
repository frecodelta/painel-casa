/*
 * Ponte das luzes — Cloudflare Worker
 * Liga o Painel da Casa às luzes e tomadas da Smart Life (Tuya Cloud).
 * A chave secreta da Tuya fica aqui, no servidor; o iPad só conhece a PAINEL_CHAVE.
 *
 * Variáveis a criar no Worker (Settings → Variables and Secrets):
 *   TUYA_ACCESS_ID      Access ID / Client ID do projeto em iot.tuya.com
 *   TUYA_ACCESS_SECRET  Access Secret / Client Secret do projeto  (tipo Secret)
 *   PAINEL_CHAVE        Uma palavra-passe à sua escolha, a mesma que põe no painel (tipo Secret)
 *   TUYA_REGIAO         Opcional: eu (predefinido), weu, us, cn, in
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

// ---------- pedidos ----------
export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });

    const configured = !!(env.TUYA_ACCESS_ID && env.TUYA_ACCESS_SECRET && env.PAINEL_CHAVE);

    if (request.method === 'GET') {
      const html = '<!DOCTYPE html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">' +
        '<title>Ponte das luzes</title><body style="font-family:-apple-system,sans-serif;background:#2a0610;color:#fff8ec;padding:32px">' +
        '<h1 style="color:#f3d77c">🎄 Ponte das luzes</h1><p>' +
        (configured ? 'A ponte está ativa. Ponha este endereço e a sua chave nas definições do painel.' :
          'Falta configurar: TUYA_ACCESS_ID, TUYA_ACCESS_SECRET e PAINEL_CHAVE (Settings → Variables and Secrets).') +
        '</p></body>';
      return new Response(html, { headers: { 'Content-Type': 'text/html; charset=utf-8', ...CORS } });
    }

    if (request.method !== 'POST') return json({ ok: false, erro: 'Método não suportado.' }, 405);
    if (!configured) return json({ ok: false, erro: 'A ponte ainda não tem as variáveis TUYA_ACCESS_ID, TUYA_ACCESS_SECRET e PAINEL_CHAVE.' });

    let req;
    try { req = JSON.parse(await request.text()); } catch (e) { return json({ ok: false, erro: 'Pedido inválido.' }, 400); }
    if (!req || !sameKey(String(req.chave || ''), String(env.PAINEL_CHAVE))) {
      return json({ ok: false, erro: 'Chave errada.', codigo: 'chave' }, 401);
    }

    try {
      switch (req.acao) {
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
