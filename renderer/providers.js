'use strict';

/* =========================================================
   Anime Stream+ — Direct Stream Provider Layer
   Queries public Consumet-compatible APIs to get real
   HLS/.m3u8 stream URLs by AniList ID, no webview needed.
   =========================================================

   Provider priority order (tried in sequence):
     1. Anify TV  (AniList-native, quickest)
     2. Consumet HiAnime (Zoro) — multi-instance fallback
     3. Consumet Gogoanime     — multi-instance fallback
   ========================================================= */

const CONSUMET_INSTANCES = [
  'https://consumet-api.onrender.com',
  'https://api.consumet.org',
  'https://consumet.onrender.com',
];

const ANIFY_INSTANCE = 'https://api.anify.tv';

/* ----------------------------------------------------------
   Utility: fetch with timeout
   ---------------------------------------------------------- */
async function fetchWithTimeout(url, opts = {}, timeoutMs = 12000) {
  const controller = new AbortController();
  const tid = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const r = await fetch(url, { ...opts, signal: controller.signal });
    clearTimeout(tid);
    return r;
  } catch (e) {
    clearTimeout(tid);
    throw e;
  }
}

async function fetchJSON(url, timeoutMs = 12000) {
  const r = await fetchWithTimeout(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
      'Accept': 'application/json'
    }
  }, timeoutMs);
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}

/* ----------------------------------------------------------
   Provider: Anify TV  (AniList-native)
   GET /sources?id={anilistId}&episode={ep}&provider=...
   ---------------------------------------------------------- */
async function extractFromAnify(anilistId, ep) {
  const providers = ['zoro', 'gogoanime', 'animepahe'];
  for (const prov of providers) {
    try {
      const url = `${ANIFY_INSTANCE}/sources?id=${anilistId}&episode=${ep}&provider=${prov}`;
      console.log(`[Provider:Anify/${prov}] Trying:`, url);
      const data = await fetchJSON(url, 15000);

      const sources = data?.sources || [];
      const hlsSrc = sources.find(s =>
        s.url && (s.url.includes('.m3u8') || s.quality === 'auto' || s.quality === 'default')
      ) || sources.find(s => s.url && s.url.startsWith('http'));

      if (hlsSrc?.url) {
        console.log(`[Provider:Anify/${prov}] Got stream:`, hlsSrc.url);
        return {
          url: hlsSrc.url,
          provider: `Anify (${prov})`,
          subtitles: data.subtitles || [],
          headers: data.headers || {},
          qualities: sources.map(s => ({ label: s.quality || 'auto', url: s.url }))
        };
      }
    } catch (e) {
      console.warn(`[Provider:Anify/${prov}] Failed:`, e.message);
    }
  }
  return null;
}

/* ----------------------------------------------------------
   Provider: Consumet HiAnime (Zoro) by AniList ID
   ---------------------------------------------------------- */
async function searchConsumetHianime(instance, title, anilistId) {
  // Try AniList ID mapping first
  try {
    const mapUrl = `${instance}/meta/anilist/info/${anilistId}?provider=zoro`;
    const data = await fetchJSON(mapUrl, 12000);
    if (data?.episodes?.length) return data.episodes;
  } catch {}

  // Fallback: search by title
  const searchUrl = `${instance}/anime/zoro/${encodeURIComponent(title)}`;
  const searchData = await fetchJSON(searchUrl, 10000);
  const first = searchData?.results?.[0];
  if (!first?.id) return null;

  const infoData = await fetchJSON(`${instance}/anime/zoro/info?id=${encodeURIComponent(first.id)}`, 10000);
  return infoData?.episodes || null;
}

async function extractFromConsumetHianime(instance, title, anilistId, ep) {
  try {
    const episodes = await searchConsumetHianime(instance, title, anilistId);
    if (!episodes?.length) return null;

    const epEntry = episodes.find(e => e.number === ep || e.number === String(ep))
      || episodes[Math.max(0, ep - 1)];
    if (!epEntry?.id) return null;

    const srcUrl = `${instance}/anime/zoro/watch?episodeId=${encodeURIComponent(epEntry.id)}`;
    console.log(`[Provider:HiAnime] Watch URL:`, srcUrl);
    const data = await fetchJSON(srcUrl, 15000);

    const sources = data?.sources || [];
    const hlsSrc = sources.find(s => s.url?.includes('.m3u8') || s.isM3U8)
      || sources.find(s => s.url?.startsWith('http'));
    if (!hlsSrc?.url) return null;

    return {
      url: hlsSrc.url,
      provider: 'HiAnime (Consumet)',
      subtitles: data.subtitles || [],
      headers: data.headers || {},
      qualities: sources.map(s => ({ label: s.quality || 'auto', url: s.url }))
    };
  } catch (e) {
    console.warn(`[Provider:HiAnime@${instance}]`, e.message);
    return null;
  }
}

/* ----------------------------------------------------------
   Provider: Consumet Gogoanime by AniList ID
   ---------------------------------------------------------- */
async function extractFromConsumetGogoanime(instance, title, anilistId, ep) {
  try {
    let episodes = null;

    // Try AniList ID mapping
    try {
      const mapUrl = `${instance}/meta/anilist/info/${anilistId}?provider=gogoanime`;
      const data = await fetchJSON(mapUrl, 12000);
      episodes = data?.episodes;
    } catch {}

    if (!episodes?.length) {
      const searchUrl = `${instance}/anime/gogoanime/${encodeURIComponent(title)}`;
      const searchData = await fetchJSON(searchUrl, 10000);
      const first = searchData?.results?.[0];
      if (!first?.id) return null;

      const infoData = await fetchJSON(`${instance}/anime/gogoanime/info/${encodeURIComponent(first.id)}`, 10000);
      episodes = infoData?.episodes;
    }

    if (!episodes?.length) return null;

    const epEntry = episodes.find(e => e.number === ep || e.number === String(ep))
      || episodes[Math.max(0, ep - 1)];
    if (!epEntry?.id) return null;

    const srcUrl = `${instance}/anime/gogoanime/watch/${encodeURIComponent(epEntry.id)}`;
    console.log(`[Provider:Gogoanime] Watch URL:`, srcUrl);
    const data = await fetchJSON(srcUrl, 15000);

    const sources = data?.sources || [];
    const best = sources.find(s => s.quality === '1080p' || s.quality === '720p')
      || sources.find(s => s.url?.includes('.m3u8') || s.isM3U8)
      || sources[0];
    if (!best?.url) return null;

    return {
      url: best.url,
      provider: 'Gogoanime (Consumet)',
      subtitles: data.subtitles || [],
      headers: data.headers || {},
      qualities: sources.map(s => ({ label: s.quality || 'auto', url: s.url }))
    };
  } catch (e) {
    console.warn(`[Provider:Gogoanime@${instance}]`, e.message);
    return null;
  }
}

/* ----------------------------------------------------------
   Main Extraction Entry Point
   ---------------------------------------------------------- */
window.StreamProviders = {
  /**
   * Extract a stream URL for a given anime episode.
   * @param {number}   anilistId   AniList media ID
   * @param {string}   title       English/Romaji title
   * @param {number}   ep          Episode number (1-based)
   * @param {Function} onProgress  Called with status string as each step runs
   * @returns {Promise<{url, provider, subtitles, headers, qualities}|null>}
   */
  async extract(anilistId, title, ep, onProgress = () => {}) {
    console.log(`[StreamProviders] Extracting: "${title}" EP${ep} (AniList #${anilistId})`);

    // Strategy 1: Anify TV
    onProgress('Querying Anify (HiAnime/Gogoanime)…');
    try {
      const result = await extractFromAnify(anilistId, ep);
      if (result) return result;
    } catch (e) {
      console.warn('[StreamProviders] Anify error:', e.message);
    }

    // Strategy 2: Consumet HiAnime (all instances)
    for (const inst of CONSUMET_INSTANCES) {
      onProgress('Querying HiAnime via Consumet…');
      const result = await extractFromConsumetHianime(inst, title, anilistId, ep);
      if (result) return result;
    }

    // Strategy 3: Consumet Gogoanime (all instances)
    for (const inst of CONSUMET_INSTANCES) {
      onProgress('Querying Gogoanime via Consumet…');
      const result = await extractFromConsumetGogoanime(inst, title, anilistId, ep);
      if (result) return result;
    }

    console.warn('[StreamProviders] All API providers exhausted — falling back to webview.');
    return null;
  },

  /** Quick reachability test for a stream URL */
  async testUrl(url) {
    try {
      const r = await fetchWithTimeout(url, { method: 'HEAD' }, 8000);
      return r.ok || r.status === 206;
    } catch {
      return false;
    }
  }
};
