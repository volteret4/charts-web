// Lógica sin navegador ni red: normalizar, clasificar, juntar catálogos y puntuar vídeos.
// Es la misma que app.py de charts_sellos y charts_artistas; test/core.test.mjs la fija.

export const VARIOUS = 'various artists';
export const RTYPES = ['Album', 'EP', 'Single', 'Compilation', 'Live album', 'Remix', 'Soundtrack', 'DJ Mix', 'Mixtape', 'Demo', 'Interview', 'Unknown'];
const LONG_TYPES = new Set(['Album', 'Compilation', 'Live album', 'Soundtrack', 'DJ Mix', 'Mixtape', 'Unknown']);
const GENERIC_WORDS = new Set(['ep', 'lp', 'remix', 'remixes', 'reworks', 'edits', 'the', 'a']);
const BAD_WORDS = new Set(['reaction', 'review', 'unboxing', 'interview', 'trailer', 'tutorial', 'karaoke', 'lesson', 'teaser']);
const MB_SECONDARY = {
  'Compilation': 'Compilation', 'Live': 'Live album', 'Remix': 'Remix', 'Soundtrack': 'Soundtrack',
  'DJ-mix': 'DJ Mix', 'Mixtape/Street': 'Mixtape', 'Demo': 'Demo', 'Interview': 'Interview',
};
const DISCOGS_TOKENS = [['Comp', 'Compilation'], ['Smplr', 'Compilation'], ['Mixed', 'DJ Mix'], ['Album', 'Album'],
  ['LP', 'Album'], ['Mini-Album', 'EP'], ['EP', 'EP'], ['Single', 'Single'], ['Maxi', 'Single']];

/** Minúsculas, sin acentos ni puntuación, espacios simples. */
export function norm(s) {
  return (s || '').normalize('NFD').replace(/\p{Mn}/gu, '').toLowerCase()
    .replace(/&/g, ' and ').replace(/[^\p{L}\p{M}\p{N}_]+/gu, ' ').replace(/\s+/g, ' ').trim();
}

export function albumKey(artist, album) {
  let a = norm(artist);
  if (a === 'various') a = VARIOUS;
  return a + '|' + norm(album);
}

export const slugify = (name, fallback) => norm(name).replace(/ /g, '-') || fallback;
export const isVarious = artist => [VARIOUS, 'various'].includes(norm(artist));

export function yearOf(date) {
  const m = /^\d{4}/.exec(String(date || ''));
  return (m && +m[0]) || null;
}

export function mbType(rg) {
  for (const s of rg['secondary-types'] || []) if (MB_SECONDARY[s]) return MB_SECONDARY[s];
  return {Album: 'Album', EP: 'EP', Single: 'Single'}[rg['primary-type']] || 'Unknown';
}

export function discogsType(fmt) {
  const tokens = new Set((fmt || '').split(',').map(t => t.trim()));
  for (const [token, rtype] of DISCOGS_TOKENS) if (tokens.has(token)) return rtype;
  // Sin descripción: el formato físico es lo único que orienta
  if (/(^|\D)7"/.test(fmt || '')) return 'Single';
  if (/(^|\D)1[02]"/.test(fmt || '')) return 'EP';
  return 'Unknown';
}

/** «Autechre (2)» y «Autechre*» son desambiguaciones internas de Discogs. */
export const discogsName = artist => (artist || '').replace(/\s*\(\d+\)/g, '').replace(/\*/g, '').trim();

/** Junta por artista+título. MusicBrainz manda en el tipo; se conserva el año más antiguo. */
export function mergeCatalogs(catalogs) {
  const merged = new Map();
  for (const items of catalogs) for (const it of items) {
    const key = albumKey(it.artist, it.album), prev = merged.get(key);
    if (!prev) { merged.set(key, {...it}); continue; }
    if (it.mb_rgid && !prev.mb_rgid) {
      Object.assign(prev, {mb_rgid: it.mb_rgid, rtype: it.rtype, artist: it.artist, album: it.album});
    } else if (prev.rtype === 'Unknown') prev.rtype = it.rtype;
    for (const f of ['discogs_url', 'main_release', 'thumb', 'catno']) prev[f] = prev[f] || it[f] || null;
    if (it.year && (!prev.year || it.year < prev.year)) { prev.year = it.year; prev.date = it.date; }
  }
  return merged;
}

export const asList = v => (!v ? [] : Array.isArray(v) ? v : [v]);
const toInt = v => parseInt(v, 10) || 0;
const names = (section, key = 'tag') => asList((section || {})[key]).filter(t => t && t.name).map(t => t.name);
const obj = v => (v && typeof v === 'object' && !Array.isArray(v) ? v : {});

/** Quita el «Read more on Last.fm» y el HTML de wikis y biografías. */
export function cleanText(s) {
  return (s || '').replace(/<a href=[\s\S]*?<\/a>\.?/g, '')
    .replace(/User-contributed text is available under[\s\S]*$/, '')
    .replace(/<[^>]+>/g, '').trim() || null;
}

export function* albumVariants(artist, album) {
  yield [artist, album];
  const first = artist.split(/\s+(?:&|and|vs\.?|feat\.?|ft\.?|with)\s+|\s*[,/]\s*/i)[0];
  const bare = album.replace(/\s*[([][^)\]]*[)\]]\s*$/, '').trim();
  if (first && first !== artist) yield [first, album];
  if (bare && bare !== album) yield [artist, bare];
}

const NO_COVER = '2a96cbd8b46e442fc41c2b86b821562f';   // la imagen de Last.fm cuando no tiene portada

export function parseLastfmAlbum(al) {
  const wiki = obj(al.wiki);
  const tracks = asList(obj(al.tracks).track).map(t => ({name: t.name, duration: toInt(t.duration), url: t.url}));
  const images = asList(al.image).map(i => i['#text']).filter(Boolean);
  let image = images[images.length - 1] || null;
  if (image && image.includes(NO_COVER)) image = null;
  return {name: al.name, artist: typeof al.artist === 'string' ? al.artist : null, url: al.url, mbid: al.mbid || null, image,
    listeners: toInt(al.listeners), playcount: toInt(al.playcount),
    userplaycount: 'userplaycount' in al ? toInt(al.userplaycount) : null,
    tags: names(obj(al.tags)), tracks, published: wiki.published,
    wiki_summary: cleanText(wiki.summary), wiki: cleanText(wiki.content)};
}

export function parseLastfmArtist(a) {
  const bio = a.bio || {}, stats = a.stats || {};
  return {name: a.name, url: a.url, mbid: a.mbid || null, listeners: toInt(stats.listeners), playcount: toInt(stats.playcount),
    tags: names(obj(a.tags)), similar: asList(obj(a.similar).artist).map(s => ({name: s.name, url: s.url})),
    bio_summary: cleanText(bio.summary), bio: cleanText(bio.content), published: bio.published};
}

function tokenRatio(needle, hay) {
  const tokens = needle.split(' ').filter(Boolean);
  return tokens.length ? tokens.filter(t => hay.has(t)).length / tokens.length : 0;
}

/** El título sin palabras genéricas: «Epiphany Remixes» también es «Epiphany (X Remix)». */
function titleCore(album) {
  const tokens = norm(album).split(' ').filter(Boolean);
  const core = tokens.filter(t => !GENERIC_WORDS.has(t));
  return (core.length ? core : tokens).join(' ');
}

export function ytQuery(artist, album, rtype, owner) {
  const who = isVarious(artist) ? owner : artist;
  return `${who} ${album}`.trim() + (LONG_TYPES.has(rtype) ? ' full album' : '');
}

/** Solo vídeos cuyo título o canal nombran disco y artista (o el dueño del catálogo si es un
 * recopilatorio de varios: el título solo no basta), los mejores primero. Muchos EP solo están
 * subidos pista a pista: valen también, detrás, los que nombran una de sus canciones o su
 * número de catálogo. */
export function rankVideos(entries, artist, album, rtype, {totalSecs = 0, owner = '', tracks = [], catno = ''} = {}) {
  const target = totalSecs || (LONG_TYPES.has(rtype) ? 2400 : rtype === 'EP' ? 1200 : 300);
  const nArtist = norm(artist), nAlbum = titleCore(album), nOwner = norm(owner);
  const various = isVarious(artist);
  const nTracks = tracks.map(norm).filter(t => t.length >= 4);
  const nCatno = (catno || '').toLowerCase().replace(/[\W_]+/g, '');
  const albumWords = new Set(nAlbum.split(' '));
  const ranked = [];
  for (const e of entries) {
    if (!e || !e.id) continue;
    const title = norm(e.title), channel = norm(e.channel);
    const hay = new Set(`${title} ${channel}`.split(' '));
    const duration = e.duration || 0;
    if (duration && duration < 30) continue;
    const albumOk = tokenRatio(nAlbum, hay) >= (nAlbum.split(' ').length > 3 ? 0.75 : 1);
    if (!albumOk && !nTracks.some(t => ` ${title} `.includes(` ${t} `))
        && !(nCatno.length >= 5 && title.replace(/ /g, '').includes(nCatno))) continue;
    if (tokenRatio(various ? nOwner : nArtist, hay) < 0.5) continue;
    if (title.split(' ').some(w => BAD_WORDS.has(w) && !albumWords.has(w))) continue;
    let score = duration ? -Math.abs(duration - target) / Math.max(target, 60) : -1;
    if ((title.includes('full album') || title.includes('full ep')) && (LONG_TYPES.has(rtype) || rtype === 'EP')) score += 1;
    if (channel.endsWith(' topic') || (!various && nArtist && channel.includes(nArtist))) score += 0.5;
    if (!albumOk) score -= 3;
    ranked.push([score, {id: e.id, title: e.title || '', channel: e.channel, duration: duration || null}]);
  }
  ranked.sort((x, y) => y[0] - x[0]);
  return ranked.slice(0, 5).map(r => r[1]);
}

/** PT1H2M3S → segundos. */
export function isoDuration(s) {
  const m = /^P(?:(\d+)D)?T?(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/.exec(s || '');
  return m ? (+m[1] || 0) * 86400 + (+m[2] || 0) * 3600 + (+m[3] || 0) * 60 + (+m[4] || 0) : 0;
}

/** Los títulos de la API de YouTube llegan con entidades HTML. */
export function decodeEntities(s) {
  const map = {'&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'"};
  return (s || '').replace(/&(?:amp|lt|gt|quot|#39);/g, m => map[m]);
}
