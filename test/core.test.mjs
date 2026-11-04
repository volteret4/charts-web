import assert from 'node:assert/strict';
import {test} from 'node:test';
import * as core from '../shared/core.js';

test('norm: como norm() de app.py', () => {
  assert.equal(core.norm('Björk & Sigur Rós!'), 'bjork and sigur ros');
  assert.equal(core.norm('  AC/DC '), 'ac dc');
  assert.equal(core.norm('Mötley  Crüe'), 'motley crue');
  assert.equal(core.norm('坂本龍一'), '坂本龍一');
  assert.equal(core.norm(null), '');
});

test('albumKey unifica Various y Various Artists', () => {
  assert.equal(core.albumKey('Various', 'X'), core.albumKey('Various Artists', 'x'));
});

test('tipos de MusicBrainz: el secundario manda', () => {
  assert.equal(core.mbType({'primary-type': 'Album', 'secondary-types': ['Live']}), 'Live album');
  assert.equal(core.mbType({'primary-type': 'EP'}), 'EP');
  assert.equal(core.mbType({'primary-type': 'Other'}), 'Unknown');
});

test('tipos de Discogs: descripción primero, formato físico después', () => {
  assert.equal(core.discogsType('Vinyl, LP, Album'), 'Album');
  assert.equal(core.discogsType('CD, Comp'), 'Compilation');
  assert.equal(core.discogsType('Vinyl, 12"'), 'EP');
  assert.equal(core.discogsType('Vinyl, 7"'), 'Single');
  assert.equal(core.discogsType('Cass, C20'), 'Unknown');
  assert.equal(core.discogsType(undefined), 'Unknown');
});

test('discogsName quita desambiguaciones', () => {
  assert.equal(core.discogsName('Autechre (2)'), 'Autechre');
  assert.equal(core.discogsName('Björk*'), 'Björk');
});

test('mergeCatalogs: MusicBrainz manda en el tipo y queda el año más antiguo', () => {
  const dc = {artist: 'Autechre', album: 'AMBER', rtype: 'EP', year: 1995, date: '1995', catno: 'WARP 25', mb_rgid: null,
    discogs_url: 'https://discogs/1', main_release: 7, thumb: 't'};
  const mb = {artist: 'Autechre', album: 'Amber', rtype: 'Album', year: 1994, date: '1994-11-07', catno: null, mb_rgid: 'rg1',
    discogs_url: null, main_release: null, thumb: null};
  const [only, ...rest] = core.mergeCatalogs([[dc], [mb]]).values();
  assert.equal(rest.length, 0);
  assert.equal(only.rtype, 'Album');
  assert.equal(only.album, 'Amber');
  assert.equal(only.year, 1994);
  assert.equal(only.discogs_url, 'https://discogs/1');
  assert.equal(only.main_release, 7);
  assert.equal(only.catno, 'WARP 25');
});

test('albumVariants prueba el primer artista y el título sin paréntesis', () => {
  assert.deepEqual([...core.albumVariants('A & B', 'Disco (Deluxe)')], [['A & B', 'Disco (Deluxe)'], ['A', 'Disco (Deluxe)'], ['A & B', 'Disco']]);
  assert.deepEqual([...core.albumVariants('A', 'Disco')], [['A', 'Disco']]);
});

test('cleanText limpia el enlace y el pie de licencia', () => {
  assert.equal(core.cleanText('Hola <b>tú</b> <a href="x">Read more on Last.fm</a>. User-contributed text is available under CC'), 'Hola tú');
  assert.equal(core.cleanText(''), null);
});

test('parseLastfmAlbum descarta la portada vacía y admite campos raros', () => {
  const al = core.parseLastfmAlbum({name: 'X', artist: 'Y', listeners: '10', playcount: '20', tags: '',
    image: [{'#text': 'https://x/2a96cbd8b46e442fc41c2b86b821562f.png'}],
    tracks: {track: {name: 'Solo', duration: '60', url: 'u'}}});
  assert.equal(al.image, null);
  assert.equal(al.listeners, 10);
  assert.deepEqual(al.tags, []);
  assert.deepEqual(al.tracks, [{name: 'Solo', duration: 60, url: 'u'}]);
  assert.equal(al.userplaycount, null);
});

const v = (id, title, channel, duration) => ({id, title, channel, duration});

test('rankVideos filtra lo que no es del disco', () => {
  const out = core.rankVideos([
    v('a', 'Autechre - Amber (full album)', 'Warp', 2400),
    v('b', 'Amber Heard interview', 'News', 600),
    v('c', 'Autechre Amber reaction', 'Fan', 600),
    v('d', 'Autechre - Amber', 'Fan', 10),
    v('e', 'Otro artista - Amber', 'Otro', 2400),
  ], 'Autechre', 'Amber', 'Album');
  assert.deepEqual(out.map(x => x.id), ['a']);
});

test('rankVideos: canal Topic y duración cercana van primero; máximo 5', () => {
  const near = v('near', 'Autechre Amber', 'Autechre - Topic', 2400);
  const far = v('far', 'Autechre Amber', 'Fan', 200);
  assert.deepEqual(core.rankVideos([far, near], 'Autechre', 'Amber', 'Album').map(x => x.id), ['near', 'far']);
  const many = Array.from({length: 8}, (_, i) => v('v' + i, 'Autechre Amber', 'Fan', 2400));
  assert.equal(core.rankVideos(many, 'Autechre', 'Amber', 'Album').length, 5);
});

test('rankVideos: una canción del disco vale, pero detrás', () => {
  const out = core.rankVideos([v('t', 'Autechre - Foil', 'Fan', 300), v('a', 'Autechre Amber', 'Fan', 2400)],
    'Autechre', 'Amber', 'Album', {tracks: ['Foil']});
  assert.deepEqual(out.map(x => x.id), ['a', 't']);
});

test('rankVideos: el catálogo también vale', () => {
  const out = core.rankVideos([v('c', 'WAP 7 CD Autechre', 'Fan', 600)], 'Autechre', 'Disco raro', 'EP', {catno: 'WAP-7CD'});
  assert.deepEqual(out.map(x => x.id), ['c']);
});

test('rankVideos: en recopilatorios de varios se exige al dueño del catálogo', () => {
  const out = core.rankVideos([v('s', 'Warp 10 full album', 'Warp Records', 3000), v('n', 'Warp 10', 'Fan', 3000)],
    'Various Artists', 'Warp 10', 'Compilation', {owner: 'Warp Records'});
  assert.equal(out[0].id, 's');
});

test('ytQuery: «full album» solo en formatos largos, y dueño en recopilatorios', () => {
  assert.equal(core.ytQuery('Autechre', 'Amber', 'Album', ''), 'Autechre Amber full album');
  assert.equal(core.ytQuery('Autechre', 'Garbage', 'EP', ''), 'Autechre Garbage');
  assert.equal(core.ytQuery('Various', 'Warp 10', 'Compilation', 'Warp'), 'Warp Warp 10 full album');
});

test('isoDuration y decodeEntities', () => {
  assert.equal(core.isoDuration('PT1H2M3S'), 3723);
  assert.equal(core.isoDuration('PT45S'), 45);
  assert.equal(core.isoDuration('P1DT1S'), 86401);
  assert.equal(core.isoDuration(''), 0);
  assert.equal(core.decodeEntities('A &amp; B &#39;x&#39;'), "A & B 'x'");
});
