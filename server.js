const http = require('http');
const https = require('https');
const crypto = require('crypto');
const url = require('url');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require("child_process");
const { StringDecoder } = require("string_decoder");
const dns = require('dns');
const net = require('net');

// every /api call needs this token (the window gets it through preload), so a web page
// in a browser can't drive the local server. Media the page loads as <audio>/<img> can't
// carry headers, so those read-only routes are left open.
const SERVER_TOKEN = crypto.randomBytes(24).toString('hex');
const OPEN_ROUTES = new Set(['/api/local-track', '/api/library-file', '/api/saved-file', '/api/audio-proxy', '/api/local-thumbnail', '/api/lyrics-stream', '/api/spotify-callback']);

function tokenMatches(provided) {
  if (typeof provided !== 'string' || provided.length !== SERVER_TOKEN.length) return false;
  return crypto.timingSafeEqual(Buffer.from(provided), Buffer.from(SERVER_TOKEN));
}

const isHttpUrl = (value) => typeof value === 'string' && /^https?:\/\//i.test(value);

function ipv4Private(a, b) {
  return a === 0 || a === 10 || a === 127 || a >= 224 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && (b === 168 || b === 0)) || (a === 198 && (b === 18 || b === 19)) || (a === 100 && b >= 64 && b <= 127);
}

function isPrivateIp(address) {
  const kind = net.isIP(address);
  if (kind === 4) {
    const [a, b] = address.split('.').map(Number);
    return ipv4Private(a, b);
  }
  if (kind === 6) {
    const h = address.toLowerCase();
    if (h === '::' || h === '::1' || /^fe[89ab]/.test(h) || /^f[cd]/.test(h)) return true;
    const mapped = h.match(/^::ffff:(\d+)\.(\d+)\.\d+\.\d+$/);
    return mapped ? ipv4Private(Number(mapped[1]), Number(mapped[2])) : false;
  }
  return true;
}

// numeric forms like 2130706433 or 0x7f000001 also mean 127.0.0.1
async function isPrivateHost(hostname) {
  let host = String(hostname || '').toLowerCase().replace(/^\[|\]$/g, '');
  if (!host || host === 'localhost' || /\.(localhost|local|internal)$/.test(host)) return true;
  const n = /^\d{1,10}$/.test(host) ? Number(host) : /^0x[0-9a-f]+$/.test(host) ? parseInt(host, 16) : NaN;
  if (isFinite(n) && n <= 0xffffffff) host = [n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join('.');
  if (net.isIP(host)) return isPrivateIp(host);
  try {
    const addrs = await dns.promises.lookup(host, { all: true });
    return !addrs.length || addrs.some(a => isPrivateIp(a.address));
  } catch (e) {
    return true;
  }
}

function pipeFile(stream, res) {
  stream.on('error', () => {
    if (!res.headersSent) { try { res.writeHead(500); } catch (e) {} }
    try { res.end(); } catch (e) {}
  });
  res.on('close', () => stream.destroy());
  stream.pipe(res);
}

const PORT = Number(process.env.RIFFLE_PORT) || 38472;
const { DATA_DIR, CACHE_DIR, CUSTOM_LYRICS_DIR, LYRICS_DIR, THUMBNAILS_DIR, METADATA_PATH, LIBRARY_DIR, LIBRARY_PATH, ytDlpCommand, resolveBinary } = require('./platform');

if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive: true });
if (!fs.existsSync(CUSTOM_LYRICS_DIR)) fs.mkdirSync(CUSTOM_LYRICS_DIR, { recursive: true });
if (!fs.existsSync(LYRICS_DIR)) fs.mkdirSync(LYRICS_DIR, { recursive: true });
if (!fs.existsSync(THUMBNAILS_DIR)) fs.mkdirSync(THUMBNAILS_DIR, { recursive: true });
if (!fs.existsSync(LIBRARY_DIR)) fs.mkdirSync(LIBRARY_DIR, { recursive: true });

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

// in-memory caches are capped so a session left running for days doesn't keep growing;
// Maps keep insertion order, so the oldest entry goes first
function remember(map, key, value, max = 200) {
  map.delete(key);
  map.set(key, value);
  while (map.size > max) map.delete(map.keys().next().value);
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

// lyrics translation through Google's public translate endpoint. Lines go in batches joined
// by newlines; a batch whose line count comes back different is redone line by line
const translateCache = new Map();
const TRANSLATE_CACHE_MAX = 40;

async function googleTranslate(text, target) {
  const url = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=${encodeURIComponent(target)}&dt=t&q=${encodeURIComponent(text)}`;
  const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(9000) });
  if (!res.ok) throw new Error(`translate returned ${res.status}`);
  const data = await res.json();
  if (!Array.isArray(data) || !Array.isArray(data[0])) throw new Error('unexpected translate reply');
  return { text: data[0].map(part => (part && part[0]) || '').join(''), source: typeof data[2] === 'string' ? data[2] : '' };
}

async function translateLines(lines, target) {
  const key = target + '\u0000' + lines.join('\n');
  if (translateCache.has(key)) return translateCache.get(key);
  const out = new Array(lines.length).fill('');
  let source = '';
  const batches = [];
  let batch = [];
  let size = 0;
  lines.forEach((line, i) => {
    if (batch.length && size + line.length + 1 > 1500) { batches.push(batch); batch = []; size = 0; }
    batch.push(i);
    size += line.length + 1;
  });
  if (batch.length) batches.push(batch);
  for (const idxs of batches) {
    const texts = idxs.map(i => lines[i]);
    let parts = null;
    try {
      const r = await googleTranslate(texts.join('\n'), target);
      source = source || r.source;
      parts = r.text.split('\n');
    } catch (e) {}
    if (!parts || parts.length !== texts.length) {
      parts = [];
      for (const t of texts) {
        if (!t.trim()) { parts.push(''); continue; }
        try { parts.push((await googleTranslate(t, target)).text); } catch (e) { parts.push(''); }
      }
    }
    idxs.forEach((lineIdx, j) => { out[lineIdx] = (parts[j] || '').trim(); });
  }
  const result = { translations: out, source };
  translateCache.set(key, result);
  if (translateCache.size > TRANSLATE_CACHE_MAX) translateCache.delete(translateCache.keys().next().value);
  return result;
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
      remember(searchCache, cacheKey, entries);
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

// YouTube Music search through its own web API: one request returns the songs with artists,
// album and length, so nothing has to be spawned per result
async function searchYoutubeMusic(query, limit = 20) {
  const res = await fetch('https://music.youtube.com/youtubei/v1/search?prettyPrint=false', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'User-Agent': 'Mozilla/5.0', Origin: 'https://music.youtube.com' },
    // params selects the "Songs" filter
    body: JSON.stringify({ context: { client: { clientName: 'WEB_REMIX', clientVersion: '1.20250101.01.00', hl: 'en' } }, query, params: 'EgWKAQIIAWoKEAkQBRAKEAMQBA%3D%3D' }),
    signal: AbortSignal.timeout(9000)
  });
  if (!res.ok) throw new Error(`YouTube Music returned ${res.status}`);
  const data = await res.json();
  const sections = data.contents?.tabbedSearchResultsRenderer?.tabs?.[0]?.tabRenderer?.content?.sectionListRenderer?.contents || [];
  const tracks = [];
  for (const section of sections) {
    for (const item of section.musicShelfRenderer?.contents || []) {
      const r = item.musicResponsiveListItemRenderer;
      const id = r?.playlistItemData?.videoId;
      if (!id) continue;
      const column = (i) => r.flexColumns?.[i]?.musicResponsiveListItemFlexColumnRenderer?.text?.runs || [];
      const title = column(0).map(x => x.text).join('').trim() || 'untitled';
      const details = column(1);
      const typeOf = (run) => run.navigationEndpoint?.browseEndpoint?.browseEndpointContextSupportedConfigs?.browseEndpointContextMusicConfig?.pageType || '';
      const artists = details.filter(run => typeOf(run) === 'MUSIC_PAGE_TYPE_ARTIST').map(run => run.text);
      const album = (details.find(run => typeOf(run) === 'MUSIC_PAGE_TYPE_ALBUM') || {}).text || '';
      const lengthText = (details.map(run => run.text).reverse().find(t => /^\d+:\d{2}(?::\d{2})?$/.test(t.trim())) || '0:00').trim();
      const thumbs = r.thumbnail?.musicThumbnailRenderer?.thumbnail?.thumbnails || [];
      const thumb = (thumbs[thumbs.length - 1] || {}).url || `https://i.ytimg.com/vi/${id}/hqdefault.jpg`;
      tracks.push({
        id,
        title,
        artist: artists.join(', ') || (details[0] && details[0].text) || 'unknown artist',
        album,
        duration: parseDurationSeconds(lengthText),
        thumbnail: thumb.replace(/=w\d+-h\d+/, '=w320-h320'),
        url: `https://www.youtube.com/watch?v=${id}`,
        platform: 'youtube',
        isCached: !!(await findCachedFile(id))
      });
      if (tracks.length >= limit) return tracks;
    }
  }
  return tracks;
}

// ---- My files: audio you added yourself ----------------------------------------------------
let libraryIndex = {};
try {
  if (fs.existsSync(LIBRARY_PATH)) libraryIndex = JSON.parse(fs.readFileSync(LIBRARY_PATH, 'utf-8')) || {};
} catch (e) {
  libraryIndex = {};
}
function saveLibraryIndex() {
  fs.promises.writeFile(LIBRARY_PATH, JSON.stringify(libraryIndex), 'utf-8').catch(() => {});
}
const LIBRARY_FILE_RE = /^local_[a-f0-9]{14}\.[a-z0-9]{2,5}$/;
const LIBRARY_MIME = {
  mp3: 'audio/mpeg', flac: 'audio/flac', wav: 'audio/wav', ogg: 'audio/ogg', oga: 'audio/ogg', opus: 'audio/ogg',
  m4a: 'audio/mp4', aac: 'audio/aac', webm: 'audio/webm', weba: 'audio/webm', wma: 'audio/x-ms-wma', aiff: 'audio/aiff', aif: 'audio/aiff'
};

// one ffmpeg run reads the tags and duration and, when the file carries a picture, saves it as the cover
function probeLibraryFile(fullPath, id) {
  return new Promise((resolve) => {
    const ffmpeg = resolveBinary('ffmpeg');
    if (!ffmpeg) return resolve({});
    const thumbPath = path.join(THUMBNAILS_DIR, `${id}.jpg`);
    const proc = spawn(ffmpeg, ['-hide_banner', '-nostdin', '-i', fullPath, '-an', '-frames:v', '1', '-vf', 'scale=320:-2', '-y', thumbPath], { windowsHide: true });
    let err = '';
    proc.stderr.on('data', d => { if (err.length < 64000) err += d; });
    const timer = setTimeout(() => proc.kill(), 15000);
    proc.on('close', () => {
      clearTimeout(timer);
      const tag = (name) => {
        const m = err.match(new RegExp(`^\\s{4}${name}\\s*:\\s*(.+)$`, 'mi'));
        return m ? m[1].trim() : '';
      };
      const d = err.match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/);
      resolve({
        title: tag('title'),
        artist: tag('artist') || tag('album_artist'),
        album: tag('album'),
        duration: d ? Math.round(Number(d[1]) * 3600 + Number(d[2]) * 60 + Number(d[3])) : 0,
        hasCover: fs.existsSync(thumbPath) && fs.statSync(thumbPath).size > 0
      });
    });
    proc.on('error', () => { clearTimeout(timer); resolve({}); });
  });
}

// "01 - Artist - Title" or "Artist - Title" when the file has no tags
function guessFromFileName(name) {
  const clean = String(name || '').replace(/^\d{1,3}[\s._-]+/, '').trim() || 'Untitled';
  const dash = clean.indexOf(' - ');
  return dash > 0 ? { artist: clean.slice(0, dash).trim(), title: clean.slice(dash + 3).trim() } : { artist: '', title: clean };
}

function libraryTrack(item) {
  return {
    id: item.id,
    platform: 'local',
    title: item.title,
    artist: item.artist || 'Unknown artist',
    album: item.album || '',
    duration: item.duration || 0,
    thumbnail: item.hasCover ? `http://127.0.0.1:${PORT}/api/local-thumbnail?id=${item.id}` : '',
    addedAt: item.addedAt || 0
  };
}

async function handleLibraryFile(req, res, id) {
  const item = libraryIndex[id];
  if (!item || !LIBRARY_FILE_RE.test(item.file)) {
    res.writeHead(404);
    return res.end('Not in your library');
  }
  const filePath = path.join(LIBRARY_DIR, item.file);
  let stat;
  try { stat = await fs.promises.stat(filePath); } catch (e) {
    res.writeHead(404);
    return res.end('File missing');
  }
  const type = LIBRARY_MIME[path.extname(item.file).slice(1)] || 'application/octet-stream';
  const range = /bytes=(\d*)-(\d*)/.exec(req.headers.range || '');
  if (range) {
    const start = range[1] ? parseInt(range[1], 10) : 0;
    const end = range[2] ? Math.min(parseInt(range[2], 10), stat.size - 1) : stat.size - 1;
    res.writeHead(206, { 'Content-Range': `bytes ${start}-${end}/${stat.size}`, 'Accept-Ranges': 'bytes', 'Content-Length': end - start + 1, 'Content-Type': type });
    if (req.method === 'HEAD') return res.end();
    return fs.createReadStream(filePath, { start, end }).pipe(res);
  }
  res.writeHead(200, { 'Content-Length': stat.size, 'Content-Type': type, 'Accept-Ranges': 'bytes' });
  if (req.method === 'HEAD') return res.end();
  fs.createReadStream(filePath).pipe(res);
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
// plain https GET with a hard deadline; used where a stuck request must not hang the caller
function httpsGetText(url, headers = {}, timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        return httpsGetText(new URL(res.headers.location, url).href, headers, timeoutMs).then(resolve, reject);
      }
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error(`request returned ${res.statusCode}`));
      }
      const dec = new StringDecoder('utf8');
      let body = '';
      res.on('data', chunk => { body += dec.write(chunk); });
      res.on('end', () => resolve(body + dec.end()));
      res.on('error', reject);
    });
    req.setTimeout(timeoutMs, () => req.destroy(new Error('request timed out')));
    req.on('error', reject);
  });
}

async function resolveSpotifyLink(link) {
  return (await readSpotifyEmbed(link)).tracks;
}

// name and songs of a public Spotify track, album or playlist, read from its embed page
async function readSpotifyEmbed(link) {
  const m = link.match(SPOTIFY_URL_RE);
  if (!m) return { name: '', tracks: [] };
  const [, type, id] = m;
  const html = await httpsGetText(`https://open.spotify.com/embed/${type.toLowerCase()}/${id}`, {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
  }, 12000);
  const nd = html.match(/<script id="__NEXT_DATA__" type="application\/json">(.*?)<\/script>/s);
  if (!nd) throw new Error('could not read spotify page');
  const pageState = JSON.parse(nd[1])?.props?.pageProps?.state;
  const entity = pageState?.data?.entity;
  if (!entity) throw new Error('spotify entity not found');

  const cover = pickImage(entity.visualIdentity?.image) || pickImage(entity.coverArt?.sources);
  const items = entity.type === 'track'
    ? [{ uri: entity.uri, title: entity.title || entity.name, subtitle: (entity.artists || []).map(a => a.name).join(', '), duration: entity.duration }]
    : (entity.trackList || []);

  const tracks = items.filter(t => t && t.title).map(t => metadataTrack({
    id: `spotify-${String(t.uri || '').split(':').pop() || Math.random().toString(36).substring(2)}`,
    title: t.title,
    artist: t.subtitle,
    duration: Math.round((Number(t.duration) || 0) / 1000),
    thumbnail: cover
  }));
  // the embed stops at 100 songs; the rest comes from the page's own anonymous session
  const token = pageState?.settings?.session?.accessToken;
  if (entity.type === 'playlist' && tracks.length >= 100 && token) {
    const full = await spotifyPlaylistPages(id, token).catch(() => null);
    if (full && full.length > tracks.length) return { name: entity.name || entity.title || '', type: entity.type, tracks: full };
  }
  return { name: entity.name || entity.title || '', type: entity.type || type, tracks };
}

const SPOTIFY_PLAYLIST_QUERY = '8964e8eafb21aa992a7d951d256d83285c04be2105d209262901de70cb97584a';

function spotifyPathfinder(token, variables) {
  return new Promise((resolve, reject) => {
    const req = https.request('https://api-partner.spotify.com/pathfinder/v1/query', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Accept: 'application/json' }
    }, (res) => {
      let body = '';
      res.on('data', c => { body += c; });
      res.on('end', () => {
        if (res.statusCode !== 200) return reject(new Error(`pathfinder ${res.statusCode}`));
        try { resolve(JSON.parse(body)); } catch (e) { reject(e); }
      });
    });
    req.setTimeout(15000, () => req.destroy(new Error('timeout')));
    req.on('error', reject);
    req.end(JSON.stringify({ variables, operationName: 'fetchPlaylist', extensions: { persistedQuery: { version: 1, sha256Hash: SPOTIFY_PLAYLIST_QUERY } } }));
  });
}

async function spotifyPlaylistPages(id, token) {
  const out = [];
  let total = Infinity;
  for (let offset = 0; offset < total && offset < 10000; offset += 100) {
    const page = await spotifyPathfinder(token, { uri: `spotify:playlist:${id}`, offset, limit: 100, enableWatchFeedEntrypoint: true });
    const content = page?.data?.playlistV2?.content;
    if (!content || !Array.isArray(content.items) || !content.items.length) break;
    total = content.totalCount || 0;
    for (const it of content.items) {
      const t = it?.itemV2?.data || it?.item?.data;
      if (!t || !t.name) continue;
      const artists = (t.artists?.items || t.albumOfTrack?.artists?.items || []).map(a => a.profile?.name).filter(Boolean);
      out.push(metadataTrack({
        id: `spotify-${String(t.uri || '').split(':').pop() || Math.random().toString(36).slice(2)}`,
        title: t.name,
        artist: artists.join(', '),
        duration: Math.round((t.trackDuration?.totalMilliseconds || 0) / 1000),
        thumbnail: pickImage(t.albumOfTrack?.coverArt?.sources)
      }));
    }
  }
  return out;
}

// Apple Music pages carry the whole list as JSON; walk it for anything shaped like a song
async function readAppleMusic(link) {
  const body = await httpsGetText(link, {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Accept-Language': 'en-US,en;q=0.9'
  }, 15000);
  const blocks = [];
  const server = body.match(/<script[^>]*id=["']serialized-server-data["'][^>]*>([\s\S]*?)<\/script>/i);
  if (server) blocks.push(server[1]);
  for (const m of body.matchAll(/<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)) blocks.push(m[1]);
  const tracks = [];
  const seen = new Set();
  let name = '', cover = '';
  const walk = (node) => {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) return node.forEach(walk);
    if (!name && (node.contentDescriptor?.kind === 'playlist' || node.contentDescriptor?.kind === 'album' || node['@type'] === 'MusicPlaylist' || node['@type'] === 'MusicAlbum')) {
      name = node.title || node.name || '';
      cover = node.artwork?.dictionary?.url || node.artwork?.url || '';
    }
    const kind = node.contentDescriptor?.kind;
    const title = String(node.title || (node['@type'] === 'MusicRecording' ? node.name : '') || '').trim();
    const artist = String(node.artistName || node.byArtist?.name || (Array.isArray(node.byArtist) ? node.byArtist.map(a => a.name).join(', ') : '') || '').trim();
    if (title && artist && (kind === 'song' || kind === 'music-video' || node['@type'] === 'MusicRecording' || node.durationInMillis)) {
      const key = `${title}\u0000${artist}`.toLowerCase();
      if (!seen.has(key)) {
        seen.add(key);
        let duration = 0;
        if (node.durationInMillis) duration = Math.round(node.durationInMillis / 1000);
        else if (typeof node.duration === 'string') {
          const d = node.duration.match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/);
          if (d) duration = (+(d[1] || 0)) * 3600 + (+(d[2] || 0)) * 60 + (+(d[3] || 0));
        }
        tracks.push({ title, artist, duration });
      }
      return;
    }
    for (const k of Object.keys(node)) walk(node[k]);
  };
  for (const b of blocks) { try { walk(JSON.parse(b)); } catch (e) {} }
  if (!name) {
    const og = body.match(/<meta\s+property=["']og:title["']\s+content=["']([^"']*)["']/i);
    if (og) name = og[1].replace(/\s*on Apple\s*Music\s*$/i, '').trim();
  }
  cover = String(cover || '').replace('{w}x{h}bb.{f}', '600x600bb.jpg');
  return {
    name,
    tracks: tracks.map(t => metadataTrack({ id: `apple-${crypto.createHash('sha1').update(t.title + t.artist).digest('hex').slice(0, 12)}`, title: t.title, artist: t.artist, duration: t.duration, thumbnail: cover }))
  };
}

// YouTube, YouTube Music and SoundCloud playlists list straight from yt-dlp, already playable
async function readStreamPlaylist(link) {
  const isSc = /soundcloud\.com/i.test(link);
  // SoundCloud's flat listing only has URLs, so its sets are resolved track by track
  const raw = isSc
    ? await executeYtDlp(['-J', '--skip-download', '--no-warnings', '--no-check-certificates', '--playlist-end', '500', '--', link], 180000)
    : await executeYtDlp(['--flat-playlist', '-J', '--no-warnings', '--no-check-certificates', '--playlist-end', '2000', '--', link], 60000);
  const data = safeJsonParse(raw, {});
  const tracks = (data.entries || []).filter(e => e && (e.id || e.url) && e.title && !/^\[(private|deleted)/i.test(e.title)).map(e => {
    const artist = String(e.artist || e.channel || e.uploader || '').replace(/\s+-\s+Topic$/, '');
    if (isSc) {
      return { id: `sc-${e.id}`, title: e.title, artist: artist || 'unknown artist', duration: Math.round(e.duration || 0), thumbnail: e.thumbnail || (e.thumbnails && e.thumbnails.length && e.thumbnails[e.thumbnails.length - 1].url) || '', url: e.webpage_url || e.url, platform: 'soundcloud', isCached: false };
    }
    return { id: e.id, title: e.title, artist: artist || 'unknown artist', duration: Math.round(e.duration || 0), thumbnail: `https://i.ytimg.com/vi/${e.id}/hqdefault.jpg`, url: `https://www.youtube.com/watch?v=${e.id}`, platform: 'youtube', isCached: false };
  });
  return { name: data.title || '', tracks };
}

async function readPlaylistLink(link) {
  let host = '';
  try { host = new URL(link).hostname.replace(/^www\./, ''); } catch (e) { throw new Error('not a link'); }
  if (SPOTIFY_URL_RE.test(link)) return { source: 'spotify', ...(await readSpotifyEmbed(link)) };
  if (host === 'music.apple.com') return { source: 'apple', ...(await readAppleMusic(link)) };
  if (/(^|\.)youtube\.com$/.test(host) || host === 'youtu.be') return { source: host.startsWith('music.') ? 'ytmusic' : 'youtube', ...(await readStreamPlaylist(link)) };
  if (/(^|\.)soundcloud\.com$/.test(host)) return { source: 'soundcloud', ...(await readStreamPlaylist(link)) };
  throw new Error('unsupported link');
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

const JUKEBOX_DIR = path.join(DATA_DIR, 'jukebox');
const jukebox = require('./jukebox');
const jukeboxJobs = new Map();
let jukeboxChain = Promise.resolve();

async function jukeboxSource(id, saved) {
  if (saved) return resolveSavedFile(saved);
  if (id.startsWith('local_')) {
    const item = libraryIndex[id];
    return item && LIBRARY_FILE_RE.test(item.file) ? path.join(LIBRARY_DIR, item.file) : null;
  }
  return findCachedFile(id);
}

// streamed songs are often not in the cache yet: fetch them now instead of giving up
async function jukeboxFetch(id, trackUrl, platform) {
  if (!trackUrl || !/^https?:\/\//.test(trackUrl)) return null;
  await downloadTrackToDisk(trackUrl, id, platform || 'youtube', {}, true);
  const until = Date.now() + 4 * 60 * 1000;
  while (Date.now() < until) {
    const file = await findCachedFile(id);
    if (file) return file;
    if (!downloadingSet.has(cleanTrackId(id))) return null;
    await new Promise(r => setTimeout(r, 1000));
  }
  return null;
}

function getJukeboxAnalysis(id, saved, trackUrl, platform) {
  const key = saved ? 'saved_' + crypto.createHash('sha1').update(saved).digest('hex').slice(0, 16) : cleanTrackId(id);
  if (jukeboxJobs.has(key)) return jukeboxJobs.get(key);
  const out = path.join(JUKEBOX_DIR, key + '.json');
  const job = (async () => {
    const cached = safeJsonParse(await fs.promises.readFile(out, 'utf8').catch(() => ''), null);
    if (cached && cached.version === jukebox.VERSION) return cached;
    const file = (await jukeboxSource(id, saved)) || (!saved && await jukeboxFetch(id, trackUrl, platform));
    if (!file) throw new Error('not downloaded');
    const ffmpeg = resolveBinary('ffmpeg');
    if (!ffmpeg) throw new Error('ffmpeg not found');
    const run = jukeboxChain.then(() => jukebox.analyzeFile(ffmpeg, file));
    jukeboxChain = run.catch(() => {});
    const data = await run;
    await fs.promises.mkdir(JUKEBOX_DIR, { recursive: true });
    await fs.promises.writeFile(out, JSON.stringify(data));
    return data;
  })().finally(() => jukeboxJobs.delete(key));
  jukeboxJobs.set(key, job);
  return job;
}

const SPOTIFY_CONFIG_PATH = path.join(DATA_DIR, 'spotify.json');

// ---- Spotify account (PKCE login with the user's own Client ID): liked songs and every playlist
const SPOTIFY_USER_PATH = path.join(DATA_DIR, 'spotify-user.json');
const SPOTIFY_SCOPES = 'user-library-read playlist-read-private playlist-read-collaborative';
let spotifyLogin = null;

function spotifyClientId() {
  try { return String(JSON.parse(fs.readFileSync(SPOTIFY_CONFIG_PATH, 'utf-8')).clientId || '') || process.env.RIFFLE_SPOTIFY_CLIENT_ID || ''; } catch (e) { return process.env.RIFFLE_SPOTIFY_CLIENT_ID || ''; }
}
const spotifyRedirectUri = () => `http://127.0.0.1:${server.address() ? server.address().port : PORT}/api/spotify-callback`;
const readSpotifyUser = () => safeJsonParse(fs.existsSync(SPOTIFY_USER_PATH) ? fs.readFileSync(SPOTIFY_USER_PATH, 'utf-8') : '', null);
const writeSpotifyUser = (u) => fs.writeFileSync(SPOTIFY_USER_PATH, JSON.stringify(u), 'utf-8');

async function spotifyTokenRequest(form) {
  const res = await fetch('https://accounts.spotify.com/api/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(form).toString()
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.access_token) throw new Error(data.error_description || data.error || `spotify ${res.status}`);
  return data;
}

async function spotifyUserToken() {
  const u = readSpotifyUser();
  if (!u || !u.refresh) throw new Error('not connected');
  if (u.access && u.expiresAt > Date.now() + 30000) return u.access;
  const data = await spotifyTokenRequest({ grant_type: 'refresh_token', refresh_token: u.refresh, client_id: u.clientId });
  Object.assign(u, { access: data.access_token, refresh: data.refresh_token || u.refresh, expiresAt: Date.now() + (data.expires_in || 3600) * 1000 });
  writeSpotifyUser(u);
  return u.access;
}

async function spotifyApi(pathAndQuery) {
  const token = await spotifyUserToken();
  const res = await fetch(pathAndQuery.startsWith('https://') ? pathAndQuery : `https://api.spotify.com/v1/${pathAndQuery}`, { headers: { Authorization: `Bearer ${token}` } });
  if (res.status === 429) {
    await new Promise(r => setTimeout(r, Math.min(10, Number(res.headers.get('retry-after')) || 2) * 1000));
    return spotifyApi(pathAndQuery);
  }
  if (!res.ok) throw new Error(`spotify ${res.status}`);
  return res.json();
}

const spotifyItemTrack = (t) => t && t.name && metadataTrack({
  id: `spotify-${t.id || Math.random().toString(36).slice(2)}`,
  title: t.name,
  artist: (t.artists || []).map(a => a.name).join(', '),
  duration: Math.round((t.duration_ms || 0) / 1000),
  thumbnail: pickImage(t.album && t.album.images)
});

async function spotifyPaged(first, pick, max = 5000) {
  const out = [];
  let next = first;
  while (next && out.length < max) {
    const page = await spotifyApi(next);
    for (const it of page.items || []) {
      const t = pick(it);
      if (t) out.push(t);
    }
    next = page.next;
  }
  return out;
}
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
  if (!isHttpUrl(link)) throw new Error('not a TikTok link');
  if (TIKTOK_PROFILE_RE.test(link)) {
    const raw = await executeYtDlp(['--flat-playlist', '--dump-single-json', '--playlist-end', String(limit), '--no-warnings', '--', link], 45000);
    const data = JSON.parse(raw);
    const entries = (data.entries || []).filter(e => e && e.id);
    return Promise.all(entries.map(e => tiktokItemToTrack(e, `${link.replace(/[?#].*$/, '').replace(/\/$/, '')}/video/${e.id}`)));
  }
  const raw = await executeYtDlp(['--dump-single-json', '--no-playlist', '--skip-download', '--no-warnings', '--', link], 25000);
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

// each cache download runs a yt-dlp and an ffmpeg (~50 MB or more apiece), so background
// downloads go one at a time; playback that needs the file right away skips the line
let downloadQueue = Promise.resolve();

async function downloadTrackToDisk(trackUrl, trackId, platform, meta = {}, urgent = false) {
  const cleanId = cleanTrackId(trackId);
  if (downloadingSet.has(cleanId) || await findCachedFile(cleanId)) return;
  downloadingSet.add(cleanId);
  if (urgent) return runTrackDownload(trackUrl, cleanId, trackId, platform, meta);
  const run = downloadQueue.then(() => runTrackDownload(trackUrl, cleanId, trackId, platform, meta));
  downloadQueue = run.catch(() => {});
  return run;
}

async function runTrackDownload(trackUrl, cleanId, trackId, platform, meta) {
  if (await findCachedFile(cleanId)) { downloadingSet.delete(cleanId); return; }

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

  if (!isHttpUrl(trackUrl)) { downloadingSet.delete(cleanId); return; }
  args.push('--', trackUrl);

  if (meta.thumbnail) {
    cacheThumbnailToDisk(cleanId, meta.thumbnail).catch(() => {});
  }

  let cmd;
  try { cmd = ytDlpCommand(args); } catch (e) { downloadingSet.delete(cleanId); console.error(e.message); return; }
  return new Promise((resolve) => {
  const proc = spawn(cmd.bin, cmd.args, { windowsHide: true });
  // a stuck download would hold up the queue behind it
  const stuck = setTimeout(() => { try { proc.kill('SIGKILL'); } catch (e) {} }, 10 * 60 * 1000);
  proc.on('close', async (code) => {
    clearTimeout(stuck);
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
    clearTimeout(stuck);
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
    if (!isHttpUrl(trackUrl)) return;
    args.push('--', trackUrl);

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
      remember(streamUrlCache, cleanId, { timestamp: Date.now(), data });
      // knowing the stream URL is enough to start instantly; the file itself is only
      // cached once the track is actually played (TikTok clips are short and play from disk)
      if (platform === 'tiktok') downloadTrackToDisk(trackUrl, cleanId, platform, {}, true);
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
      remember(searchCache, cacheKey, result);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify(result));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ success: false, error: err.message }));
    }
  }

  if (platform === 'ytmusic') {
    try {
      const tracks = await searchYoutubeMusic(trimmed, limit);
      const result = { success: true, tracks };
      remember(searchCache, cacheKey, result);
      if (tracks[0]) setTimeout(() => prefetchTrack(tracks[0].url, tracks[0].id, 'youtube').catch(() => {}), 50);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify(result));
    } catch (err) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ success: false, tracks: [], error: 'YouTube Music is unavailable right now' }));
    }
  }

  if (platform === 'youtube') {
    try {
      const directTracks = await directYoutubeSearch(query);
      if (directTracks && directTracks.length > 0) {
        const result = { success: true, tracks: directTracks.slice(0, limit) };
        remember(searchCache, cacheKey, result);

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
    remember(searchCache, cacheKey, result);

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
    await downloadTrackToDisk(trackUrl, cleanId, platform, meta, true);
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
    if (!isHttpUrl(trackUrl)) throw new Error('not a link');
    args.push('--', trackUrl);
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

  remember(streamUrlCache, cleanId, { timestamp: Date.now(), data });
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

  remember(artistCache, cacheKey, result);
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
      const m = /^bytes=(\d*)-(\d*)$/.exec(String(range).trim());
      let start = m && m[1] !== '' ? parseInt(m[1], 10) : NaN;
      let end = m && m[2] !== '' ? parseInt(m[2], 10) : fileSize - 1;
      if (m && m[1] === '' && m[2] !== '') { start = Math.max(0, fileSize - parseInt(m[2], 10)); end = fileSize - 1; }
      end = Math.min(end, fileSize - 1);
      if (!m || !isFinite(start) || start > end || start >= fileSize) {
        res.writeHead(416, { 'Content-Range': `bytes */${fileSize}` });
        return res.end();
      }
      res.writeHead(206, {
        'Content-Range': `bytes ${start}-${end}/${fileSize}`,
        'Accept-Ranges': 'bytes',
        'Content-Length': end - start + 1,
        'Content-Type': contentType,
      });
      pipeFile(fs.createReadStream(filePath, { start, end }), res);
    } else {
      res.writeHead(200, {
        'Content-Length': fileSize,
        'Content-Type': contentType,
        'Accept-Ranges': 'bytes'
      });
      pipeFile(fs.createReadStream(filePath), res);
    }
  } catch (e) {
    res.writeHead(500);
    res.end('Error reading local file');
  }
}

const PROXY_HEADERS = ['range', 'user-agent', 'accept', 'accept-language', 'if-range'];

async function handleAudioProxy(req, res, targetUrl) {
  if (!isHttpUrl(targetUrl) || (req.method !== 'GET' && req.method !== 'HEAD')) {
    res.writeHead(400);
    return res.end('Bad request');
  }
  try {
    const parsed = new URL(targetUrl);
    if (await isPrivateHost(parsed.hostname)) {
      res.writeHead(403);
      return res.end('Blocked');
    }
    const client = parsed.protocol === 'https:' ? https : http;
    const headers = { host: parsed.host };
    for (const h of PROXY_HEADERS) if (req.headers[h]) headers[h] = req.headers[h];

    const proxyReq = client.request(targetUrl, { method: req.method, headers }, (proxyRes) => {
      res.writeHead(proxyRes.statusCode, proxyRes.headers);
      proxyRes.on('error', () => res.destroy());
      proxyRes.pipe(res);
    });
    proxyReq.setTimeout(30000, () => proxyReq.destroy(new Error('timeout')));
    proxyReq.on('error', () => {
      if (!res.headersSent) res.writeHead(502);
      res.end();
    });
    res.on('close', () => proxyReq.destroy());
    proxyReq.end();
  } catch (e) {
    if (!res.headersSent) res.writeHead(500);
    res.end();
  }
}

// downloads go to the app's own folder (Music\Riffle), listed in the Saved view
let DEFAULT_DOWNLOADS_DIR;
try { DEFAULT_DOWNLOADS_DIR = path.join(require('electron').app.getPath('music'), 'Riffle'); } catch (e) { DEFAULT_DOWNLOADS_DIR = path.join(os.homedir(), 'Music', 'Riffle'); }
let DOWNLOADS_DIR = require('./platform').configuredDir(require('./platform').readConfig().downloadDir) || DEFAULT_DOWNLOADS_DIR;
if (!fs.existsSync(DOWNLOADS_DIR)) {
  try { fs.mkdirSync(DOWNLOADS_DIR, { recursive: true }); } catch (e) {}
}

const SAVED_INDEX_NAME = '.riffle-saved.json';
const savedIndexPath = () => path.join(DOWNLOADS_DIR, SAVED_INDEX_NAME);

// switches the Saved folder right away; with move, the saved songs and their index go along
async function setDownloadsDir(dir, move) {
  const target = dir ? path.resolve(dir) : DEFAULT_DOWNLOADS_DIR;
  const current = DOWNLOADS_DIR;
  if (path.relative(current, target) === '') return { ok: true, dir: target };
  await fs.promises.mkdir(target, { recursive: true });
  await fs.promises.access(target, fs.constants.W_OK);
  let moved = 0;
  if (move) {
    const index = readSavedIndex();
    const files = (await fs.promises.readdir(current).catch(() => [])).filter(n => SAVED_AUDIO_RE.test(n));
    for (const name of files) {
      const from = path.join(current, name);
      const to = path.join(target, name);
      try {
        await fs.promises.rename(from, to);
      } catch (e) {
        await fs.promises.copyFile(from, to);
        await fs.promises.unlink(from).catch(() => {});
      }
      moved++;
    }
    const merged = Object.assign(safeJsonParse(await fs.promises.readFile(path.join(target, SAVED_INDEX_NAME), 'utf-8').catch(() => ''), {}) || {}, index);
    await fs.promises.writeFile(path.join(target, SAVED_INDEX_NAME), JSON.stringify(merged, null, 2), 'utf-8');
    await fs.promises.unlink(path.join(current, SAVED_INDEX_NAME)).catch(() => {});
  }
  DOWNLOADS_DIR = target;
  require('./platform').writeConfig({ downloadDir: dir ? target : null });
  return { ok: true, dir: target, moved };
}
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
  try { return JSON.parse(fs.readFileSync(savedIndexPath(), 'utf-8')) || {}; } catch (e) { return {}; }
}

function writeSavedIndex(index) {
  try { fs.writeFileSync(savedIndexPath(), JSON.stringify(index, null, 2), 'utf-8'); } catch (e) {}
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

// downloads run one at a time from a queue the window polls while something is active
const downloadJobs = new Map();
let activeDownload = null;
let downloadSeq = 0;

function publicJob(job) {
  const { id, title, artist, format, status, progress, speed, eta, error, filename, createdAt } = job;
  return { id, title, artist, format, status, progress: Math.round(progress || 0), speed, eta, error, filename, createdAt };
}

function createDownloadJob(q) {
  const validFormats = ['mp3', 'm4a', 'flac', 'opus', 'wav'];
  const format = validFormats.includes(String(q.format || '').toLowerCase()) ? String(q.format).toLowerCase() : 'mp3';
  const job = {
    id: `dl${Date.now().toString(36)}${(++downloadSeq).toString(36)}`,
    url: String(q.url || ''),
    title: String(q.title || '') || 'untitled',
    artist: String(q.artist || '') || 'unknown artist',
    format,
    quality: /^\d{1,3}$/.test(String(q.quality)) ? String(q.quality) : '0',
    meta: { id: String(q.id || ''), thumbnail: String(q.thumbnail || ''), duration: Number(q.duration) || 0, platform: String(q.platform || '') },
    status: 'queued', progress: 0, speed: '', eta: '', error: null, filename: null,
    attempts: 0, createdAt: Date.now(), proc: null
  };
  downloadJobs.set(job.id, job);
  // keep the list short: drop the oldest finished jobs
  const finished = [...downloadJobs.values()].filter(j => ['done', 'error', 'canceled'].includes(j.status));
  for (const j of finished.slice(0, Math.max(0, finished.length - 100))) downloadJobs.delete(j.id);
  pumpDownloads();
  return job;
}

function pumpDownloads() {
  if (activeDownload) return;
  const next = [...downloadJobs.values()].find(j => j.status === 'queued');
  if (next) runDownloadJob(next);
}

function killTree(proc) {
  if (!proc || proc.exitCode !== null) return;
  if (process.platform === 'win32') {
    try { spawn('taskkill', ['/pid', String(proc.pid), '/T', '/F'], { windowsHide: true }); return; } catch (e) {}
  }
  try { proc.kill('SIGKILL'); } catch (e) {}
}

function runDownloadJob(job) {
  activeDownload = job;
  Object.assign(job, { status: 'downloading', progress: 0, speed: '', eta: '' });
  const cleanTitle = sanitizeFilename(job.title);
  const cleanArtist = sanitizeFilename(job.artist);
  const dir = DOWNLOADS_DIR;
  const outFilename = `${cleanArtist} - ${cleanTitle}.${job.format}`;
  const prefix = `${cleanArtist} - ${cleanTitle}.`;
  let target = job.url;
  if (!isHttpUrl(target) || target.includes('deezer.com') || target.includes('spotify.com')) {
    target = `ytsearch1:${cleanArtist} ${cleanTitle} official audio`;
  }
  const args = [
    '--no-playlist', '--no-check-certificates', '--no-warnings', '--newline',
    '--progress-template', 'download:RFPROG %(progress._percent_str)s|%(progress._speed_str)s|%(progress._eta_str)s',
    '-x', '--audio-format', job.format, '--audio-quality', job.quality
  ];
  // the second try skips the cover and tags, which is what usually breaks
  if (job.attempts === 0) args.push('--embed-thumbnail', '--add-metadata');
  args.push('-o', path.join(dir, `${cleanArtist} - ${cleanTitle}.%(ext)s`));
  args.push('--extractor-args', 'youtube:player_client=android_creator,android,web', '--', target);

  const existedBefore = fs.existsSync(path.join(dir, outFilename));
  const cleanup = async () => {
    const files = await fs.promises.readdir(dir).catch(() => []);
    for (const file of files) {
      if (!file.startsWith(prefix)) continue;
      const partial = /\.(part|ytdl|jpg|jpeg|png|webp)$/i.test(file) || /\.part-Frag\d+/i.test(file) || /\.temp\./i.test(file);
      const canceledOutput = job.status === 'canceled' && file === outFilename && !existedBefore;
      if (partial || canceledOutput) await fs.promises.unlink(path.join(dir, file)).catch(() => {});
    }
  };

  let cmd;
  try { cmd = ytDlpCommand(args); } catch (e) {
    Object.assign(job, { status: 'error', error: e.message });
    activeDownload = null;
    return pumpDownloads();
  }
  const proc = spawn(cmd.bin, cmd.args, { windowsHide: true });
  job.proc = proc;
  const timer = setTimeout(() => killTree(proc), DOWNLOAD_TIMEOUT_MS);
  let errText = '';
  const onData = (chunk) => {
    const text = chunk.toString('utf8');
    const m = text.match(/RFPROG\s*([\d.]+)%\|([^|]*)\|([^\r\n]*)/);
    if (m) {
      job.progress = parseFloat(m[1]) || 0;
      job.speed = m[2].trim() === 'Unknown' ? '' : m[2].trim();
      job.eta = m[3].trim() === 'Unknown' ? '' : m[3].trim();
    } else if (/\[(ExtractAudio|ffmpeg|EmbedThumbnail|Metadata)\]/.test(text) && job.status === 'downloading') {
      job.status = 'converting';
      job.progress = 100;
    }
  };
  proc.stdout.on('data', onData);
  proc.stderr.on('data', (c) => { errText = (errText + c.toString()).slice(-2000); onData(c); });
  const finish = async (code) => {
    clearTimeout(timer);
    job.proc = null;
    activeDownload = null;
    if (job.status === 'canceled') {
      await cleanup();
    } else if (code === 0) {
      Object.assign(job, { status: 'done', progress: 100, filename: outFilename });
      const index = readSavedIndex();
      index[outFilename] = {
        id: job.meta.id, title: job.title, artist: job.artist, duration: job.meta.duration,
        thumbnail: job.meta.thumbnail, url: job.url, platform: job.meta.platform || 'youtube', savedAt: Date.now()
      };
      writeSavedIndex(index);
      await cleanup();
    } else if (job.attempts < 1) {
      job.attempts++;
      job.status = 'queued';
    } else {
      const line = errText.split(/\r?\n/).reverse().find(l => /ERROR/.test(l));
      Object.assign(job, { status: 'error', error: line ? line.replace(/^.*?ERROR:\s*/, '').slice(0, 200) : 'download failed' });
      await cleanup();
    }
    pumpDownloads();
  };
  proc.on('close', finish);
  proc.on('error', (e) => { errText = e.message; finish(-1); });
}

function cancelDownloadJob(id) {
  const job = downloadJobs.get(id);
  if (!job || !['queued', 'downloading', 'converting'].includes(job.status)) return false;
  const running = !!job.proc;
  job.status = 'canceled';
  if (running) killTree(job.proc);
  return true;
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

// lyrics files are named by a hash of artist + title. The old names replaced every non-Latin
// character with "_", so titles in other scripts collided; those old files are still read when
// the title has no such characters
function lyricsFileKey(title, artist) {
  return crypto.createHash('sha1').update(`${(artist || '').trim().toLowerCase()}\u0000${(title || '').trim().toLowerCase()}`).digest('hex').slice(0, 16);
}
const isPlainAscii = (text) => /^[\x00-\x7F]*$/.test(text);

function legacyCustomLyricsPath(title, artist) {
  const safeName = `${(artist || 'unknown').replace(/[^\w\s-]/g, '_')}_${(title || 'untitled').replace(/[^\w\s-]/g, '_')}.lrc`.toLowerCase().replace(/\s+/g, '_');
  return path.join(CUSTOM_LYRICS_DIR, safeName);
}

function legacyFetchedLyricsPath(title, artist) {
  const cleanTitle = (title || '').replace(/[^a-zA-Z0-9_-]/g, '_').toLowerCase();
  const cleanArtist = (artist || '').replace(/[^a-zA-Z0-9_-]/g, '_').toLowerCase();
  return path.join(LYRICS_DIR, `${cleanArtist}___${cleanTitle}.lrc`);
}

function pickLyricsPath(dir, legacy, title, artist) {
  const hashed = path.join(dir, lyricsFileKey(title, artist) + '.lrc');
  if (!fs.existsSync(hashed) && isPlainAscii((title || '') + (artist || '')) && fs.existsSync(legacy)) return legacy;
  return hashed;
}

function getCustomLyricsPath(title, artist) {
  return pickLyricsPath(CUSTOM_LYRICS_DIR, legacyCustomLyricsPath(title, artist), title, artist);
}

function getFetchedLyricsPath(title, artist) {
  return pickLyricsPath(LYRICS_DIR, legacyFetchedLyricsPath(title, artist), title, artist);
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
      remember(lyricsCache, cacheKey, { text: customLyrics, isCustom: true });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ success: true, lyrics: customLyrics, isCustom: true }));
    } catch (e) {}
  }

  const fetchedLyricsPath = getFetchedLyricsPath(title, artist);
  if (fs.existsSync(fetchedLyricsPath)) {
    try {
      const diskLyrics = await fs.promises.readFile(fetchedLyricsPath, 'utf-8');
      remember(lyricsCache, cacheKey, { text: diskLyrics, isCustom: false });
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
    remember(lyricsCache, cacheKey, { text: rawLyrics, isCustom: false });

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
      if (typeof lyrics !== 'string') {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ success: false, error: 'No lyrics provided' }));
      }

      // saved under the hashed name; an empty editor removes your lyrics so the found ones come back
      const hashedPath = path.join(CUSTOM_LYRICS_DIR, lyricsFileKey(title, artist) + '.lrc');
      const legacyPath = legacyCustomLyricsPath(title, artist);
      if (lyrics.trim()) await fs.promises.writeFile(hashedPath, lyrics, 'utf-8');
      else await fs.promises.rm(hashedPath, { force: true });
      if (isPlainAscii((title || '') + (artist || ''))) await fs.promises.rm(legacyPath, { force: true });

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

// suggestion language follows the system locale, otherwise Google guesses it from the IP
function suggestLang() {
  let locale = '';
  try { locale = require('electron').app.getLocale(); } catch (e) {}
  if (!locale) { try { locale = Intl.DateTimeFormat().resolvedOptions().locale; } catch (e) {} }
  return locale || 'en';
}

async function fetchSuggestions(query) {
  const q = String(query || '').trim().toLowerCase();
  if (!q || q.length > 120 || /^https?:\/\//i.test(q)) return [];
  if (suggestCache.has(q)) return suggestCache.get(q);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 3500);
  try {
    const res = await fetch(`https://suggestqueries.google.com/complete/search?client=firefox&ds=yt&hl=${encodeURIComponent(suggestLang())}&q=${encodeURIComponent(q)}`, { signal: controller.signal });
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
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Riffle-Token, Range');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    return res.end();
  }

  const parsedUrl = url.parse(req.url, true);

  if (parsedUrl.pathname.startsWith('/api/') && !OPEN_ROUTES.has(parsedUrl.pathname) && !tokenMatches(req.headers['x-riffle-token'])) {
    res.writeHead(403);
    return res.end();
  }

  if (parsedUrl.pathname === '/api/translate' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => { body += chunk; if (body.length > 200000) req.destroy(); });
    req.on('end', async () => {
      const payload = safeJsonParse(body, {});
      const lines = Array.isArray(payload.lines) ? payload.lines.map(l => String(l || '')).slice(0, 400) : [];
      const target = /^[a-zA-Z-]{2,8}$/.test(payload.target || '') ? payload.target : 'en';
      try {
        const result = lines.length ? await translateLines(lines, target) : { translations: [], source: '' };
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, ...result }));
      } catch (e) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: e.message }));
      }
    });
    return;
  }

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
    const q = parsedUrl.query;
    if (!q.url && !(q.title && q.artist)) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ success: false, error: 'missing track information' }));
    }
    const job = createDownloadJob(q);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ success: true, job: publicJob(job) }));
  }

  if (parsedUrl.pathname === '/api/download-jobs') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ jobs: [...downloadJobs.values()].map(publicJob) }));
  }

  if (parsedUrl.pathname === '/api/download-cancel' && req.method === 'POST') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ success: cancelDownloadJob(String(parsedUrl.query.id || '')) }));
  }

  if (parsedUrl.pathname === '/api/download-clear' && req.method === 'POST') {
    for (const [id, j] of downloadJobs) if (['done', 'error', 'canceled'].includes(j.status)) downloadJobs.delete(id);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ success: true }));
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

  if (parsedUrl.pathname === '/api/jukebox') {
    const id = String(parsedUrl.query.id || '');
    const saved = String(parsedUrl.query.saved || '');
    if (!id && !saved) {
      res.writeHead(400);
      return res.end();
    }
    getJukeboxAnalysis(id, saved, String(parsedUrl.query.url || ''), String(parsedUrl.query.platform || '')).then((data) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, ...data }));
    }).catch((e) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, error: e.message }));
    });
    return;
  }

  if (parsedUrl.pathname === '/api/local-track') {
    const trackId = parsedUrl.query.id || '';
    return handleLocalTrack(req, res, trackId);
  }

  if (parsedUrl.pathname === '/api/spotify-auth-start') {
    const clientId = spotifyClientId();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    if (!/^[a-f0-9]{32}$/i.test(clientId)) return res.end(JSON.stringify({ success: false, error: 'no client id', redirectUri: spotifyRedirectUri() }));
    const verifier = crypto.randomBytes(48).toString('base64url');
    spotifyLogin = { verifier, state: crypto.randomBytes(16).toString('hex'), clientId, redirectUri: spotifyRedirectUri() };
    const q = new URLSearchParams({
      response_type: 'code', client_id: clientId, scope: SPOTIFY_SCOPES, redirect_uri: spotifyLogin.redirectUri, state: spotifyLogin.state,
      code_challenge_method: 'S256', code_challenge: crypto.createHash('sha256').update(verifier).digest('base64url')
    });
    return res.end(JSON.stringify({ success: true, url: `https://accounts.spotify.com/authorize?${q}`, redirectUri: spotifyLogin.redirectUri }));
  }

  // the browser lands here after the Spotify login; the random state ties it to our own request
  if (parsedUrl.pathname === '/api/spotify-callback') {
    const page = (msg) => `<!DOCTYPE html><html><head><meta charset="utf-8"><title>Riffle</title></head><body style="font-family:system-ui;background:#1b1b1f;color:#e6e1e5;display:grid;place-items:center;height:100vh;margin:0"><p>${msg}</p></body></html>`;
    const login = spotifyLogin;
    if (!login || parsedUrl.query.state !== login.state || !parsedUrl.query.code) {
      res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(page('The Spotify login did not go through. You can close this tab and try again in Riffle.'));
    }
    spotifyLogin = null;
    spotifyTokenRequest({ grant_type: 'authorization_code', code: String(parsedUrl.query.code), redirect_uri: login.redirectUri, client_id: login.clientId, code_verifier: login.verifier })
      .then((data) => {
        writeSpotifyUser({ clientId: login.clientId, access: data.access_token, refresh: data.refresh_token, expiresAt: Date.now() + (data.expires_in || 3600) * 1000 });
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(page('Riffle is connected to your Spotify account. You can close this tab.'));
      })
      .catch(() => {
        res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(page('The Spotify login did not go through. You can close this tab and try again in Riffle.'));
      });
    return;
  }

  if (parsedUrl.pathname === '/api/spotify-status') {
    const u = readSpotifyUser();
    const reply = (o) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(o)); };
    if (!u || !u.refresh) return reply({ connected: false, hasClientId: /^[a-f0-9]{32}$/i.test(spotifyClientId()), redirectUri: spotifyRedirectUri() });
    spotifyApi('me').then(me => reply({ connected: true, name: me.display_name || me.id })).catch(() => reply({ connected: false, expired: true, hasClientId: true, redirectUri: spotifyRedirectUri() }));
    return;
  }

  if (parsedUrl.pathname === '/api/spotify-logout' && req.method === 'POST') {
    fs.promises.unlink(SPOTIFY_USER_PATH).catch(() => {});
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ success: true }));
  }

  if (parsedUrl.pathname === '/api/spotify-library') {
    Promise.all([
      spotifyApi('me/tracks?limit=1'),
      spotifyPaged('me/playlists?limit=50', p => p && p.id && { id: p.id, name: p.name, count: (p.tracks || p.items || {}).total || 0 }, 1000)
    ]).then(([likes, playlists]) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, likes: likes.total || 0, playlists }));
    }).catch((e) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, error: e.message }));
    });
    return;
  }

  if (parsedUrl.pathname === '/api/spotify-collection') {
    const id = String(parsedUrl.query.id || '');
    const job = id === 'likes'
      ? spotifyPaged('me/tracks?limit=50', it => spotifyItemTrack(it.track))
      : /^[A-Za-z0-9]+$/.test(id) ? spotifyPaged(`playlists/${id}/tracks?limit=100`, it => spotifyItemTrack(it.track || it.item)) : Promise.reject(new Error('bad id'));
    job.then((tracks) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, tracks }));
    }).catch((e) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, error: e.message }));
    });
    return;
  }

  if (parsedUrl.pathname === '/api/playlist-import') {
    const link = String(parsedUrl.query.url || '').trim();
    readPlaylistLink(link).then((data) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: !!data.tracks.length, error: data.tracks.length ? null : 'empty', ...data }));
    }).catch((e) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, error: e.message === 'unsupported link' || e.message === 'not a link' ? e.message : 'unreadable' }));
    });
    return;
  }

  if (parsedUrl.pathname === '/api/spotify-import') {
    const link = String(parsedUrl.query.url || '').trim();
    if (!SPOTIFY_URL_RE.test(link)) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ success: false, error: 'not a Spotify link' }));
    }
    readSpotifyEmbed(link).then((data) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, ...data }));
    }).catch((e) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, error: e.message }));
    });
    return;
  }

  if (parsedUrl.pathname === '/api/library') {
    const list = Object.values(libraryIndex).sort((a, b) => (b.addedAt || 0) - (a.addedAt || 0)).map(libraryTrack);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify(list));
  }

  if (parsedUrl.pathname === '/api/library-file') {
    return handleLibraryFile(req, res, String(parsedUrl.query.id || ''));
  }

  if (parsedUrl.pathname === '/api/library-add' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => { body += chunk; if (body.length > 500000) req.destroy(); });
    req.on('end', async () => {
      const items = (safeJsonParse(body, {}).items || []).filter(i => i && LIBRARY_FILE_RE.test(i.file) && i.file.startsWith(i.id + '.'));
      const added = [];
      // one at a time: each probe is an ffmpeg process
      for (const item of items) {
        const fullPath = path.join(LIBRARY_DIR, item.file);
        if (!fs.existsSync(fullPath)) continue;
        const known = libraryIndex[item.id];
        const tags = await probeLibraryFile(fullPath, item.id);
        const guess = guessFromFileName(item.name);
        libraryIndex[item.id] = {
          id: item.id,
          file: item.file,
          title: tags.title || guess.title,
          artist: tags.artist || guess.artist,
          album: tags.album || '',
          duration: tags.duration || 0,
          hasCover: Boolean(tags.hasCover),
          addedAt: known ? known.addedAt : Date.now()
        };
        added.push(libraryTrack(libraryIndex[item.id]));
      }
      saveLibraryIndex();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, tracks: added }));
    });
    return;
  }

  if (parsedUrl.pathname === '/api/library-remove' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', async () => {
      const id = String(safeJsonParse(body, {}).id || '');
      const item = libraryIndex[id];
      if (item) {
        if (LIBRARY_FILE_RE.test(item.file)) await fs.promises.rm(path.join(LIBRARY_DIR, item.file), { force: true });
        await fs.promises.rm(path.join(THUMBNAILS_DIR, `${id}.jpg`), { force: true });
        delete libraryIndex[id];
        saveLibraryIndex();
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: Boolean(item) }));
    });
    return;
  }

  if (parsedUrl.pathname === '/api/library-update' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      const p = safeJsonParse(body, {});
      const item = libraryIndex[String(p.id || '')];
      if (item && Number.isFinite(p.duration) && p.duration > 0 && !item.duration) {
        item.duration = Math.round(p.duration);
        saveLibraryIndex();
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: Boolean(item) }));
    });
    return;
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
  if (server.listening) return Promise.resolve(server.address().port);
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

module.exports = {
  startServer, PORT, getServerToken: () => SERVER_TOKEN,
  setDownloadsDir, getDownloadsDir: () => ({ dir: DOWNLOADS_DIR, defaultDir: DEFAULT_DOWNLOADS_DIR })
};

if (require.main === module) {
  startServer();
}
