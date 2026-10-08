const http = require('http');
const https = require('https');
const url = require('url');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require("child_process");
const { StringDecoder } = require("string_decoder");

const PORT = Number(process.env.RIFFLE_PORT) || 38472;
const { DATA_DIR, CACHE_DIR, CUSTOM_LYRICS_DIR, LYRICS_DIR, THUMBNAILS_DIR, METADATA_PATH, ytDlpCommand, resolveBinary } = require('./platform');

if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive: true });
if (!fs.existsSync(CUSTOM_LYRICS_DIR)) fs.mkdirSync(CUSTOM_LYRICS_DIR, { recursive: true });
if (!fs.existsSync(LYRICS_DIR)) fs.mkdirSync(LYRICS_DIR, { recursive: true });
if (!fs.existsSync(THUMBNAILS_DIR)) fs.mkdirSync(THUMBNAILS_DIR, { recursive: true });

let trackMetadataIndex = {};
try {
  if (fs.existsSync(METADATA_PATH)) {
    trackMetadataIndex = JSON.parse(fs.readFileSync(METADATA_PATH, 'utf-8'));
  }
} catch (e) {
  trackMetadataIndex = {};
}

function saveTrackMetadata(cleanId, meta) {
  if (!cleanId) return;
  trackMetadataIndex[cleanId] = {
    ...(trackMetadataIndex[cleanId] || {}),
    ...meta,
    lastPlayed: Date.now()
  };
  try {
    fs.writeFileSync(METADATA_PATH, JSON.stringify(trackMetadataIndex, null, 2), 'utf-8');
  } catch (e) {}
}

const searchCache = new Map();
const streamUrlCache = new Map();
const lyricsCache = new Map();
const artistCache = new Map();
const vibeCache = new Map();
const downloadingSet = new Set();
const prefetchingSet = new Set();

let currentAppState = {};
const sseClients = new Set();

function broadcastSSE(data) {
  const msg = `data: ${JSON.stringify(data)}\n\n`;
  for (const client of sseClients) {
    try {
      client.write(msg);
    } catch (e) {
      sseClients.delete(client);
    }
  }
}

function cleanTrackId(id) {
  return (id || '').replace(/[^a-zA-Z0-9_-]/g, '_');
}

async function findCachedFile(trackId) {
  const cleanId = cleanTrackId(trackId);
  const extensions = ['.opus', '.webm', '.m4a', '.mp3'];
  for (const ext of extensions) {
    const filePath = path.join(CACHE_DIR, `${cleanId}${ext}`);
    try {
      const stat = await fs.promises.stat(filePath);
      if (stat.size > 60000) {
        const now = new Date();
        try {
          await fs.promises.utimes(filePath, now, now);
        } catch (e) {}
        return filePath;
      }
    } catch (e) {}
  }
  return null;
}

async function pruneDiskCache() {
  try {
    const files = await fs.promises.readdir(CACHE_DIR);
    const now = Date.now();
    for (const file of files) {
      const fullPath = path.join(CACHE_DIR, file);
      try {
        const stat = await fs.promises.stat(fullPath);
        if (file.includes('.temp.')) {
          if (now - stat.mtimeMs > 10 * 60 * 1000) {
            await fs.promises.unlink(fullPath);
          }
          continue;
        }
        if (stat.size < 1000) {
          await fs.promises.unlink(fullPath);
          continue;
        }
      } catch (e) {}
    }
  } catch (e) {
    console.warn('Prune cache error:', e);
  }
}

pruneDiskCache();

function parseDurationSeconds(str) {
  if (!str) return 0;
  const parts = str.split(':').map(Number);
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  return 0;
}

function isSpamOrUnofficial(title, duration, channelName = '') {
  if (duration && (duration < 90 || duration > 420)) return true;

  const t = (title || '').toLowerCase();
  const c = (channelName || '').toLowerCase();
  const combined = `${t} ${c}`;

  const nonMusicWordPatterns = [
    /\blecture\b/i,
    /\btalk\b/i,
    /\bconversation\b/i,
    /\bin conversation\b/i,
    /\bacademy\b/i,
    /\bmasterclass\b/i,
    /\bdocumentary\b/i,
    /\bbehind the scenes\b/i,
    /\bmaking of\b/i,
    /\bexplained\b/i,
    /\bhistory of\b/i,
    /\bhow to\b/i,
    /\bnews\b/i,
    /\blive stream\b/i,
    /\blivestream\b/i,
    /\bfull concert\b/i,
    /\bfull set\b/i,
    /\blive at\b/i,
    /\bofficial video essay\b/i
  ];
  if (nonMusicWordPatterns.some(pat => pat.test(combined))) return true;

  const nonMusicPatterns = [
    /\bepisode\s*\d+/i,
    /\bseason\s*\d+/i,
    /\bs\d+e\d+\b/i,
    /\bep\s*\.?\s*\d+\b/i,
    /\bseries\b/i,
    /\btrailer\b/i,
    /\bteaser\b/i,
    /\bfull movie\b/i,
    /\bshort film\b/i,
    /\bpodcast\b/i,
    /\bgameplay\b/i,
    /\bwalkthrough\b/i,
    /\bplaythrough\b/i,
    /\breview\b/i,
    /\breaction\b/i,
    /\binterview\b/i,
    /\baudiobook\b/i,
    /\bvlog\b/i,
    /\bunboxing\b/i,
    /\btutorial\b/i,
    /\bparody\b/i
  ];
  if (nonMusicPatterns.some(pat => pat.test(combined))) return true;

  const badKeywords = [
    '1 hour', '2 hours', '10 hours', 'hour loop', 'hours loop',
    'full album', 'discography', 'ost compilation', 'soundtrack compilation',
    'playlist mix', 'dj set', 'type beat', 'slowed + reverb', 'slowed down',
    'sped up', 'bass boosted', 'nightcore', 'reaction to', 'reacting to'
  ];
  if (badKeywords.some(bad => combined.includes(bad))) return true;

  return false;
}

function safeJsonParse(value, fallback) {
  try {
    const parsed = JSON.parse(value);
    return parsed ?? fallback;
  } catch (error) {
    return fallback;
  }
}

function getTrackNormalizedKey(artist, title) {
  let a = String(artist || '').toLowerCase();
  let t = String(title || '').toLowerCase();
  t = t.replace(/\s*\([^)]*official[^)]*\)/gi, '')
       .replace(/\s*\[[^\]]*\]/gi, '')
       .replace(/\s*\([^)]*(video|audio|remaster(ed)?|lyrics?|visualizer)[^)]*\)/gi, '');
  t = t.replace(/\s*(feat\.?|ft\.?)\s+[^(\[-]+/gi, '')
       .replace(/\s*\((feat\.?|ft\.?)[^)]*\)/gi, '');
  a = a.replace(/\s*(feat\.?|ft\.?)\s+.*$/gi, '');
  a = a.replace(/[^\p{L}\p{N}\s]/gu, ' ').replace(/\s+/g, ' ').trim();
  t = t.replace(/[^\p{L}\p{N}\s]/gu, ' ').replace(/\s+/g, ' ').trim();
  return `${a}::${t}`;
}

function normalizeTrack(track) {
  if (!track || typeof track !== 'object') return null;
  const title = String(track.title || '').trim();
  const artist = String(track.artist || '').trim();
  const id = String(track.id || track.url || `${artist.toLowerCase()}:${title.toLowerCase()}`).trim();
  if (!id && !title) return null;
  return {
    id,
    title: title || 'untitled',
    artist: artist || 'unknown artist',
    duration: Number(track.duration) || 0,
    thumbnail: track.thumbnail || '',
    url: track.url || '',
    platform: track.platform || 'soundcloud',
    searchQuery: track.searchQuery || ''
  };
}

function normalizeArtistName(name) {
  return String(name || '')
    .replace(/\b(official|vevo|records|topic)\b/gi, '')
    .replace(/[^\w\s&-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

function trackFingerprint(track) {
  const clean = normalizeTrack(track);
  if (!clean) return '';
  return getTrackNormalizedKey(clean.artist, clean.title);
}

const recentlyRecommendedTrackIds = new Set();
const recentlyRecommendedKeys = new Set();

async function searchSoundcloud(query, limit = 14) {
  const cacheKey = `sc:${limit}:${String(query || '').trim().toLowerCase()}`;
  if (searchCache.has(cacheKey)) {
    return searchCache.get(cacheKey);
  }

  const args = [
    `scsearch${limit}:${query}`,
    '--dump-single-json',
    '--flat-playlist',
    '--skip-download',
    '--no-warnings',
    '--no-check-certificates'
  ];
  try {
    const raw = await executeYtDlp(args, 18000);
    const data = JSON.parse(raw);
    const entries = (data.entries || []).map((item) => {
      let thumbnail = '';
      if (item.thumbnails && item.thumbnails.length > 0) {
        thumbnail = item.thumbnails[item.thumbnails.length - 1].url;
      } else if (item.thumbnail) {
        thumbnail = item.thumbnail;
      }

      const cleanTitle = (item.title || 'untitled');
      const cleanArtist = (item.uploader || item.channel || item.artist || 'unknown artist');
      const trackUrl = item.webpage_url || item.url || '';

      return {
        id: String(item.id || Math.random().toString(36).substring(2)),
        title: cleanTitle,
        artist: cleanArtist,
        duration: item.duration || 0,
        thumbnail: thumbnail,
        url: trackUrl,
        platform: 'soundcloud'
      };
    });

    if (entries.length > 0) {
      searchCache.set(cacheKey, entries);
      setTimeout(() => { searchCache.delete(cacheKey); }, 300000);
    }
    return entries;
  } catch (err) {
    return [];
  }
}

function buildDiscoveryQueries(profile) {
  const artists = (profile.topArtists || []).map(a => typeof a === 'string' ? a : a.name).filter(Boolean);
  const shuffled = [...artists].sort(() => Math.random() - 0.5);
  const queries = [];

  if (shuffled.length > 0) {
    queries.push(shuffled[0]);
    if (shuffled.length > 1) {
      queries.push(shuffled[1]);
    }
  }

  if (profile.dominantScript === 'Cyrillic' && shuffled.length > 0) {
    queries.push(`${shuffled[0]} похожие песни`);
  }

  if (queries.length === 0) {
    queries.push('synthwave chill', 'indie electronic');
  }

  return queries;
}

function scoreDiscoveryCandidate(track, profile, heardKeys, heardIds) {
  const normalized = normalizeTrack(track);
  if (!normalized) return null;
  const key = getTrackNormalizedKey(normalized.artist, normalized.title);
  if (!normalized.url || !normalized.id) return null;

  if (heardIds.has(normalized.id) || (key && heardKeys.has(key))) return null;
  if (recentlyRecommendedTrackIds.has(normalized.id) || (key && recentlyRecommendedKeys.has(key))) return null;
  if (isSpamOrUnofficial(normalized.title, normalized.duration, normalized.artist)) return null;

  let score = 1.0;

  if (/-\s*topic$/i.test(normalized.artist || '')) {
    score += 1.5;
  }

  if (/^.+?\s+-\s+.+$/.test(normalized.title || '')) {
    score += 1.0;
  }

  const candArtist = normalizeArtistName(normalized.artist);
  const artistNames = (profile.topArtists || []).map(a => typeof a === 'string' ? a : a.name);
  if (artistNames.some(a => candArtist.includes(a) || a.includes(candArtist))) {
    score += 3.0;
  }

  const isCyrillic = /[\u0400-\u04FF]/.test(normalized.title);
  if (profile.dominantScript === 'Cyrillic' && isCyrillic) {
    score += 2.0;
  } else if (profile.dominantScript !== 'Cyrillic' && !isCyrillic) {
    score += 1.0;
  }

  if (normalized.duration > 0 && profile.typicalDuration > 0) {
    const delta = Math.abs(normalized.duration - profile.typicalDuration);
    score += Math.max(0, 2.0 - (delta / 60));
  }

  score += Math.random() * 1.5;

  return {
    ...normalized,
    score
  };
}

async function recommendVibeTracks(historyTracks, favoriteTracks, platform = 'soundcloud', limit = 10, clientProfile = null) {
  const normalizedHistory = historyTracks.map(normalizeTrack).filter(Boolean);
  const normalizedFavorites = favoriteTracks.map(normalizeTrack).filter(Boolean);

  const heardIds = new Set();
  const heardKeys = new Set();
  [...normalizedHistory, ...normalizedFavorites].forEach(track => {
    heardIds.add(track.id);
    const key = getTrackNormalizedKey(track.artist, track.title);
    if (key) heardKeys.add(key);
  });

  const artistCounts = {};
  let cyrillicCount = 0;
  const durations = [];

  [...normalizedFavorites, ...normalizedHistory].forEach(t => {
    if (t.artist && t.artist.trim()) {
      const a = normalizeArtistName(t.artist);
      artistCounts[a] = (artistCounts[a] || 0) + 1;
    }
    if (t.title && /[\u0400-\u04FF]/.test(t.title)) cyrillicCount++;
    if (t.duration > 0) durations.push(t.duration);
  });

  const sortedArtists = Object.entries(artistCounts)
    .sort((a, b) => b[1] - a[1])
    .map(e => e[0]);

  const profile = {
    topArtists: clientProfile?.topArtists || sortedArtists.slice(0, 5),
    dominantScript: clientProfile?.dominantScript || (cyrillicCount > (normalizedFavorites.length + normalizedHistory.length) * 0.35 ? 'Cyrillic' : 'Latin'),
    typicalDuration: clientProfile?.avgDuration || (durations.length > 0 ? Math.round(durations.reduce((a, b) => a + b, 0) / durations.length) : 210),
    trackCount: normalizedFavorites.length + normalizedHistory.length
  };

  if (profile.trackCount < 5 && (!clientProfile || clientProfile.trackCount < 5)) {
    return { profile, tracks: [] };
  }

  const queries = buildDiscoveryQueries(profile);
  const candidateMap = new Map();

  for (const query of queries) {
    try {
      const results = await searchSoundcloud(query, 14);
      for (const track of results) {
        const scored = scoreDiscoveryCandidate(track, profile, heardKeys, heardIds);
        if (scored) {
          if (!candidateMap.has(scored.id) || candidateMap.get(scored.id).score < scored.score) {
            candidateMap.set(scored.id, scored);
          }
        }
      }
      if (candidateMap.size >= limit * 2) {
        break;
      }
    } catch (e) {}
  }

  let ranked = Array.from(candidateMap.values()).sort((a, b) => b.score - a.score);

  const unshown = ranked.filter(t => !recentlyRecommendedTrackIds.has(t.id));
  if (unshown.length >= limit) {
    ranked = unshown;
  }

  const artistTrackCount = {};
  const finalTracks = [];
  for (const track of ranked) {
    const a = normalizeArtistName(track.artist);
    if ((artistTrackCount[a] || 0) < 2) {
      artistTrackCount[a] = (artistTrackCount[a] || 0) + 1;
      finalTracks.push(track);
      recentlyRecommendedTrackIds.add(track.id);
      const nKey = getTrackNormalizedKey(track.artist, track.title);
      if (nKey) recentlyRecommendedKeys.add(nKey);
      if (recentlyRecommendedTrackIds.size > 100) {
        const first = recentlyRecommendedTrackIds.values().next().value;
        recentlyRecommendedTrackIds.delete(first);
      }
      if (recentlyRecommendedKeys.size > 100) {
        const firstK = recentlyRecommendedKeys.values().next().value;
        recentlyRecommendedKeys.delete(firstK);
      }
      if (finalTracks.length >= limit) break;
    }
  }

  return {
    profile,
    tracks: finalTracks
  };
}

function directYoutubeSearch(query, filterSpam = false) {
  return new Promise((resolve) => {
    const searchUrl = `https://www.youtube.com/results?search_query=${encodeURIComponent(query)}`;
    const req = https.get(searchUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                          'Accept-Language': 'en-US,en;q=0.9'
      },
      timeout: 7000
    }, (res) => {
      let html = '';
      const dec = new StringDecoder('utf8');
      res.on('data', chunk => { html += dec.write(chunk); });
      res.on('end', async () => {
        try {
          const match = html.match(/var ytInitialData = ({.*?});<\/script>/);
          if (!match) return resolve([]);

          const json = JSON.parse(match[1]);
          const contents = json.contents?.twoColumnSearchResultsRenderer?.primaryContents?.sectionListRenderer?.contents || [];
          const tracks = [];

          for (const section of contents) {
            const items = section.itemSectionRenderer?.contents || [];
            for (const item of items) {
              const v = item.videoRenderer;
              if (v && v.videoId) {
                const vidId = v.videoId;
                const title = (v.title?.runs?.[0]?.text || 'untitled');
                const artist = (v.ownerText?.runs?.[0]?.text || 'unknown artist');
                const durStr = v.lengthText?.simpleText || '0:00';
                const durSec = parseDurationSeconds(durStr);
                const thumbs = v.thumbnail?.thumbnails || [];
                const thumbnail = thumbs.length > 0 ? thumbs[thumbs.length - 1].url : '';

                if (filterSpam && isSpamOrUnofficial(title, durSec, artist)) {
                  continue;
                }

                const isCached = await findCachedFile(vidId);

                tracks.push({
                  id: vidId,
                  title: title,
                  artist: artist,
                  duration: durSec,
                  thumbnail: thumbnail,
                  url: `https://www.youtube.com/watch?v=${vidId}`,
                  platform: 'youtube',
                  isCached: !!isCached
                });
              }
            }
          }
          resolve(tracks);
        } catch (e) {
          resolve([]);
        }
      });
    });

    req.on('error', () => resolve([]));
    req.on('timeout', () => { req.destroy(); resolve([]); });
  });
}

const SPOTIFY_URL_RE = /open\.spotify\.com\/(?:intl-[a-z-]+\/)?(?:embed\/)?(track|album|playlist)\/([A-Za-z0-9]+)/i;
const TIKTOK_URL_RE = /^https?:\/\/(?:[a-z]+\.)?tiktok\.com\//i;

function pickImage(images) {
  const list = (images || []).filter(i => i && i.url);
  if (!list.length) return '';
  return list.reduce((a, b) => ((b.maxWidth || b.width || 0) > (a.maxWidth || a.width || 0) ? b : a)).url;
}

// Spotify audio is DRM-protected, so only metadata is read from the public embed page;
// playback goes through the existing searchQuery -> YouTube resolution in app.js.
async function resolveSpotifyLink(link) {
  const m = link.match(SPOTIFY_URL_RE);
  if (!m) return [];
  const [, type, id] = m;
  const res = await fetch(`https://open.spotify.com/embed/${type.toLowerCase()}/${id}`, {
    headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36' }
  });
  if (!res.ok) throw new Error(`spotify returned ${res.status}`);
  const html = await res.text();
  const nd = html.match(/<script id="__NEXT_DATA__" type="application\/json">(.*?)<\/script>/s);
  if (!nd) throw new Error('could not read spotify page');
  const entity = JSON.parse(nd[1])?.props?.pageProps?.state?.data?.entity;
  if (!entity) throw new Error('spotify entity not found');

  const cover = pickImage(entity.visualIdentity?.image) || pickImage(entity.coverArt?.sources);
  const items = entity.type === 'track'
    ? [{ uri: entity.uri, title: entity.title || entity.name, subtitle: (entity.artists || []).map(a => a.name).join(', '), duration: entity.duration }]
    : (entity.trackList || []);

  return items.filter(t => t && t.title).map(t => metadataTrack({
    id: `spotify-${String(t.uri || '').split(':').pop() || Math.random().toString(36).substring(2)}`,
    title: t.title,
    artist: t.subtitle,
    duration: Math.round((Number(t.duration) || 0) / 1000),
    thumbnail: cover
  }));
}

// Catalog-only results (no audio): played through the searchQuery -> YouTube resolution in app.js.
function metadataTrack({ id, title, artist, duration, thumbnail }) {
  artist = artist || 'unknown artist';
  return {
    id,
    title,
    artist,
    duration: duration || 0,
    thumbnail: thumbnail || '',
    url: '',
    platform: 'youtube',
    searchQuery: `${artist.split(',')[0]} ${title} audio`,
    isCached: false
  };
}

const SPOTIFY_CONFIG_PATH = path.join(DATA_DIR, 'spotify.json');
let spotifyToken = { value: null, expiresAt: 0 };

function getSpotifyCredentials() {
  if (process.env.RIFFLE_SPOTIFY_CLIENT_ID && process.env.RIFFLE_SPOTIFY_CLIENT_SECRET) {
    return { clientId: process.env.RIFFLE_SPOTIFY_CLIENT_ID, clientSecret: process.env.RIFFLE_SPOTIFY_CLIENT_SECRET };
  }
  try {
    const cfg = JSON.parse(fs.readFileSync(SPOTIFY_CONFIG_PATH, 'utf-8'));
    if (cfg.clientId && cfg.clientSecret) return cfg;
  } catch (e) {}
  return null;
}

async function fetchSpotifyToken(creds) {
  const res = await fetch('https://accounts.spotify.com/api/token', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Authorization': 'Basic ' + Buffer.from(`${creds.clientId}:${creds.clientSecret}`).toString('base64')
    },
    body: 'grant_type=client_credentials'
  });
  if (!res.ok) throw new Error(`spotify rejected the credentials (${res.status})`);
  const data = await res.json();
  return { value: data.access_token, expiresAt: Date.now() + ((data.expires_in || 3600) - 60) * 1000 };
}

async function searchSpotifyApi(query, limit, creds) {
  if (!spotifyToken.value || Date.now() > spotifyToken.expiresAt) {
    spotifyToken = await fetchSpotifyToken(creds);
  }
  // spotify caps search pages at 10 items for development-mode apps
  const res = await fetch(`https://api.spotify.com/v1/search?type=track&limit=${Math.min(limit, 10)}&q=${encodeURIComponent(query)}`, {
    headers: { 'Authorization': `Bearer ${spotifyToken.value}` }
  });
  if (res.status === 401) spotifyToken = { value: null, expiresAt: 0 };
  if (!res.ok) throw new Error(`spotify search failed (${res.status})`);
  const data = await res.json();
  return (data.tracks?.items || []).map(t => metadataTrack({
    id: `spotify-${t.id}`,
    title: t.name,
    artist: (t.artists || []).map(a => a.name).join(', '),
    duration: Math.round((t.duration_ms || 0) / 1000),
    thumbnail: pickImage((t.album?.images || []).map(i => ({ url: i.url, width: i.width })))
  }));
}

async function searchDeezerCatalog(query, limit) {
  const res = await fetch(`https://api.deezer.com/search?limit=${limit}&q=${encodeURIComponent(query)}`);
  if (!res.ok) throw new Error(`catalog search failed (${res.status})`);
  const data = await res.json();
  return (data.data || []).map(t => metadataTrack({
    id: `deezer-${t.id}`,
    title: t.title,
    artist: t.artist?.name,
    duration: t.duration,
    thumbnail: t.album?.cover_xl || t.album?.cover_big || ''
  }));
}

// Spotify tab: real Spotify catalog when credentials are configured, Deezer's public catalog otherwise.
async function searchSpotifyTab(query, limit) {
  const creds = getSpotifyCredentials();
  if (creds) {
    try {
      return { tracks: await searchSpotifyApi(query, limit, creds), source: 'spotify' };
    } catch (e) {
      console.warn('[spotify] falling back to deezer catalog:', e.message);
    }
  }
  return { tracks: await searchDeezerCatalog(query, limit), source: 'deezer' };
}

const TIKTOK_PROFILE_RE = /tiktok\.com\/@[^/?#]+\/?(?:[?#].*)?$/i;

async function tiktokItemToTrack(item, fallbackUrl) {
  const isOriginal = !item.track || /^original sound/i.test(item.track);
  const title = (isOriginal ? (item.description || item.title) : item.track) || item.track || 'tiktok sound';
  const thumbs = (item.thumbnails || []).filter(t => t && t.url);
  return {
    id: `tiktok-${item.id}`,
    title: title.substring(0, 120),
    artist: (Array.isArray(item.artists) && item.artists.join(', ')) || item.artist || item.uploader || item.creator || 'tiktok',
    duration: item.duration || 0,
    thumbnail: item.thumbnail || (thumbs[0] && thumbs[0].url) || '',
    url: item.webpage_url || item.url || fallbackUrl,
    platform: 'tiktok',
    isCached: !!(await findCachedFile(`tiktok-${item.id}`))
  };
}

// accepts a video link, a profile link or a bare @username
async function resolveTiktokLink(link, limit = 30) {
  if (/^@[\w.]+$/.test(link)) link = `https://www.tiktok.com/${link}`;
  if (TIKTOK_PROFILE_RE.test(link)) {
    const raw = await executeYtDlp(['--flat-playlist', '--dump-single-json', '--playlist-end', String(limit), '--no-warnings', link], 45000);
    const data = JSON.parse(raw);
    const entries = (data.entries || []).filter(e => e && e.id);
    return Promise.all(entries.map(e => tiktokItemToTrack(e, `${link.replace(/[?#].*$/, '').replace(/\/$/, '')}/video/${e.id}`)));
  }
  const raw = await executeYtDlp(['--dump-single-json', '--no-playlist', '--skip-download', '--no-warnings', link], 25000);
  return [await tiktokItemToTrack(JSON.parse(raw), link)];
}

function executeYtDlp(args, timeoutMs = 25000) {
  return new Promise((resolve, reject) => {
    const cmd = ytDlpCommand(args);
    const proc = spawn(cmd.bin, cmd.args, { windowsHide: true });
    let stdout = '';
    let stderr = '';
    const outDecoder = new StringDecoder('utf8');
    const errDecoder = new StringDecoder('utf8');
    let timer = null;

    if (timeoutMs > 0) {
      timer = setTimeout(() => {
        try { proc.kill('SIGKILL'); } catch (e) {}
        reject(new Error(`yt-dlp timed out after ${timeoutMs}ms`));
      }, timeoutMs);
    }

    proc.stdout.on('data', (d) => { stdout += outDecoder.write(d); });
    proc.stderr.on('data', (d) => { stderr += errDecoder.write(d); });

    proc.on('close', (code) => {
      if (timer) clearTimeout(timer);
      if (code === 0 || stdout.trim().length > 0) {
        resolve(stdout);
      } else {
        reject(new Error(stderr || `yt-dlp exited with code ${code}`));
      }
    });

    proc.on('error', (err) => {
      if (timer) clearTimeout(timer);
      reject(err);
    });
  });
}

async function cacheThumbnailToDisk(cleanId, thumbnailUrl) {
  if (!cleanId || !thumbnailUrl || !thumbnailUrl.startsWith('http')) return null;
  const destPath = path.join(THUMBNAILS_DIR, `${cleanId}.jpg`);
  if (fs.existsSync(destPath)) return destPath;
  try {
    const res = await fetch(thumbnailUrl);
    if (!res.ok) return null;
    const buffer = Buffer.from(await res.arrayBuffer());
    if (buffer.length > 500) {
      await fs.promises.writeFile(destPath, buffer);
      return destPath;
    }
  } catch (e) {}
  return null;
}

async function downloadTrackToDisk(trackUrl, trackId, platform, meta = {}) {
  const cleanId = cleanTrackId(trackId);
  if (downloadingSet.has(cleanId) || await findCachedFile(cleanId)) return;
  downloadingSet.add(cleanId);

  const outputPath = path.join(CACHE_DIR, `${cleanId}.opus`);
  const tempPath = path.join(CACHE_DIR, `${cleanId}.temp.opus`);

  const args = [
    '--no-playlist',
    '--no-check-certificates',
    '--no-warnings',
    '-x',
    '--audio-format', 'opus',
    '--audio-quality', '128K',
    '-o', tempPath
  ];

  if (platform === 'youtube') {
    args.push('--extractor-args', 'youtube:player_client=android_creator,android,web');
  }

  args.push(trackUrl);

  if (meta.thumbnail) {
    cacheThumbnailToDisk(cleanId, meta.thumbnail).catch(() => {});
  }

  let cmd;
  try { cmd = ytDlpCommand(args); } catch (e) { downloadingSet.delete(cleanId); console.error(e.message); return; }
  return new Promise((resolve) => {
  const proc = spawn(cmd.bin, cmd.args, { windowsHide: true });
  proc.on('close', async (code) => {
    downloadingSet.delete(cleanId);
    if (code === 0 && fs.existsSync(tempPath)) {
      try {
        const stat = await fs.promises.stat(tempPath);
        if (stat.size > 60000) {
          await fs.promises.rename(tempPath, outputPath);
          saveTrackMetadata(cleanId, {
            id: trackId,
            title: meta.title || '',
            artist: meta.artist || '',
            duration: meta.duration || 0,
            thumbnail: meta.thumbnail || '',
            platform: platform || 'youtube',
            fileSize: stat.size
          });
          getLoudness({ id: cleanId }).catch(() => {});
        } else {
          try { await fs.promises.unlink(tempPath); } catch (e) {}
        }
      } catch (e) {}
    } else {
      if (fs.existsSync(tempPath)) {
        try { await fs.promises.unlink(tempPath); } catch (e) {}
      }
    }
    resolve();
  });

  proc.on('error', () => {
    downloadingSet.delete(cleanId);
    resolve();
  });
  });
}

async function prefetchTrack(trackUrl, trackId, platform) {
  const cleanId = cleanTrackId(trackId);
  if (prefetchingSet.size > 2) return;
  if (await findCachedFile(cleanId) || streamUrlCache.has(cleanId) || prefetchingSet.has(trackUrl)) return;
  prefetchingSet.add(trackUrl);

  try {
    const args = [
      '-g',
      '--no-warnings',
      '--no-playlist',
      '--no-check-certificates'
    ];
    if (platform === 'youtube') {
      args.push('--extractor-args', 'youtube:player_client=android_creator,android,web');
      args.push('-f', 'bestaudio/ba/b');
    }
    args.push(trackUrl);

    const raw = await executeYtDlp(args, 18000);
    const lines = raw.trim().split('\n').filter(l => l.startsWith('http'));
    const streamUrl = lines[0];

    if (streamUrl) {
      const isHls = streamUrl.includes('.m3u8');
      const data = {
        success: true,
        isLocal: false,
        streamUrl: streamUrl,
        isHls: isHls,
        proxyUrl: `http://127.0.0.1:${PORT}/api/audio-proxy?url=${encodeURIComponent(streamUrl)}`
      };
      streamUrlCache.set(cleanId, { timestamp: Date.now(), data });
      downloadTrackToDisk(trackUrl, cleanId, platform);
    }
  } catch (e) {
  } finally {
    prefetchingSet.delete(trackUrl);
  }
}

async function handleSearch(req, res, query, platform = 'youtube', limit = 20) {
  const cacheKey = `${platform}:${query}:${limit}`;
  if (searchCache.has(cacheKey)) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify(searchCache.get(cacheKey)));
  }

  const trimmed = String(query || '').trim();
  const isTiktokQuery = TIKTOK_URL_RE.test(trimmed) || (platform === 'tiktok' && /^@[\w.]+$/.test(trimmed));
  if (SPOTIFY_URL_RE.test(trimmed) || isTiktokQuery || platform === 'spotify' || platform === 'tiktok') {
    try {
      let result;
      if (SPOTIFY_URL_RE.test(trimmed)) {
        result = { success: true, tracks: await resolveSpotifyLink(trimmed) };
      } else if (isTiktokQuery) {
        result = { success: true, tracks: await resolveTiktokLink(trimmed) };
      } else if (platform === 'spotify') {
        result = { success: true, ...(await searchSpotifyTab(trimmed, limit)) };
      } else {
        throw new Error('TikTok has no text search: paste a video link, a profile link or an @username');
      }
      searchCache.set(cacheKey, result);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify(result));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ success: false, error: err.message }));
    }
  }

  if (platform === 'youtube') {
    try {
      const directTracks = await directYoutubeSearch(query);
      if (directTracks && directTracks.length > 0) {
        const result = { success: true, tracks: directTracks.slice(0, limit) };
        searchCache.set(cacheKey, result);

        setTimeout(() => {
          for (let i = 0; i < Math.min(4, directTracks.length); i++) {
            prefetchTrack(directTracks[i].url, directTracks[i].id, 'youtube').catch(() => {});
          }
        }, 50);

        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify(result));
      }
    } catch (e) {}
  }

  const prefix = platform === 'soundcloud' ? `scsearch${limit}:` : `ytsearch${limit}:`;
  const args = [
    `${prefix}${query}`,
    '--dump-single-json',
    '--flat-playlist',
    '--skip-download',
    '--no-warnings',
    '--no-check-certificates'
  ];

  if (platform === 'youtube') {
    args.push('--extractor-args', 'youtube:player_client=android_creator,android,web');
  }

  try {
    const raw = await executeYtDlp(args, 25000);
    const data = JSON.parse(raw);
    const entries = await Promise.all((data.entries || []).map(async (item) => {
      let thumbnail = '';
      if (item.thumbnails && item.thumbnails.length > 0) {
        thumbnail = item.thumbnails[item.thumbnails.length - 1].url;
      } else if (item.thumbnail) {
        thumbnail = item.thumbnail;
      }

      const cleanTitle = (item.title || 'untitled');
      const cleanArtist = (item.uploader || item.channel || item.artist || 'unknown artist');

      let trackUrl = item.webpage_url || item.url;
      if (platform === 'youtube' && !trackUrl) {
        trackUrl = `https://www.youtube.com/watch?v=${item.id}`;
      }

      const isCached = await findCachedFile(item.id);

      return {
        id: String(item.id || Math.random().toString(36).substring(2)),
                                                               title: cleanTitle,
                                                               artist: cleanArtist,
                                                               duration: item.duration || 0,
                                                               thumbnail: thumbnail,
                                                               url: trackUrl,
                                                               platform: platform,
                                                               isCached: !!isCached
      };
    }));

    const result = { success: true, tracks: entries };
    searchCache.set(cacheKey, result);

    setTimeout(() => {
      if (entries[0] && entries[0].url) prefetchTrack(entries[0].url, entries[0].id, platform).catch(() => {});
    }, 60);

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(result));
  } catch (err) {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: false, error: err.message }));
  }
}

async function handleVibeRecommendations(req, res, payload) {
  const historyTracks = Array.isArray(payload?.history) ? payload.history : [];
  const favoriteTracks = Array.isArray(payload?.favorites) ? payload.favorites : [];
  const platform = 'soundcloud';
  const limit = Math.max(4, Math.min(parseInt(payload?.limit || '10', 10) || 10, 16));
  const clientProfile = payload?.clientProfile || null;

  try {
    const result = await recommendVibeTracks(historyTracks, favoriteTracks, platform, limit, clientProfile);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: true, ...result }));
  } catch (error) {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: false, error: error.message }));
  }
}

async function handleStreamInfo(req, res, trackUrl, trackId, platform = 'youtube', title = '', artist = '', duration = 0, thumbnail = '') {
  const cleanId = cleanTrackId(trackId);
  const meta = { title, artist, duration, thumbnail };

  const cachedFile = await findCachedFile(cleanId);
  if (cachedFile) {
    const data = {
      success: true,
      isLocal: true,
      streamUrl: `http://127.0.0.1:${PORT}/api/local-track?id=${encodeURIComponent(cleanId)}`
    };
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify(data));
  }

  if (streamUrlCache.has(cleanId)) {
    const cached = streamUrlCache.get(cleanId);
    if (Date.now() - cached.timestamp < 7200000) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      downloadTrackToDisk(trackUrl, cleanId, platform, meta);
      return res.end(JSON.stringify(cached.data));
    }
  }

  if (platform === 'tiktok') {
    await downloadTrackToDisk(trackUrl, cleanId, platform, meta);
    // a hover prefetch may already be downloading this clip
    for (let i = 0; i < 120 && downloadingSet.has(cleanId); i++) {
      await new Promise(r => setTimeout(r, 500));
    }
    if (await findCachedFile(cleanId)) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({
        success: true,
        isLocal: true,
        streamUrl: `http://127.0.0.1:${PORT}/api/local-track?id=${encodeURIComponent(cleanId)}`
      }));
    }
    res.writeHead(500, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ success: false, error: 'could not download tiktok audio' }));
  }

  let streamUrl = null;

  try {
    const args = ['-g', '--no-warnings', '--no-playlist', '--no-check-certificates', '-f', 'bestaudio/ba/b'];
    if (platform === 'youtube') {
      args.push('--extractor-args', 'youtube:player_client=android_creator,android,web');
    }
    args.push(trackUrl);
    const raw = await executeYtDlp(args, 18000);
    const lines = raw.trim().split('\n').map(l => l.trim()).filter(l => l.startsWith('http'));
    if (lines.length > 0) streamUrl = lines[0];
  } catch (e) {}

  if (!streamUrl && (title || artist || trackUrl)) {
    try {
      const q = `${artist} ${title}`.trim() || trackUrl;
      const scArgs = ['-g', '--no-warnings', '--no-playlist', '--no-check-certificates', `scsearch1:${q}`];
      const scRaw = await executeYtDlp(scArgs, 15000);
      const scLines = scRaw.trim().split('\n').map(l => l.trim()).filter(l => l.startsWith('http'));
      if (scLines.length > 0) streamUrl = scLines[0];
    } catch (e) {}
  }

  if (!streamUrl) {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ success: false, error: 'could not extract audio stream' }));
  }

  const isHls = streamUrl.includes('.m3u8');
  const data = {
    success: true,
    isLocal: false,
    streamUrl: streamUrl,
    isHls: isHls,
    proxyUrl: `http://127.0.0.1:${PORT}/api/audio-proxy?url=${encodeURIComponent(streamUrl)}`
  };

  streamUrlCache.set(cleanId, { timestamp: Date.now(), data });
  downloadTrackToDisk(trackUrl, cleanId, platform, meta);

  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

async function fetchArtistInfo(artistName) {
  const cleanName = (artistName || '').replace(/ - Topic|VEVO|Official|Records/gi, '').trim();
  const cacheKey = cleanName.toLowerCase();
  if (artistCache.has(cacheKey)) return artistCache.get(cacheKey);

  let bio = '';
  let avatar = '';
  let isVerified = false;
  let tracks = [];

  try {
    const dzUrl = `https://api.deezer.com/search/artist?q=${encodeURIComponent(cleanName)}`;
    const dzData = await new Promise((resolve) => {
      https.get(dzUrl, { headers: { 'User-Agent': 'Mozilla/5.0' }, timeout: 4000 }, (dRes) => {
        let d = '';
        dRes.on('data', c => d += c);
        dRes.on('end', () => {
          try { resolve(JSON.parse(d)); } catch (e) { resolve(null); }
        });
      }).on('error', () => resolve(null));
    });

    if (dzData && dzData.data && dzData.data.length > 0) {
      const topArtist = dzData.data[0];
      avatar = topArtist.picture_xl || topArtist.picture_big || topArtist.picture_medium || '';
      isVerified = (topArtist.nb_fan || 0) > 30000;

      if (topArtist.tracklist) {
        const tlistData = await new Promise((resolve) => {
          https.get(topArtist.tracklist, { headers: { 'User-Agent': 'Mozilla/5.0' }, timeout: 4000 }, (tRes) => {
            let td = '';
            tRes.on('data', c => td += c);
            tRes.on('end', () => {
              try { resolve(JSON.parse(td)); } catch (e) { resolve(null); }
            });
          }).on('error', () => resolve(null));
        });

        if (tlistData && Array.isArray(tlistData.data)) {
          for (const item of tlistData.data) {
            const dur = item.duration || 180;
            if (dur >= 50 && dur <= 450 && !isSpamOrUnofficial(item.title, dur)) {
              tracks.push({
                id: `dz_${item.id}`,
                title: (item.title || 'untitled'),
                          artist: (item.artist?.name || cleanName),
                          duration: dur,
                          thumbnail: item.album?.cover_medium || item.album?.cover_big || avatar,
                          url: `https://www.youtube.com/results?search_query=${encodeURIComponent(cleanName + ' - ' + item.title + ' official audio')}`,
                          searchQuery: `${cleanName} - ${item.title} official audio`,
                          platform: 'youtube',
                          isCached: false
              });
            }
          }
        }
      }
    }
  } catch (e) {}

  try {
    const wikiUrl = `https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(cleanName)}`;
    const wikiData = await new Promise((resolve) => {
      https.get(wikiUrl, { headers: { 'User-Agent': 'devsize/2.0' }, timeout: 3500 }, (wRes) => {
        let d = '';
        wRes.on('data', c => d += c);
        wRes.on('end', () => {
          try { resolve(JSON.parse(d)); } catch (e) { resolve(null); }
        });
      }).on('error', () => resolve(null));
    });

    if (wikiData && wikiData.extract) {
      bio = wikiData.extract;
      if (!avatar && wikiData.originalimage?.source) {
        avatar = wikiData.originalimage.source;
      }
    }
  } catch (e) {}

  if (tracks.length === 0) {
    try {
      const ytOfficialTracks = await directYoutubeSearch(`${cleanName} official audio`, true);
      tracks = (ytOfficialTracks || []).filter(t => !isSpamOrUnofficial(t.title, t.duration)).slice(0, 25);
    } catch (e) {}
  }

  const result = {
    name: cleanName,
    bio: bio || 'artist biography available across streaming networks.',
    avatar: avatar || (tracks[0] ? tracks[0].thumbnail : ''),
    isVerified: isVerified,
    tracks: tracks.slice(0, 35)
  };

  artistCache.set(cacheKey, result);
  return result;
}

async function handleLocalTrack(req, res, trackId) {
  const cleanId = cleanTrackId(trackId);
  const filePath = await findCachedFile(cleanId);

  if (!filePath) {
    res.writeHead(404);
    return res.end('File not found in local cache');
  }

  return serveAudioFile(req, res, filePath);
}

async function serveAudioFile(req, res, filePath) {
  try {
    const stat = await fs.promises.stat(filePath);
    const fileSize = stat.size;
    const range = req.headers.range;

    const contentType = AUDIO_MIME[path.extname(filePath).toLowerCase()] || 'audio/mpeg';

    if (range) {
      const parts = range.replace(/bytes=/, "").split("-");
      const start = parseInt(parts[0], 10);
      const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;
      const chunksize = (end - start) + 1;
      const file = fs.createReadStream(filePath, { start, end });
      const head = {
        'Content-Range': `bytes ${start}-${end}/${fileSize}`,
        'Accept-Ranges': 'bytes',
        'Content-Length': chunksize,
        'Content-Type': contentType,
      };
      res.writeHead(206, head);
      file.pipe(res);
    } else {
      const head = {
        'Content-Length': fileSize,
        'Content-Type': contentType,
        'Accept-Ranges': 'bytes'
      };
      res.writeHead(200, head);
      fs.createReadStream(filePath).pipe(res);
    }
  } catch (e) {
    res.writeHead(500);
    res.end('Error reading local file');
  }
}

function handleAudioProxy(req, res, targetUrl) {
  if (!targetUrl) {
    res.writeHead(400);
    return res.end('Missing url');
  }

  try {
    const parsed = new URL(targetUrl);
    const client = parsed.protocol === 'https:' ? https : http;

    const headers = { ...req.headers, host: parsed.host };
    delete headers['connection'];

    const proxyReq = client.request(targetUrl, {
      method: req.method,
      headers: headers
    }, (proxyRes) => {
      res.writeHead(proxyRes.statusCode, proxyRes.headers);
      proxyRes.pipe(res);
    });

    proxyReq.on('error', (e) => {
      if (!res.headersSent) res.writeHead(502);
      res.end(e.message);
    });

    req.pipe(proxyReq);
  } catch (e) {
    res.writeHead(500);
    res.end(e.message);
  }
}

// downloads go to the app's own folder (Music\Riffle), listed in the Saved view
let DOWNLOADS_DIR;
try { DOWNLOADS_DIR = path.join(require('electron').app.getPath('music'), 'Riffle'); } catch (e) { DOWNLOADS_DIR = path.join(os.homedir(), 'Music', 'Riffle'); }
if (!fs.existsSync(DOWNLOADS_DIR)) {
  try { fs.mkdirSync(DOWNLOADS_DIR, { recursive: true }); } catch (e) {}
}

const SAVED_INDEX_PATH = path.join(DOWNLOADS_DIR, '.riffle-saved.json');
const DOWNLOAD_TIMEOUT_MS = 15 * 60 * 1000;
const SAVED_AUDIO_RE = /\.(mp3|m4a|flac|opus|wav|ogg|webm)$/i;
const AUDIO_MIME = {
  '.opus': 'audio/ogg; codecs=opus',
  '.ogg': 'audio/ogg',
  '.webm': 'audio/webm',
  '.m4a': 'audio/mp4',
  '.mp3': 'audio/mpeg',
  '.flac': 'audio/flac',
  '.wav': 'audio/wav'
};

function readSavedIndex() {
  try { return JSON.parse(fs.readFileSync(SAVED_INDEX_PATH, 'utf-8')) || {}; } catch (e) { return {}; }
}

function writeSavedIndex(index) {
  try { fs.writeFileSync(SAVED_INDEX_PATH, JSON.stringify(index, null, 2), 'utf-8'); } catch (e) {}
}

// only plain file names inside DOWNLOADS_DIR, never a path out of it
function resolveSavedFile(name) {
  if (!name || path.basename(name) !== name || !SAVED_AUDIO_RE.test(name)) return null;
  const filePath = path.join(DOWNLOADS_DIR, name);
  return fs.existsSync(filePath) ? filePath : null;
}

async function listSavedTracks() {
  const index = readSavedIndex();
  const tracks = [];
  let files = [];
  try { files = await fs.promises.readdir(DOWNLOADS_DIR); } catch (e) {}
  for (const file of files) {
    if (!SAVED_AUDIO_RE.test(file)) continue;
    let stat;
    try { stat = await fs.promises.stat(path.join(DOWNLOADS_DIR, file)); } catch (e) { continue; }
    const meta = index[file] || {};
    const base = file.replace(SAVED_AUDIO_RE, '');
    const dash = base.indexOf(' - ');
    const cleanId = meta.id ? cleanTrackId(meta.id) : '';
    tracks.push({
      id: meta.id || `saved:${file}`,
      title: meta.title || (dash > 0 ? base.slice(dash + 3) : base),
      artist: meta.artist || (dash > 0 ? base.slice(0, dash) : 'unknown artist'),
      duration: meta.duration || 0,
      thumbnail: meta.thumbnail || '',
      localThumbnail: cleanId && fs.existsSync(path.join(THUMBNAILS_DIR, `${cleanId}.jpg`)) ? `http://127.0.0.1:${PORT}/api/local-thumbnail?id=${cleanId}` : '',
      url: meta.url || '',
      platform: meta.platform || 'youtube',
      savedFile: file,
      fileSize: stat.size,
      savedAt: meta.savedAt || stat.mtimeMs
    });
  }
  tracks.sort((a, b) => b.savedAt - a.savedAt);
  return tracks;
}

function sanitizeFilename(str) {
  return (str || 'track')
  .replace(/[<>:"/\\|?*]/g, '')
  .replace(/\s+/g, ' ')
  .trim();
}

async function handleDownload(req, res, trackUrl, title, artist, format = 'mp3', quality = '0', meta = {}) {
  if (!trackUrl && (!title || !artist)) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ success: false, error: 'missing track information' }));
  }

  const cleanTitle = sanitizeFilename(title || 'untitled');
  const cleanArtist = sanitizeFilename(artist || 'unknown artist');
  const validFormats = ['mp3', 'm4a', 'flac', 'opus', 'wav'];
  const ext = validFormats.includes(format.toLowerCase()) ? format.toLowerCase() : 'mp3';
  const outFilename = `${cleanArtist} - ${cleanTitle}.${ext}`;
  const outPath = path.join(DOWNLOADS_DIR, outFilename);
  const tempTemplate = path.join(DOWNLOADS_DIR, `${cleanArtist} - ${cleanTitle}.%(ext)s`);

  let targetUrl = trackUrl;
  if (!targetUrl || targetUrl.includes('deezer.com') || targetUrl.includes('spotify.com')) {
    targetUrl = `ytsearch1:${cleanArtist} ${cleanTitle} official audio`;
  }

  // yt-dlp leftovers for this track: partial fragments, resume state, unembedded covers
  async function cleanupLeftovers() {
    const prefix = `${cleanArtist} - ${cleanTitle}.`;
    let files = [];
    try { files = await fs.promises.readdir(DOWNLOADS_DIR); } catch (e) { return; }
    for (const file of files) {
      if (!file.startsWith(prefix) || file === outFilename) continue;
      if (/\.(part|ytdl|jpg|jpeg|png|webp)$/i.test(file) || /\.part-Frag\d+/i.test(file) || /\.temp\./i.test(file)) {
        try { await fs.promises.unlink(path.join(DOWNLOADS_DIR, file)); } catch (e) {}
      }
    }
  }

  function recordSaved() {
    const index = readSavedIndex();
    index[outFilename] = {
      id: meta.id || '',
      title: title || cleanTitle,
      artist: artist || cleanArtist,
      duration: Number(meta.duration) || 0,
      thumbnail: meta.thumbnail || '',
      url: trackUrl || '',
      platform: meta.platform || 'youtube',
      savedAt: Date.now()
    };
    writeSavedIndex(index);
  }

  const args = [
    '--no-playlist',
    '--no-check-certificates',
    '--no-warnings',
    '-x',
    '--audio-format', ext,
    '--audio-quality', quality.toString(),
    '--embed-thumbnail',
    '--add-metadata',
    '-o', tempTemplate,
    '--extractor-args', 'youtube:player_client=android_creator,android,web',
    targetUrl
  ];

  try {
    await executeYtDlp(args, DOWNLOAD_TIMEOUT_MS);
    recordSaved();
    await cleanupLeftovers();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      success: true,
      filename: outFilename,
      path: outPath,
      directory: DOWNLOADS_DIR
    }));
  } catch (err) {
    try {
      const fallbackArgs = [
        '--no-playlist',
        '--no-check-certificates',
        '--no-warnings',
        '-x',
        '--audio-format', ext,
        '--audio-quality', quality.toString(),
        '-o', tempTemplate,
        targetUrl
      ];
      await executeYtDlp(fallbackArgs, DOWNLOAD_TIMEOUT_MS);
      recordSaved();
      await cleanupLeftovers();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        success: true,
        filename: outFilename,
        path: outPath,
        directory: DOWNLOADS_DIR
      }));
    } catch (e2) {
      await cleanupLeftovers();
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, error: e2.message || err.message }));
    }
  }
}

function sanitizeForLyrics(title, artist) {
  let cleanTitle = (title || '')
  .replace(/\[.*?\]|\(.*?\)/g, '')
  .replace(/official\s*(music)?\s*video|official\s*audio|lyrics|hd|4k|remastered|visualizer|clip\s*officiel|video\s*clip/gi, '')
  .replace(/ft\.?|feat\.?/gi, '')
  .replace(/[^\w\s\u0400-\u04FF]/gi, ' ')
  .replace(/\s+/g, ' ')
  .trim();

  let cleanArtist = (artist || '')
  .replace(/\[.*?\]|\(.*?\)/g, '')
  .replace(/- topic|vevo|records|official/gi, '')
  .replace(/[^\w\s\u0400-\u04FF]/gi, ' ')
  .replace(/\s+/g, ' ')
  .trim();

  return { cleanTitle, cleanArtist };
}

function fetchLyricsDirect(title, artist) {
  return new Promise((resolve) => {
    const { cleanTitle, cleanArtist } = sanitizeForLyrics(title, artist);
    const apiUrl = `https://lrclib.net/api/get?track_name=${encodeURIComponent(cleanTitle)}&artist_name=${encodeURIComponent(cleanArtist)}`;

    https.get(apiUrl, { headers: { 'User-Agent': 'devsize/2.0' }, timeout: 4000 }, (res) => {
      let data = '';
      const dec = new StringDecoder('utf8');
      res.on('data', c => data += dec.write(c));
      res.on('end', () => {
        try {
          if (res.statusCode === 200) {
            const parsed = JSON.parse(data);
            if (parsed.syncedLyrics || parsed.plainLyrics) {
              return resolve(parsed.syncedLyrics || parsed.plainLyrics);
            }
          }
        } catch (e) {}

        const query = `${cleanArtist} ${cleanTitle}`.trim();
        const searchUrl = `https://lrclib.net/api/search?q=${encodeURIComponent(query)}`;
        https.get(searchUrl, { headers: { 'User-Agent': 'devsize/2.0' }, timeout: 4000 }, (res2) => {
          let data2 = '';
          res2.on('data', c => data2 += c);
          res2.on('end', () => {
            try {
              const list = JSON.parse(data2);
              if (Array.isArray(list) && list.length > 0) {
                const withSynced = list.find(item => item.syncedLyrics);
                if (withSynced) return resolve(withSynced.syncedLyrics);
                return resolve(list[0].syncedLyrics || list[0].plainLyrics || null);
              }
            } catch (e) {}
            resolve(null);
          });
        }).on('error', () => resolve(null));
      });
    }).on('error', () => resolve(null));
  });
}

function getCustomLyricsPath(title, artist) {
  const safeName = `${(artist || 'unknown').replace(/[^\w\s-]/g, '_')}_${(title || 'untitled').replace(/[^\w\s-]/g, '_')}.lrc`.toLowerCase().replace(/\s+/g, '_');
  return path.join(CUSTOM_LYRICS_DIR, safeName);
}

function getFetchedLyricsPath(title, artist) {
  const cleanTitle = (title || '').replace(/[^a-zA-Z0-9_-]/g, '_').toLowerCase();
  const cleanArtist = (artist || '').replace(/[^a-zA-Z0-9_-]/g, '_').toLowerCase();
  return path.join(LYRICS_DIR, `${cleanArtist}___${cleanTitle}.lrc`);
}

async function handleLyrics(req, res, title, artist, allowOnline = true) {
  const cacheKey = `${artist}:${title}`;
  if (lyricsCache.has(cacheKey)) {
    const cached = lyricsCache.get(cacheKey);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ success: true, lyrics: cached.text, isCustom: cached.isCustom || false }));
  }

  const customPath = getCustomLyricsPath(title, artist);
  if (fs.existsSync(customPath)) {
    try {
      const customLyrics = await fs.promises.readFile(customPath, 'utf-8');
      lyricsCache.set(cacheKey, { text: customLyrics, isCustom: true });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ success: true, lyrics: customLyrics, isCustom: true }));
    } catch (e) {}
  }

  const fetchedLyricsPath = getFetchedLyricsPath(title, artist);
  if (fs.existsSync(fetchedLyricsPath)) {
    try {
      const diskLyrics = await fs.promises.readFile(fetchedLyricsPath, 'utf-8');
      lyricsCache.set(cacheKey, { text: diskLyrics, isCustom: false });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ success: true, lyrics: diskLyrics, isCustom: false }));
    } catch (e) {}
  }

  if (!allowOnline) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ success: true, lyrics: '' }));
  }

  try {
    const rawLyrics = await fetchLyricsDirect(title, artist);
    if (rawLyrics && rawLyrics.trim().length > 0) {
      try {
        await fs.promises.writeFile(fetchedLyricsPath, rawLyrics, 'utf-8');
      } catch (e) {}
    }
    lyricsCache.set(cacheKey, { text: rawLyrics, isCustom: false });

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: true, lyrics: rawLyrics }));
  } catch (err) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: true, lyrics: '' }));
  }
}

async function handleSaveCustomLyrics(req, res, title, artist) {
  let body = '';
  req.on('data', chunk => body += chunk);
  req.on('end', async () => {
    try {
      const { lyrics } = JSON.parse(body);
      if (!lyrics) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ success: false, error: 'No lyrics provided' }));
      }

      const customPath = getCustomLyricsPath(title, artist);
      await fs.promises.writeFile(customPath, lyrics, 'utf-8');

      const cacheKey = `${artist}:${title}`;
      lyricsCache.delete(cacheKey);

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true }));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, error: e.message }));
    }
  });
}

// loudness: integrated LUFS + true peak measured once per file with ffmpeg's loudnorm, one job at a time
const loudnessJobs = new Map();
let loudnessChain = Promise.resolve();

function measureLoudness(filePath) {
  const ffmpeg = resolveBinary('ffmpeg');
  if (!ffmpeg) return Promise.reject(new Error('ffmpeg not found'));
  return new Promise((resolve, reject) => {
    const proc = spawn(ffmpeg, ['-hide_banner', '-nostats', '-i', filePath, '-vn', '-sn', '-dn', '-af', 'loudnorm=print_format=json', '-f', 'null', '-'], { windowsHide: true });
    let stderr = '';
    const timer = setTimeout(() => { try { proc.kill('SIGKILL'); } catch (e) {} }, 120000);
    proc.stderr.on('data', d => { stderr += d.toString(); if (stderr.length > 200000) stderr = stderr.slice(-20000); });
    proc.on('error', (e) => { clearTimeout(timer); reject(e); });
    proc.on('close', () => {
      clearTimeout(timer);
      const match = stderr.match(/\{[^{}]*"input_i"[^{}]*\}/);
      const json = match ? safeJsonParse(match[0], null) : null;
      const lufs = json ? parseFloat(json.input_i) : NaN;
      const peak = json ? parseFloat(json.input_tp) : NaN;
      if (!isFinite(lufs) || lufs < -70) return reject(new Error('could not measure loudness'));
      resolve({ lufs: Math.round(lufs * 10) / 10, peak: isFinite(peak) ? Math.round(peak * 10) / 10 : 0 });
    });
  });
}

function queueLoudness(key, filePath, store) {
  if (loudnessJobs.has(key)) return loudnessJobs.get(key);
  const job = loudnessChain.then(() => measureLoudness(filePath)).then((result) => {
    store(result);
    return result;
  }).finally(() => loudnessJobs.delete(key));
  loudnessChain = job.catch(() => {});
  loudnessJobs.set(key, job);
  return job;
}

// saved songs keep their value in .riffle-saved.json, cached streams in metadata.json
async function getLoudness({ saved, id }) {
  if (saved) {
    const filePath = resolveSavedFile(saved);
    if (!filePath) return { pending: false };
    const known = (readSavedIndex()[saved] || {}).loudness;
    if (known) return known;
    return queueLoudness(`saved:${saved}`, filePath, (result) => {
      const index = readSavedIndex();
      index[saved] = { ...(index[saved] || {}), loudness: result };
      writeSavedIndex(index);
    });
  }
  const cleanId = cleanTrackId(id);
  if (!cleanId) return { pending: false };
  const known = (trackMetadataIndex[cleanId] || {}).loudness;
  if (known) return known;
  const filePath = await findCachedFile(cleanId);
  // still streaming: the background download lands in the cache shortly
  if (!filePath) return { pending: true };
  return queueLoudness(`cache:${cleanId}`, filePath, (result) => {
    trackMetadataIndex[cleanId] = { ...(trackMetadataIndex[cleanId] || {}), loudness: result };
    try { fs.writeFileSync(METADATA_PATH, JSON.stringify(trackMetadataIndex, null, 2), 'utf-8'); } catch (e) {}
  });
}

// autoplay: YouTube's own "mix" playlist for the seed video (RD<id>), searched first for non-YouTube seeds
const YT_ID_RE = /^[A-Za-z0-9_-]{11}$/;
const radioCache = new Map();

function youtubeIdOf(track) {
  const fromUrl = (track.url || '').match(/(?:v=|youtu\.be\/)([A-Za-z0-9_-]{11})/);
  if (fromUrl) return fromUrl[1];
  return YT_ID_RE.test(track.id || '') && (track.platform || 'youtube') === 'youtube' ? track.id : null;
}

async function radioTracks(seed, limit = 15) {
  let videoId = youtubeIdOf(seed);
  if (!videoId) {
    const q = `${seed.artist || ''} ${seed.title || ''}`.trim();
    if (!q) return [];
    const found = await directYoutubeSearch(q, true);
    videoId = found[0] && found[0].id;
    if (!videoId) return [];
  }
  if (radioCache.has(videoId)) return radioCache.get(videoId);

  const raw = await executeYtDlp([
    '--flat-playlist', '-J', '--no-warnings', '--no-check-certificates',
    '--playlist-end', String(limit + 10),
    `https://www.youtube.com/watch?v=${videoId}&list=RD${videoId}`
  ], 25000);
  const data = safeJsonParse(raw, {});
  const tracks = [];
  for (const entry of data.entries || []) {
    if (!entry || !YT_ID_RE.test(entry.id || '') || entry.id === videoId) continue;
    const duration = Number(entry.duration) || 0;
    const artist = entry.channel || entry.uploader || 'unknown artist';
    const title = entry.title || 'untitled';
    if (duration && (duration < 60 || duration > 900)) continue;
    if (isSpamOrUnofficial(title, duration, artist)) continue;
    const thumbs = Array.isArray(entry.thumbnails) ? entry.thumbnails : [];
    tracks.push({
      id: entry.id,
      title,
      artist,
      duration,
      thumbnail: thumbs.length ? thumbs[thumbs.length - 1].url : `https://i.ytimg.com/vi/${entry.id}/hqdefault.jpg`,
      url: `https://www.youtube.com/watch?v=${entry.id}`,
      platform: 'youtube',
      autoplay: true
    });
    if (tracks.length >= limit) break;
  }
  radioCache.set(videoId, tracks);
  return tracks;
}

// search box autocomplete: YouTube's public suggestion endpoint, cached per query
const suggestCache = new Map();

async function fetchSuggestions(query) {
  const q = String(query || '').trim().toLowerCase();
  if (!q || q.length > 120 || /^https?:\/\//i.test(q)) return [];
  if (suggestCache.has(q)) return suggestCache.get(q);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 3500);
  try {
    const res = await fetch(`https://suggestqueries.google.com/complete/search?client=firefox&ds=yt&q=${encodeURIComponent(q)}`, { signal: controller.signal });
    const data = await res.json();
    const list = Array.isArray(data && data[1]) ? data[1].filter(s => typeof s === 'string').slice(0, 8) : [];
    if (suggestCache.size > 300) suggestCache.clear();
    suggestCache.set(q, list);
    return list;
  } catch (e) {
    return [];
  } finally {
    clearTimeout(timer);
  }
}

const server = http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    return res.end();
  }

  const parsedUrl = url.parse(req.url, true);

  if (parsedUrl.pathname === '/api/state' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try {
        const state = JSON.parse(body);
        currentAppState = state;
        broadcastSSE(state);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true }));
      } catch (e) {
        res.writeHead(400); res.end();
      }
    });
    return;
  }

  if (parsedUrl.pathname === '/api/lyrics-stream') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'Access-Control-Allow-Origin': '*'
    });
    sseClients.add(res);
    res.write(`data: ${JSON.stringify(currentAppState)}\n\n`);
    req.on('close', () => sseClients.delete(res));
    return;
  }

  if (parsedUrl.pathname === '/api/download') {
    const trackUrl = parsedUrl.query.url || '';
    const title = parsedUrl.query.title || '';
    const artist = parsedUrl.query.artist || '';
    const format = parsedUrl.query.format || 'mp3';
    const quality = parsedUrl.query.quality || '0';
    const meta = {
      id: parsedUrl.query.id || '',
      thumbnail: parsedUrl.query.thumbnail || '',
      duration: parsedUrl.query.duration || 0,
      platform: parsedUrl.query.platform || ''
    };
    return handleDownload(req, res, trackUrl, title, artist, format, quality, meta);
  }

  if (parsedUrl.pathname === '/api/saved-library') {
    const tracks = await listSavedTracks();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ success: true, directory: DOWNLOADS_DIR, tracks }));
  }

  if (parsedUrl.pathname === '/api/saved-file') {
    const filePath = resolveSavedFile(parsedUrl.query.name || '');
    if (!filePath) {
      res.writeHead(404);
      return res.end('Saved file not found');
    }
    return serveAudioFile(req, res, filePath);
  }

  if (parsedUrl.pathname === '/api/saved-delete' && req.method === 'POST') {
    const name = parsedUrl.query.name || '';
    const filePath = resolveSavedFile(name);
    try { if (filePath) await fs.promises.unlink(filePath); } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ success: false, error: e.message }));
    }
    const index = readSavedIndex();
    delete index[name];
    writeSavedIndex(index);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ success: true }));
  }

  if (parsedUrl.pathname === '/api/open-saved-folder' && req.method === 'POST') {
    try { await require('electron').shell.openPath(DOWNLOADS_DIR); } catch (e) {}
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ success: true }));
  }

  if (parsedUrl.pathname === '/api/suggest') {
    const suggestions = await fetchSuggestions(parsedUrl.query.q || '');
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ success: true, suggestions }));
  }

  if (parsedUrl.pathname === '/api/loudness') {
    let result;
    try {
      result = await getLoudness({ saved: parsedUrl.query.saved || '', id: parsedUrl.query.id || '' });
    } catch (e) {
      result = { pending: false, error: e.message };
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ success: !!(result && isFinite(result.lufs)), ...result }));
  }

  if (parsedUrl.pathname === '/api/radio') {
    const seed = {
      id: parsedUrl.query.id || '',
      url: parsedUrl.query.url || '',
      title: parsedUrl.query.title || '',
      artist: parsedUrl.query.artist || '',
      platform: parsedUrl.query.platform || 'youtube'
    };
    try {
      const tracks = await radioTracks(seed, Math.min(25, parseInt(parsedUrl.query.limit || '15', 10) || 15));
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ success: true, tracks }));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ success: false, error: e.message, tracks: [] }));
    }
  }

  if (parsedUrl.pathname === '/api/search') {
    const q = parsedUrl.query.q || '';
    const platform = parsedUrl.query.platform || 'youtube';
    const limit = parseInt(parsedUrl.query.limit || '20', 10);
    return handleSearch(req, res, q, platform, limit);
  }

  if (parsedUrl.pathname === '/api/spotify-config' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ configured: !!getSpotifyCredentials() }));
  }

  if (parsedUrl.pathname === '/api/spotify-config' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', async () => {
      const payload = safeJsonParse(body, {});
      const clientId = String(payload.clientId || '').trim();
      const clientSecret = String(payload.clientSecret || '').trim();
      try {
        if (!clientId && !clientSecret) {
          try { await fs.promises.unlink(SPOTIFY_CONFIG_PATH); } catch (e) {}
          spotifyToken = { value: null, expiresAt: 0 };
        } else {
          spotifyToken = await fetchSpotifyToken({ clientId, clientSecret });
          await fs.promises.writeFile(SPOTIFY_CONFIG_PATH, JSON.stringify({ clientId, clientSecret }));
        }
        for (const key of searchCache.keys()) {
          if (key.startsWith('spotify:')) searchCache.delete(key);
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, configured: !!getSpotifyCredentials() }));
      } catch (err) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: err.message }));
      }
    });
    return;
  }

  if (parsedUrl.pathname === '/api/vibe' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      const payload = safeJsonParse(body, {});
      handleVibeRecommendations(req, res, payload);
    });
    return;
  }

  if (parsedUrl.pathname === '/api/artist') {
    const name = parsedUrl.query.name || '';
    if (!name) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ success: false, error: 'Missing artist name' }));
    }
    const info = await fetchArtistInfo(name);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ success: true, artist: info }));
  }

  if (parsedUrl.pathname === '/api/prefetch') {
    const trackUrl = parsedUrl.query.url || '';
    const trackId = parsedUrl.query.id || '';
    const platform = parsedUrl.query.platform || 'youtube';
    prefetchTrack(trackUrl, trackId, platform);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ success: true }));
  }

  if (parsedUrl.pathname === '/api/check-cache') {
    const trackId = parsedUrl.query.id || '';
    const cleanId = cleanTrackId(trackId);
    const cachedFile = await findCachedFile(cleanId);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ 
      cached: !!cachedFile, 
      streamUrl: cachedFile ? `http://127.0.0.1:${PORT}/api/local-track?id=${encodeURIComponent(cleanId)}` : null 
    }));
  }

  if (parsedUrl.pathname === '/api/tools-status') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify(require('./tools').toolsStatus()));
  }

  if (parsedUrl.pathname === '/api/tools-install') {
    require('./tools').ensureTools().catch(() => {});
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ started: true }));
  }

  if (parsedUrl.pathname === '/api/stream-info') {
    const trackUrl = parsedUrl.query.url || '';
    const trackId = parsedUrl.query.id || '';
    const platform = parsedUrl.query.platform || 'youtube';
    const title = parsedUrl.query.title || '';
    const artist = parsedUrl.query.artist || '';
    const duration = parsedUrl.query.duration || 0;
    const thumbnail = parsedUrl.query.thumbnail || '';
    return handleStreamInfo(req, res, trackUrl, trackId, platform, title, artist, duration, thumbnail);
  }

  if (parsedUrl.pathname === '/api/local-track') {
    const trackId = parsedUrl.query.id || '';
    return handleLocalTrack(req, res, trackId);
  }

  if (parsedUrl.pathname === '/api/local-thumbnail') {
    const trackId = parsedUrl.query.id || '';
    const cleanId = cleanTrackId(trackId);
    const thumbPath = path.join(THUMBNAILS_DIR, `${cleanId}.jpg`);
    if (fs.existsSync(thumbPath)) {
      res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Cache-Control': 'public, max-age=31536000' });
      return fs.createReadStream(thumbPath).pipe(res);
    }
    res.writeHead(404);
    return res.end('Thumbnail not cached');
  }

  if (parsedUrl.pathname === '/api/offline-library') {
    const tracks = [];
    let totalBytes = 0;
    try {
      const files = await fs.promises.readdir(CACHE_DIR);
      const audioExtRegex = /\.(opus|webm|m4a|mp3)$/i;
      for (const file of files) {
        if (audioExtRegex.test(file) && !file.includes('.temp.')) {
          const cleanId = file.replace(audioExtRegex, '');
          const stat = await fs.promises.stat(path.join(CACHE_DIR, file));
          totalBytes += stat.size;
          const meta = trackMetadataIndex[cleanId] || {};
          tracks.push({
            id: meta.id || cleanId,
            cleanId: cleanId,
            title: meta.title || cleanId,
            artist: meta.artist || 'Unknown artist',
            duration: meta.duration || 0,
            thumbnail: meta.thumbnail || '',
            localThumbnail: fs.existsSync(path.join(THUMBNAILS_DIR, `${cleanId}.jpg`)) ? `http://127.0.0.1:${PORT}/api/local-thumbnail?id=${cleanId}` : (meta.thumbnail || ''),
            platform: meta.platform || 'youtube',
            fileSize: stat.size,
            lastPlayed: meta.lastPlayed || stat.mtimeMs,
            analysis: meta.analysis || null
          });
        }
      }
    } catch (e) {}
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ success: true, count: tracks.length, totalBytes, tracks }));
  }

  if (parsedUrl.pathname === '/api/track-analysis') {
    if (req.method === 'POST') {
      let body = '';
      req.on('data', chunk => body += chunk);
      req.on('end', () => {
        try {
          const payload = JSON.parse(body || '{}');
          const cleanId = cleanTrackId(payload.id || '');
          if (cleanId && payload.analysis) {
            saveTrackMetadata(cleanId, { analysis: payload.analysis });
          }
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: true }));
        } catch (e) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: e.message }));
        }
      });
      return;
    }
    const cleanId = cleanTrackId(parsedUrl.query.id || '');
    const meta = trackMetadataIndex[cleanId] || {};
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ success: true, analysis: meta.analysis || null }));
  }

  if (parsedUrl.pathname === '/api/offline-delete' && req.method === 'POST') {
    const trackId = parsedUrl.query.id || '';
    const cleanId = cleanTrackId(trackId);
    const audioPath = await findCachedFile(cleanId);
    const thumbPath = path.join(THUMBNAILS_DIR, `${cleanId}.jpg`);
    try { if (audioPath && fs.existsSync(audioPath)) await fs.promises.unlink(audioPath); } catch (e) {}
    try { if (fs.existsSync(thumbPath)) await fs.promises.unlink(thumbPath); } catch (e) {}
    delete trackMetadataIndex[cleanId];
    try { fs.writeFileSync(METADATA_PATH, JSON.stringify(trackMetadataIndex, null, 2), 'utf-8'); } catch (e) {}
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ success: true }));
  }

  if (parsedUrl.pathname === '/api/clear-offline-library' && req.method === 'POST') {
    try {
      const files = await fs.promises.readdir(CACHE_DIR);
      const audioExtRegex = /\.(opus|webm|m4a|mp3)$/i;
      for (const file of files) {
        if (audioExtRegex.test(file)) {
          try { await fs.promises.unlink(path.join(CACHE_DIR, file)); } catch (e) {}
        }
      }
      const thumbFiles = await fs.promises.readdir(THUMBNAILS_DIR);
      for (const file of thumbFiles) {
        try { await fs.promises.unlink(path.join(THUMBNAILS_DIR, file)); } catch (e) {}
      }
      trackMetadataIndex = {};
      try { fs.writeFileSync(METADATA_PATH, '{}', 'utf-8'); } catch (e) {}
    } catch (e) {}
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ success: true }));
  }

  if (parsedUrl.pathname === '/api/audio-proxy') {
    const targetUrl = parsedUrl.query.url || '';
    return handleAudioProxy(req, res, targetUrl);
  }

  if (parsedUrl.pathname === '/api/save-custom-lyrics' && req.method === 'POST') {
    const title = parsedUrl.query.title || '';
    const artist = parsedUrl.query.artist || '';
    return handleSaveCustomLyrics(req, res, title, artist);
  }

  if (parsedUrl.pathname === '/api/lyrics') {
    const title = parsedUrl.query.title || '';
    const artist = parsedUrl.query.artist || '';
    const allowOnline = parsedUrl.query.online !== '0';
    return handleLyrics(req, res, title, artist, allowOnline);
  }

  res.writeHead(404);
  res.end('Not found');
});

function startServer(port = PORT) {
  return new Promise((resolve, reject) => {
    server.listen(port, '127.0.0.1', () => {
      console.log(`Riffle server running on http://127.0.0.1:${port}`);
      require('./tools').updateYtDlpIfManaged().catch(() => {});
      resolve(port);
    }).on('error', (err) => {
      if (err.code === 'EADDRINUSE') {
        server.listen(0, '127.0.0.1', () => {
          const p = server.address().port;
          console.log(`Riffle server running on fallback port http://127.0.0.1:${p}`);
          require('./tools').updateYtDlpIfManaged().catch(() => {});
          resolve(p);
        });
      } else {
        reject(err);
      }
    });
  });
}

module.exports = { startServer, PORT };

if (require.main === module) {
  startServer();
}
