# Charts de sellos y artistas (versión web)

Escribes el nombre de un sello o de un artista y ves todo lo que ha publicado, con información de Last.fm y vídeos de YouTube. Funciona solo en el navegador, sin servidor: lo que buscas se guarda en su IndexedDB.

Es la versión para GitHub Pages de dos servicios con servidor, `charts_sellos` y `charts_artistas`. Aquellos son más rápidos y buscan los vídeos por adelantado con `yt-dlp`.

## Uso

Pulsa ⚙ y añade tus claves. Se quedan en este navegador y solo se envían a la API de cada servicio.

| Clave | Para qué | Si no la pones |
|---|---|---|
| [API key de Last.fm](https://www.last.fm/api/account/create) | Oyentes, escuchas, etiquetas, portadas y biografías | Solo verás el catálogo, con las portadas de Cover Art Archive |
| Usuario de Last.fm | Tus escuchas de cada disco | No salen |
| [Token de Discogs](https://www.discogs.com/settings/developers) | Segunda fuente de catálogo | Solo se usa MusicBrainz |
| [API key de YouTube](https://console.cloud.google.com/apis/library/youtube.googleapis.com) | Buscar vídeos al pulsar un disco | Pegas los enlaces a mano |

La API key de YouTube conviene restringirla en Google Cloud a la API de YouTube Data y a la dirección de esta web.

## Diferencias con la versión con servidor

- **Vídeos**: se buscan al pulsar cada disco, no por adelantado, porque cada búsqueda gasta 101 unidades de una cuota gratuita de 10 000 al día: unas 100 búsquedas. Lo encontrado queda guardado y no se vuelve a gastar.
- **Trabajos**: solo avanzan con una pestaña abierta. Si la cierras, siguen al volver a abrir sin repetir lo guardado. Con varias pestañas trabaja una sola, para respetar los límites de cada API.
- **Datos**: están en este navegador. No se comparten entre dispositivos, y borrar los datos del sitio los elimina.
- No hay iconos de «ya lo tengo», que dependen de un servicio privado.

## Limitaciones

- Dos ediciones con títulos distintos («Beat» y «Beat (Remastered)») cuentan como discos distintos.
- Un catálogo muy grande tarda: MusicBrainz y Discogs admiten una petición por segundo.
- En `usuario.github.io`, todas las páginas de un mismo usuario comparten el almacenamiento del navegador: cualquier otra página publicada en ese dominio podría leer estas claves. Por eso importa restringirlas.

## Desarrollo

No hay compilación ni dependencias:

```bash
python3 -m http.server 8000
```

```bash
node --test test/
```

- `shared/core.js`: normalizar, clasificar, juntar catálogos y puntuar vídeos. Sin navegador ni red.
- `shared/net.js`: clientes de MusicBrainz, Discogs, Last.fm y YouTube, con ritmo y reintentos.
- `shared/store.js`: IndexedDB.
- `shared/backend.js`: las rutas `/api/*` del servidor, dentro del navegador, y los trabajos.
- `shared/app.js`: la interfaz. La misma de los servicios con servidor.
- `sellos/` y `artistas/`: una página para cada uno, sobre el código de `shared/`.
