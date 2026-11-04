// IndexedDB: lo que el servidor guarda en SQLite, aquí vive en el navegador.
//   sources   un sello o artista añadido (key = «kind:slug»)
//   releases  qué discos tiene cada uno, con su tipo y año
//   albums    Last.fm, vídeos y enlaces propios; se comparten entre sellos y artistas
//   artists   caché de Last.fm por artista
//   kv        grupos de la barra lateral
const DB_NAME = 'charts-web';
let _db = null;

function open() {
  if (_db) return _db;
  _db = new Promise((resolve, reject) => {
    const r = indexedDB.open(DB_NAME, 1);
    r.onupgradeneeded = () => {
      const d = r.result;
      d.createObjectStore('sources', {keyPath: 'key'});
      const rel = d.createObjectStore('releases', {keyPath: ['source', 'album_key']});
      rel.createIndex('source', 'source');
      rel.createIndex('album', 'album_key');
      d.createObjectStore('albums', {keyPath: 'album_key'});
      d.createObjectStore('artists', {keyPath: 'artist_key'});
      d.createObjectStore('kv');
    };
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
  return _db;
}

const wait = req => new Promise((resolve, reject) => {
  req.onsuccess = () => resolve(req.result);
  req.onerror = () => reject(req.error);
});

/** Una transacción: fn recibe los almacenes pedidos; termina cuando la transacción acaba. */
export async function tx(stores, mode, fn) {
  const t = (await open()).transaction(stores, mode);
  const done = new Promise((resolve, reject) => {
    t.oncomplete = resolve;
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  });
  const result = await fn(...stores.map(s => t.objectStore(s)));
  await done;
  return result;
}

export const req = wait;
export const get = (store, key) => tx([store], 'readonly', s => wait(s.get(key)));
export const put = (store, value, key) => tx([store], 'readwrite', s => wait(key === undefined ? s.put(value) : s.put(value, key)));
export const del = (store, key) => tx([store], 'readwrite', s => wait(s.delete(key)));
export const all = store => tx([store], 'readonly', s => wait(s.getAll()));

/** Lee y reescribe un registro en una misma transacción; null si no existe. */
export const update = (store, key, change) => tx([store], 'readwrite', async s => {
  const row = await wait(s.get(key));
  if (!row) return null;
  change(row);
  await wait(s.put(row));
  return row;
});

/** Los discos de una fuente con sus datos de álbum, de una vez aunque sean miles. */
export const releasesOf = source => tx(['releases', 'albums'], 'readonly', async (rel, alb) => {
  const rows = await wait(rel.index('source').getAll(source));
  const albums = await Promise.all(rows.map(r => wait(alb.get(r.album_key))));
  return rows.map((r, i) => ({...albums[i], ...r}));
});
