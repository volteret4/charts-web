// El «servidor» dentro del navegador: las mismas rutas /api/* que app.py, sobre IndexedDB.
// app.js no sabe la diferencia; por eso el frontend es casi igual al de la versión con servidor.
import * as core from './core.js';
import * as net from './net.js';
import * as store from './store.js';

const KIND = document.documentElement.dataset.kind;
const DAY = 86400000;
const LASTFM_TTL = 14 * DAY;
const NO_VIDEO_TTL = 14 * DAY;

// ── Last.fm con caché ─────────────────────────────────────────────────────────
async function fillArtist(name, force) {
  const artist_key = core.norm(name);
  if (!force && await store.get('artists', artist_key)) return;
  const info = await net.lastfmArtist(name);
  await store.put('artists', {artist_key, info, fetched_at: Date.now()});
}

async function fillLastfm(key, artist, album, force) {
  const row = await store.get('albums', key);
  if (!net.hasLastfm() || (row && row.lastfm_at && !force)) return;
  // «Various Artists — 2025» mezcla en Last.fm cualquier disco con ese título
  const generic = core.isVarious(artist) && core.norm(album).split(' ').length < 2;
  const info = generic ? {} : await net.lastfmAlbum(artist, album);
  await store.update('albums', key, a => Object.assign(a, {lastfm: info, lastfm_at: Date.now(),
    listeners: info.listeners ?? null, playcount: info.playcount ?? null, tags: info.tags || [], cover: info.image || null}));
  if (!core.isVarious(artist)) await fillArtist(artist, force);
}

// ── YouTube: solo al pulsar un disco, porque cada búsqueda gasta cuota ────────
async function fillVideos(key, artist, album, rtype, force, owner) {
  const row = await store.get('albums', key);
  if (row.videos && !force && (row.videos.length || Date.now() - (row.videos_at || 0) <= NO_VIDEO_TTL)) return;
  const tracks = (row.lastfm || {}).tracks || [];
  const rels = await store.tx(['releases'], 'readonly', r => store.req(r.index('album').getAll(key)));
  const catno = (rels.find(r => r.catno) || {}).catno || '';
  const entries = await net.youtubeEntries(core.ytQuery(artist, album, rtype, owner));
  const videos = core.rankVideos(entries, artist, album, rtype, {owner, catno, tracks: tracks.map(t => t.name),
    totalSecs: tracks.reduce((n, t) => n + (t.duration || 0), 0)});
  await store.update('albums', key, a => Object.assign(a, {videos, videos_at: Date.now()}));
}

async function albumDetail(key, rtype, refresh, owner) {
  let row = await store.get('albums', key);
  if (!row) return {error: 'No existe'};
  const errors = [];
  let yt_note = null;
  try { await fillLastfm(key, row.artist, row.album, refresh); } catch (e) {
    if (!(e instanceof net.LastfmError)) throw e;
    errors.push(`Last.fm: ${e.message}`);
  }
  row = await store.get('albums', key);
  if (net.hasYoutube()) {
    try { await fillVideos(key, row.artist, row.album, rtype, refresh, owner); } catch (e) {
      errors.push(`YouTube: ${e.message}`);
    }
  } else if (!row.videos) {
    yt_note = 'Sin API key de YouTube (⚙): pulsa «Buscar en YouTube» y pega aquí el enlace.';
  }
  row = await store.get('albums', key);
  const artist = await store.get('artists', core.norm(row.artist));
  return {lastfm: row.lastfm || {}, artist: artist ? artist.info : {}, videos: row.videos ?? null,
    custom: row.custom || [], errors, yt_note};
}

// ── Trabajos: uno a la vez entre todas las pestañas ───────────────────────────
// La cola es lo que IndexedDB marca como «queued»/«running»: si se cierra la pestaña a
// medias, el trabajo sigue al volver a abrir, sin repetir lo guardado.
const IDLE = {running: false, slug: null, name: null, phase: null, done: 0, total: 0, current: null, queue: [],
  finished: 0, error: null, warning: null, log: ''};
const job = {...IDLE};
let remote = null;   // el estado que anuncia la pestaña que está trabajando
const channel = 'BroadcastChannel' in window ? new BroadcastChannel('charts-web-job') : null;

function publish() {
  channel?.postMessage({...job});
  window.dispatchEvent(new Event('charts-job'));
}
if (channel) channel.onmessage = e => {
  remote = e.data.running ? e.data : null;
  window.dispatchEvent(new Event('charts-job'));
};

const jobState = () => (job.running ? job : remote || job);

function jobLog(line) {
  job.log = [...job.log.split('\n'), line].slice(-40).join('\n').replace(/^\n/, '');
  publish();
}

const setStatus = (key, status, error = null) =>
  store.update('sources', key, s => Object.assign(s, {status, error, updated: Date.now()}));

async function pendingSources() {
  const rows = (await store.all('sources')).filter(s => s.status === 'queued' || s.status === 'running');
  return rows.sort((a, b) => a.updated - b.updated);
}

/** Lo que la cabecera de la discografía cuenta del artista. */
async function artistPanel(name) {
  if (!net.hasLastfm()) return {};
  try { await fillArtist(name, true); } catch (e) {
    if (e instanceof net.LastfmKeyError) throw e;
    jobLog(`Last.fm: ${name}: ${e.message}`);
  }
  const a = (await store.get('artists', core.norm(name)))?.info || {};
  return {listeners: a.listeners, playcount: a.playcount, tags: a.tags || [], bio_summary: a.bio_summary, bio: a.bio,
    lastfm_url: a.url, similar: (a.similar || []).map(s => s.name).filter(Boolean)};
}

async function runJob(row) {
  const {key, kind, name, sources} = row;
  Object.assign(job, {slug: key, name, phase: 'Catálogo', done: 0, total: 0, current: null, error: null, warning: null, log: ''});
  await setStatus(key, 'running');
  publish();
  const infos = {}, lists = [];
  for (const id of sources.mb || []) {
    const [info, items] = await net.catalogs[kind].mb(id, jobLog);
    for (const [k, v] of Object.entries(info)) if (v) infos[k] = v;
    lists.push(items);
  }
  for (const id of sources.discogs || []) {
    if (!net.hasDiscogs()) { jobLog('Sin token de Discogs: se omite Discogs'); break; }
    const [info, items] = await net.catalogs[kind].discogs(id, jobLog);
    for (const [k, v] of Object.entries(info)) if (v && (k !== 'name' || !infos.name)) infos[k] = v;
    lists.push(items);
  }
  let merged = core.mergeCatalogs(lists);
  if (!merged.size) throw new Error('Ninguna fuente ha devuelto discos');
  if (net.hasDiscogs()) await net.resolveDiscogsTypes(merged, jobLog);
  const total = merged.size;
  if (sources.types) {
    merged = new Map([...merged].filter(([, v]) => sources.types.includes(v.rtype)));
    if (!merged.size) throw new Error(`Hay ${total} discos, pero ninguno en las secciones elegidas`);
  }
  jobLog(merged.size !== total ? `${merged.size} de ${total} discos distintos` : `${total} discos distintos`);

  // El panel de artista va antes de escribir nada: una clave mala se avisa una sola vez
  let warning = null;
  if (kind === 'artist') {
    try { Object.assign(infos, await artistPanel(name)); } catch (e) { warning = e.message; }
  }

  const items = [...merged];
  await store.tx(['sources', 'releases', 'albums'], 'readwrite', async (src, rel, alb) => {
    const s = await store.req(src.get(key));
    if (s) { s.info = infos; src.put(s); }
    const old = await store.req(rel.index('source').getAllKeys(key));
    old.forEach(k => rel.delete(k));
    const existing = await Promise.all(items.map(([k]) => store.req(alb.get(k))));
    items.forEach(([k, it], i) => {
      if (!existing[i]) alb.put({album_key: k, artist: it.artist, album: it.album, lastfm: null, lastfm_at: null, listeners: null,
        playcount: null, tags: [], cover: null, videos: null, videos_at: null, custom: []});
      rel.put({source: key, album_key: k, rtype: it.rtype, year: it.year, date: it.date, catno: it.catno,
        mb_rgid: it.mb_rgid, discogs_url: it.discogs_url, thumb: it.thumb});
    });
  });

  // Last.fm: en paralelo; el ritmo lo marca el Throttle. Los vídeos se piden al pulsar.
  if (net.hasLastfm() && !warning) {
    const now = Date.now();
    const rows = await store.releasesOf(key);
    const pending = rows.filter(r => !r.lastfm_at || now - r.lastfm_at > LASTFM_TTL);
    Object.assign(job, {phase: 'Last.fm', done: 0, total: pending.length});
    publish();
    let next = 0;
    const worker = async () => {
      while (next < pending.length && !warning) {
        const r = pending[next++];
        job.current = `${r.artist} — ${r.album}`;
        try {
          await fillLastfm(r.album_key, r.artist, r.album, !!r.lastfm_at);
        } catch (e) {
          if (e instanceof net.LastfmKeyError) warning = e.message;
          else if (e instanceof net.LastfmError) jobLog(`Last.fm: ${r.artist} — ${r.album}: ${e.message}`);
          else throw e;
        }
        job.done++;
        publish();
      }
    };
    await Promise.all([worker(), worker(), worker(), worker()]);
  }
  if (warning) {
    job.warning = warning;
    jobLog(warning);
    await setStatus(key, 'partial', warning);
    return;
  }
  await setStatus(key, 'done');
  jobLog('Completado');
}

let workerAsked = false;
async function startWorker() {
  if (workerAsked) return;
  workerAsked = true;
  try {
    await navigator.locks.request('charts-web-job', async () => {
      for (;;) {
        const [row, ...rest] = await pendingSources();
        if (!row) break;
        Object.assign(job, {running: true, queue: rest.map(r => r.key)});
        try {
          await runJob(row);
        } catch (e) {
          console.error(e);
          job.error = e.message;
          jobLog(`Error: ${e.message}`);
          await setStatus(row.key, 'error', e.message);
        }
        job.finished++;
        publish();
      }
      Object.assign(job, {running: false, queue: []});
      publish();
    });
  } finally {
    workerAsked = false;
  }
  // Pudo entrar algo justo cuando el bucle ya había salido
  if ((await pendingSources()).length) startWorker();
}

// ── Lecturas para la web ──────────────────────────────────────────────────────
async function listSources() {
  const [sources, releases] = await store.tx(['sources', 'releases'], 'readonly', (s, r) =>
    Promise.all([store.req(s.getAll()), store.req(r.getAll())]));
  const types = {};
  for (const r of releases) {
    const t = types[r.source] = types[r.source] || {};
    t[r.rtype || 'Unknown'] = (t[r.rtype || 'Unknown'] || 0) + 1;
  }
  return sources.filter(s => s.kind === KIND).sort((a, b) => a.name.localeCompare(b.name)).map(s => ({
    key: s.key, name: s.name, status: s.status, error: s.error, types: types[s.key] || {},
    count: Object.values(types[s.key] || {}).reduce((x, y) => x + y, 0)}));
}

function covers(r) {
  return [r.cover, r.mb_rgid && `https://coverartarchive.org/release-group/${r.mb_rgid}/front-500`, r.thumb].filter(Boolean);
}

async function sourceData(key) {
  const s = await store.get('sources', key);
  if (!s) return {error: 'No existe'};
  const rows = await store.releasesOf(key);
  return {
    disco: {slug: key, name: s.name, status: s.status, error: s.error, types: s.sources.types ?? null, info: s.info || {}},
    albums: rows.map(r => ({key: r.album_key, artist: r.artist, album: r.album, rtype: r.rtype || 'Unknown', year: r.year,
      date: r.date, catno: r.catno, covers: covers(r), listeners: r.listeners, playcount: r.playcount, tags: r.tags || [],
      videos: r.videos ?? null, custom: r.custom || [], has_lastfm: !!r.lastfm_at,
      links: {musicbrainz: r.mb_rgid ? `https://musicbrainz.org/release-group/${r.mb_rgid}` : null, discogs: r.discogs_url}})),
  };
}

function cleanGroups(groups) {
  return groups.filter(g => g && String(g.name || '').trim()).map(g => ({id: String(g.id || ''), name: String(g.name).trim(),
    members: [...new Set((g.members || []).filter(m => typeof m === 'string'))]}));
}

async function fetchRoute(d) {
  const {types} = d;
  if (types != null && !(Array.isArray(types) && types.length && types.every(t => core.RTYPES.includes(t)))) {
    return {error: 'Elige al menos una sección'};
  }
  let key = d.slug;
  if (!key) {
    const name = String(d.name || '').trim();
    const mb = (d.mb || []).map(String), discogs = (d.discogs || []).map(Number);
    if (!name || !(mb.length || discogs.length)) return {error: 'Marca al menos una entrada'};
    key = `${KIND}:${core.slugify(name, KIND)}`;
    const prev = await store.get('sources', key);
    await store.put('sources', {key, kind: KIND, name, sources: {mb, discogs, types}, info: prev?.info || {}, status: 'queued',
      error: null, created: prev?.created || Date.now(), updated: Date.now()});
  } else {
    const row = await store.update('sources', key, s => {
      if ('types' in d) s.sources = {...s.sources, types};
      Object.assign(s, {status: 'queued', error: null, updated: Date.now()});
    });
    if (!row) return {error: 'No existe'};
  }
  // Que el navegador no borre esto por su cuenta si se queda sin espacio
  navigator.storage?.persist?.();
  startWorker();
  return {ok: true, slug: key};
}

const ROUTES = {
  'GET /api/search': (_, q) => (q.get('q') ? net.searchCandidates(KIND, q.get('q')) : {error: 'q requerido'}),
  'GET /api/sources': listSources,
  'GET /api/groups': async () => (await store.get('kv', `groups:${KIND}`)) || [],
  'GET /api/album': (_, q) => albumDetail(q.get('key'), q.get('rtype') || 'Album', q.get('refresh') === '1', q.get('owner') || ''),
  'GET /api/job': () => ({...jobState(), queue: [...jobState().queue]}),
  'POST /api/fetch': fetchRoute,
  'POST /api/delete': async d => {
    const s = jobState();
    if (s.running && s.slug === d.slug) return {error: 'Se está actualizando; espera a que termine'};
    await store.tx(['sources', 'releases'], 'readwrite', async (src, rel) => {
      src.delete(d.slug);
      (await store.req(rel.index('source').getAllKeys(d.slug))).forEach(k => rel.delete(k));
    });
    return {ok: true};
  },
  'POST /api/groups': async d => {
    if (!Array.isArray(d.groups)) return {error: 'groups requerido'};
    const groups = cleanGroups(d.groups);
    await store.put('kv', groups, `groups:${KIND}`);
    return {ok: true, groups};
  },
  'POST /api/links': async d => {
    const urls = (d.urls || []).filter(u => typeof u === 'string' && u.trim()).map(u => u.trim());
    if (urls.some(u => !/^https?:\/\//.test(u))) return {error: 'Enlace no válido'};
    const row = await store.update('albums', d.key, a => { a.custom = urls; });
    return row ? {ok: true, urls} : {error: 'No existe'};
  },
};

export async function api(ep, body) {
  const url = new URL(ep, 'https://charts.invalid');
  const data = url.pathname.startsWith('/api/data/');
  const route = data ? () => sourceData(decodeURIComponent(url.pathname.slice('/api/data/'.length)))
    : ROUTES[`${body === undefined ? 'GET' : 'POST'} ${url.pathname}`];
  if (!route) throw new Error(`Ruta desconocida: ${ep}`);
  try {
    return await route(body, url.searchParams);
  } catch (e) {
    console.error(e);
    return {error: e.message};
  }
}

/** Reanuda lo que quedó a medias al cerrar la pestaña. */
export async function resumeJobs() {
  if ((await pendingSources()).length) startWorker();
}
