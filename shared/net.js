// HTTP con reintentos y ritmo por servicio, más los clientes de cada API.
import {getSettings} from './settings.js';
import * as core from './core.js';

const timer = new Worker(new URL('./timer-worker.js', import.meta.url));
const waiting = new Map();
let timerId = 0;
timer.onmessage = e => { waiting.get(e.data)(); waiting.delete(e.data); };
export const sleep = ms => new Promise(resolve => {
  waiting.set(++timerId, resolve);
  timer.postMessage({id: timerId, ms});
});

class Throttle {
  constructor(interval, backoff = 5000) { this.interval = interval; this.backoff = backoff; this.tail = Promise.resolve(); }
  wait() {
    const turn = this.tail;
    this.tail = turn.then(() => sleep(this.interval));
    return turn;
  }
}

const mbRate = new Throttle(1100);       // MusicBrainz: 1 petición/s
// Discogs: 60 peticiones/min en ventana móvil; si se supera, hay que esperarla casi entera
const discogsRate = new Throttle(1050, 15000);
const lastfmRate = new Throttle(200);    // Last.fm: 5 peticiones/s
const noRate = new Throttle(0);

export class HttpError extends Error {
  constructor(status, url, body) {
    super(`HTTP ${status} en ${new URL(url).hostname}`);
    this.status = status;
    this.body = body;
  }
}

/** JSON de la URL, o excepción si tras los reintentos sigue fallando. */
async function getJson(url, rate, params = {}) {
  const u = new URL(url);
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
  let last;
  for (let attempt = 0; attempt < 4; attempt++) {
    if (attempt) await sleep(Math.min(rate.backoff * 2 ** (attempt - 1), 65000));
    await rate.wait();
    let r;
    try {
      r = await fetch(u, {signal: AbortSignal.timeout(25000)});
    } catch (e) {
      // Un 429 de Discogs llega sin cabecera CORS: el navegador lo presenta como fallo de red
      last = new Error(`Sin respuesta de ${u.hostname}`);
      continue;
    }
    if ([429, 500, 502, 503, 504].includes(r.status)) {
      last = new HttpError(r.status, u.href);
      continue;
    }
    const body = await r.json().catch(() => null);
    if (!r.ok) throw new HttpError(r.status, u.href, body);
    return body;
  }
  throw last;
}

const MB = 'https://musicbrainz.org/ws/2';
const DISCOGS = 'https://api.discogs.com';
const LASTFM = 'https://ws.audioscrobbler.com/2.0/';
const YOUTUBE = 'https://www.googleapis.com/youtube/v3';

const mbGet = (path, params) => getJson(`${MB}/${path}`, mbRate, {...params, fmt: 'json'});
// El token va en la URL y no en Authorization: esa cabecera obliga al navegador a enviar un
// OPTIONS antes de cada petición, y esos también cuentan para el límite de 60 por minuto.
const discogsGet = (path, params) => getJson(`${DISCOGS}/${path}`, discogsRate, {...params, token: getSettings().discogs_token});
export const hasDiscogs = () => !!getSettings().discogs_token;

// ── Búsqueda ──────────────────────────────────────────────────────────────────
/** Candidatos de ambas fuentes; marca por defecto la coincidencia exacta de cada una. */
export async function searchCandidates(kind, q) {
  const entity = kind === 'label' ? 'label' : 'artist';
  const plural = entity + 's', target = core.norm(q);
  const mb = async () => (await mbGet(entity, {query: q, limit: 8}))[plural].map(x => {
    const span = x['life-span'] || {};
    return {source: 'mb', id: x.id, name: x.name || '',
      detail: [x.type, x.country, (span.begin || '').slice(0, 4), x.disambiguation].filter(Boolean).join(' · '),
      url: `https://musicbrainz.org/${entity}/${x.id}`};
  });
  const discogs = async () => (!hasDiscogs() ? [] : (await discogsGet('database/search', {type: entity, q, per_page: 8})).results
    .map(r => ({source: 'discogs', id: r.id, name: r.title || '', detail: '', url: `https://www.discogs.com/${entity}/${r.id}`})));
  const out = [], errors = [];
  const settled = await Promise.allSettled([mb(), discogs()]);
  settled.forEach((res, i) => {
    if (res.status === 'rejected') { errors.push(`${['MusicBrainz', 'Discogs'][i]}: ${res.reason.message}`); return; }
    let found = false;
    for (const c of res.value) {
      const exact = core.norm(c.name.replace(/\s*\(\d+\)$/, '')) === target;
      c.preselected = exact && !found;
      found = found || c.preselected;
      out.push(c);
    }
  });
  return {candidates: out, errors};
}

// ── Catálogos ─────────────────────────────────────────────────────────────────
const spanInfo = (info, entity, id) => {
  const span = info['life-span'] || {};
  return {name: info.name, type: info.type, country: info.country, begin: span.begin, end: span.end,
    mb_url: `https://musicbrainz.org/${entity}/${id}`};
};
const credit = obj => (obj['artist-credit'] || []).map(c => (c.name || '') + (c.joinphrase || '')).join('');

async function mbLabel(mbid, log) {
  const info = await mbGet(`label/${mbid}`);
  const groups = new Map();
  for (let offset = 0; ;) {
    const data = await mbGet('release', {label: mbid, inc: 'release-groups+artist-credits+labels', limit: 100, offset});
    const page = data.releases || [];
    for (const rel of page) {
      const rg = rel['release-group'] || {};
      if (!rg.id) continue;
      const catno = (rel['label-info'] || []).find(li => (li.label || {}).id === mbid && li['catalog-number'])?.['catalog-number'] || null;
      const date = rg['first-release-date'] || rel.date || '';
      const prev = groups.get(rg.id);
      if (prev) { prev.catno = prev.catno || catno; continue; }
      groups.set(rg.id, {artist: credit(rel) || 'Unknown Artist', album: rg.title || rel.title || '', rtype: core.mbType(rg),
        date, year: core.yearOf(date), catno, mb_rgid: rg.id, discogs_url: null, main_release: null, thumb: null});
    }
    offset += page.length;
    log(`MusicBrainz: ${offset} / ${data['release-count'] ?? offset} ediciones`);
    if (!page.length || offset >= (data['release-count'] || 0)) return [spanInfo(info, 'label', mbid), [...groups.values()]];
  }
}

async function mbArtist(mbid, log) {
  const info = await mbGet(`artist/${mbid}`);
  const groups = [];
  for (let offset = 0; ;) {
    const data = await mbGet('release-group', {artist: mbid, inc: 'artist-credits', limit: 100, offset});
    const page = data['release-groups'] || [];
    for (const rg of page) {
      const date = rg['first-release-date'] || '';
      groups.push({artist: credit(rg) || info.name || 'Unknown Artist', album: rg.title || '', rtype: core.mbType(rg), date,
        year: core.yearOf(date), catno: null, mb_rgid: rg.id, discogs_url: null, main_release: null, thumb: null});
    }
    offset += page.length;
    log(`MusicBrainz: ${offset} / ${data['release-group-count'] ?? offset} discos`);
    if (!page.length || offset >= (data['release-group-count'] || 0)) return [spanInfo(info, 'artist', mbid), groups];
  }
}

async function discogsPages(path, log, each) {
  for (let page = 1; ; page++) {
    const data = await discogsGet(path, {per_page: 100, page, sort: 'year'});
    (data.releases || []).forEach(each);
    const pages = (data.pagination || {}).pages || 1;
    log(`Discogs: página ${page} / ${pages}`);
    if (page >= pages) return;
  }
}

async function discogsLabel(id, log) {
  const info = await discogsGet(`labels/${id}`);
  const out = new Map();
  await discogsPages(`labels/${id}/releases`, log, rel => {
    const artist = core.discogsName(rel.artist) || 'Unknown Artist', title = rel.title || '';
    if (!title) return;
    const key = core.albumKey(artist, title), rtype = core.discogsType(rel.format), year = rel.year || null;
    const prev = out.get(key);
    if (prev) {
      if (prev.rtype === 'Unknown') prev.rtype = rtype;
      if (year && (!prev.year || year < prev.year)) Object.assign(prev, {year, date: String(year), catno: rel.catno || prev.catno});
      return;
    }
    out.set(key, {artist, album: title, rtype, date: String(year || ''), year, catno: rel.catno || null, mb_rgid: null,
      discogs_url: `https://www.discogs.com/release/${rel.id}`, main_release: null, thumb: rel.thumb || null});
  });
  return [{name: info.name, profile: info.profile, contact: info.contact_info, discogs_url: info.uri, urls: info.urls || [],
    image: (info.images || [{}])[0].uri, sublabels: (info.sublabels || []).map(s => s.name)}, [...out.values()]];
}

async function discogsArtist(id, log) {
  const info = await discogsGet(`artists/${id}`);
  const own = core.discogsName(info.name);
  const out = new Map();
  await discogsPages(`artists/${id}/releases`, log, rel => {
    // Remezclas y apariciones son discos de otros
    const title = rel.title || '';
    if (rel.role !== 'Main' || !title) return;
    const artist = core.discogsName(rel.artist) || own || 'Unknown Artist';
    const key = core.albumKey(artist, title), year = rel.year || null, master = rel.type === 'master';
    const url = `https://www.discogs.com/${master ? 'master' : 'release'}/${rel.id}`;
    const prev = out.get(key);
    if (prev) {
      if (year && (!prev.year || year < prev.year)) Object.assign(prev, {year, date: String(year)});
      if (master && !prev.main_release) Object.assign(prev, {main_release: rel.main_release, discogs_url: url});
      return;
    }
    out.set(key, {artist, album: title, rtype: core.discogsType(rel.format), date: String(year || ''), year, catno: null,
      mb_rgid: null, discogs_url: url, main_release: rel.main_release || null, thumb: rel.thumb || null});
  });
  return [{name: own, profile: info.profile, discogs_url: info.uri, urls: info.urls || [],
    image: (info.images || [{}])[0].uri}, [...out.values()]];
}

export const catalogs = {
  label: {mb: mbLabel, discogs: discogsLabel},
  artist: {mb: mbArtist, discogs: discogsArtist},
};

/** Los «master» de Discogs no traen formato: se mira en su edición principal, y solo en los
 * discos que MusicBrainz no ha podido clasificar. */
export async function resolveDiscogsTypes(merged, log) {
  const pending = [...merged.values()].filter(it => it.rtype === 'Unknown' && it.main_release);
  let i = 0;
  for (const it of pending) {
    i++;
    let rel;
    try { rel = await discogsGet(`releases/${it.main_release}`); } catch (e) {
      log(`Discogs: ${it.artist} — ${it.album}: ${e.message}`);
      continue;
    }
    const fmt = (rel.formats || []).flatMap(f => [f.name, ...(f.descriptions || [])]).filter(Boolean).join(', ');
    it.rtype = core.discogsType(fmt);
    it.catno = it.catno || (rel.labels || []).map(l => l.catno).find(c => c && c.toLowerCase() !== 'none') || null;
    log(`Discogs: tipo de disco ${i} / ${pending.length}`);
  }
}

// ── Last.fm ───────────────────────────────────────────────────────────────────
export class LastfmError extends Error {}
/** La clave no sirve: seguir preguntando disco a disco no arreglaría nada. */
export class LastfmKeyError extends LastfmError {}

/** null si Last.fm no conoce la entidad; LastfmError si es un fallo. */
async function lfm(params) {
  const s = getSettings();
  let data;
  try {
    data = await getJson(LASTFM, lastfmRate, {...params, api_key: s.lastfm_key, format: 'json', autocorrect: 1});
  } catch (e) {
    if (e instanceof HttpError && e.body?.error) data = e.body;
    else throw new LastfmError(e.message);
  }
  if (data.error === 6) return null;
  if (data.error === 10 || data.error === 26) throw new LastfmKeyError('La API key de Last.fm no es válida');
  if (data.error) throw new LastfmError(data.message || String(data.error));
  return data;
}

export const hasLastfm = () => !!getSettings().lastfm_key;

export async function lastfmAlbum(artist, album) {
  const user = getSettings().lastfm_user;
  for (const [a, b] of core.albumVariants(artist, album)) {
    const data = await lfm({method: 'album.getinfo', artist: a, album: b, ...(user ? {username: user} : {})});
    if (data && data.album) return core.parseLastfmAlbum(data.album);
  }
  return {};
}

export async function lastfmArtist(name) {
  const data = await lfm({method: 'artist.getinfo', artist: name});
  return data && data.artist ? core.parseLastfmArtist(data.artist) : {};
}

// ── YouTube ───────────────────────────────────────────────────────────────────
export class YtError extends Error {}
let quotaOut = false;   // agotada: no se gasta nada más hasta recargar

export const hasYoutube = () => !!getSettings().youtube_key;

async function ytGet(path, params) {
  try {
    return await getJson(`${YOUTUBE}/${path}`, noRate, {...params, key: getSettings().youtube_key});
  } catch (e) {
    const reason = e.body?.error?.errors?.[0]?.reason || e.body?.error?.details?.[0]?.reason || '';
    if (/quota|dailyLimit/i.test(reason)) {
      quotaOut = true;
      throw new YtError('Cuota de la API de YouTube agotada por hoy. Puedes pegar un enlace.');
    }
    if (/key/i.test(reason) || e.status === 400) throw new YtError('La API key de YouTube no es válida.');
    throw new YtError(e.body?.error?.message || e.message);
  }
}

/** Busca (100 de cuota) y pide duraciones (1). Lo devuelto aún está sin puntuar. */
export async function youtubeEntries(query) {
  if (quotaOut) throw new YtError('Cuota de la API de YouTube agotada por hoy. Puedes pegar un enlace.');
  const found = await ytGet('search', {part: 'snippet', type: 'video', videoEmbeddable: 'true', maxResults: 10, q: query});
  const items = (found.items || []).filter(i => i.id?.videoId);
  if (!items.length) return [];
  const details = await ytGet('videos', {part: 'contentDetails', id: items.map(i => i.id.videoId).join(','), maxResults: 50});
  const secs = new Map((details.items || []).map(v => [v.id, core.isoDuration(v.contentDetails?.duration)]));
  return items.map(i => ({id: i.id.videoId, title: core.decodeEntities(i.snippet?.title),
    channel: core.decodeEntities(i.snippet?.channelTitle), duration: secs.get(i.id.videoId) || 0}));
}
