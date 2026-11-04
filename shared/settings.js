// Claves de cada usuario: se quedan en este navegador y solo viajan a la API de cada una.
const STORAGE_KEY = 'charts-web:settings';
const FIELDS = [
  {name: 'lastfm_key', label: 'API key de Last.fm', secret: true, url: 'https://www.last.fm/api/account/create',
    help: 'Oyentes, escuchas, etiquetas, portadas y biografías. Sin ella solo verás el catálogo.'},
  {name: 'lastfm_user', label: 'Usuario de Last.fm', help: 'Opcional: añade tus escuchas de cada disco.'},
  {name: 'discogs_token', label: 'Token de Discogs', secret: true, url: 'https://www.discogs.com/settings/developers',
    help: 'Opcional: sin él solo se usa MusicBrainz.'},
  {name: 'youtube_key', label: 'API key de YouTube', secret: true, url: 'https://console.cloud.google.com/apis/library/youtube.googleapis.com',
    help: 'Opcional: busca vídeos al pulsar un disco. La cuota gratuita da unas 100 búsquedas al día. Sin ella puedes pegar enlaces a mano.'},
];

export function getSettings() {
  try { return JSON.parse(localStorage.getItem(STORAGE_KEY)) || {}; } catch (e) { return {}; }
}

const mb = n => (n / 1048576).toFixed(n < 1048576 * 10 ? 1 : 0);

export function openSettings() {
  document.getElementById('settings-overlay')?.remove();
  const values = getSettings();
  const overlay = document.createElement('div');
  overlay.id = 'settings-overlay';
  const box = document.createElement('form');
  box.id = 'settings-box';
  const h = document.createElement('h2');
  h.textContent = 'Configuración';
  box.appendChild(h);
  const note = document.createElement('p');
  note.textContent = 'Todo se guarda solo en este navegador. Las claves viajan únicamente a la API de cada servicio.';
  box.appendChild(note);
  for (const f of FIELDS) {
    const label = document.createElement('label');
    label.textContent = f.label;
    const input = document.createElement('input');
    input.name = f.name;
    input.type = f.secret ? 'password' : 'text';
    input.autocomplete = 'off';
    input.value = values[f.name] || '';
    const small = document.createElement('small');
    small.textContent = f.help + ' ';
    if (f.url) {
      const a = document.createElement('a');
      a.href = f.url;
      a.target = '_blank';
      a.rel = 'noopener';
      a.textContent = 'Conseguirla ↗';
      small.appendChild(a);
    }
    label.append(input, small);
    box.appendChild(label);
  }
  const usage = document.createElement('p');
  usage.id = 'settings-usage';
  box.appendChild(usage);
  navigator.storage?.estimate?.().then(e => {
    usage.textContent = `Datos guardados en este navegador: ${mb(e.usage || 0)} MB.`;
  });
  const row = document.createElement('div');
  row.id = 'settings-actions';
  const cancel = document.createElement('button');
  cancel.type = 'button';
  cancel.className = 'q-btn';
  cancel.textContent = 'Cancelar';
  cancel.addEventListener('click', () => overlay.remove());
  const save = document.createElement('button');
  save.type = 'submit';
  save.className = 'q-btn';
  save.textContent = 'Guardar';
  row.append(cancel, save);
  box.appendChild(row);
  box.addEventListener('submit', e => {
    e.preventDefault();
    const next = {};
    for (const f of FIELDS) next[f.name] = box.elements[f.name].value.trim();
    localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
    overlay.remove();
    window.dispatchEvent(new Event('charts-settings'));
  });
  overlay.addEventListener('mousedown', e => { if (e.target === overlay) overlay.remove(); });
  overlay.appendChild(box);
  document.body.appendChild(overlay);
}

export function installSettingsButton() {
  const btn = document.createElement('button');
  btn.id = 'settings-gear-btn';
  btn.textContent = '⚙';
  btn.title = 'Configuración';
  btn.addEventListener('click', openSettings);
  document.body.appendChild(btn);
}
