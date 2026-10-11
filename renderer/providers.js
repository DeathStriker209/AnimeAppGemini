'use strict';

/* =========================================================
   Anime Stream+ — Direct Stream Provider Layer
   Uses the AllAnime API (allanime.day) — the same backend
   as the Zangetsu app — for fast, reliable stream extraction.
   Target: stream ready in < 15 seconds.
   ========================================================= */

// ── AllAnime API constants (from Zangetsu's allanime.js) ──
const AA_API     = 'https://api.allanime.day/api';
const AA_REFERER = 'https://allanime.to';
const AA_ORIGIN  = 'https://allanime.to';
const AA_UA      = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:150.0) Gecko/20100101 Firefox/150.0';

// Hex decode map for AllAnime's obfuscated source URLs
const AA_HEXMAP = {"79":"A","7a":"B","7b":"C","7c":"D","7d":"E","7e":"F","7f":"G","70":"H","71":"I","72":"J","73":"K","74":"L","75":"M","76":"N","77":"O","68":"P","69":"Q","6a":"R","6b":"S","6c":"T","6d":"U","6e":"V","6f":"W","60":"X","61":"Y","62":"Z","59":"a","5a":"b","5b":"c","5c":"d","5d":"e","5e":"f","5f":"g","50":"h","51":"i","52":"j","53":"k","54":"l","55":"m","56":"n","57":"o","48":"p","49":"q","4a":"r","4b":"s","4c":"t","4d":"u","4e":"v","4f":"w","40":"x","41":"y","42":"z","08":"0","09":"1","0a":"2","0b":"3","0c":"4","0d":"5","0e":"6","0f":"7","00":"8","01":"9","15":"-","16":".","67":"_","46":"~","02":":","17":"/","07":"?","1b":"#","63":"[","65":"]","78":"@","19":"!","1c":"$","1e":"&","10":"(","11":")","12":"*","13":"+","14":",","03":";","05":"=","1d":"%"};

function aaDecodeUrl(s) {
  s = String(s || '');
  if (!s.startsWith('--')) return s;
  const body = s.slice(2);
  let out = '';
  for (let i = 0; i + 1 < body.length; i += 2) {
    const ch = AA_HEXMAP[body.substr(i, 2)];
    out += (ch == null ? '' : ch);
  }
  return out.replace('/clock', '/clock.json');
}

// Fetch with timeout + browser-like headers
async function aaFetch(url, opts = {}, timeoutMs = 12000) {
  const controller = new AbortController();
  const tid = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      ...opts,
      signal: controller.signal,
      headers: {
        'User-Agent': AA_UA,
        'Referer': AA_REFERER,
        'Origin': AA_ORIGIN,
        ...(opts.headers || {})
      }
    });
    clearTimeout(tid);
    return res;
  } catch (e) {
    clearTimeout(tid);
    throw e;
  }
}

async function aaPost(query, variables) {
  const res = await aaFetch(AA_API, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query, variables })
  }, 12000);
  if (!res.ok) throw new Error(`AllAnime HTTP ${res.status}`);
  const text = await res.text();
  try { return JSON.parse(text); } catch { throw new Error('AllAnime: bad JSON'); }
}

// ── GraphQL queries ──
const SEARCH_GQL = `query($search:SearchInput $limit:Int $page:Int $translationType:VaildTranslationTypeEnumType $countryOrigin:VaildCountryOriginEnumType){shows(search:$search limit:$limit page:$page translationType:$translationType countryOrigin:$countryOrigin){edges{_id name thumbnail availableEpisodes}}}`;
const SHOW_GQL   = `query($showId:String!){show(_id:$showId){_id name englishName thumbnail availableEpisodes availableEpisodesDetail}}`;
const SOURCES_HASH = 'd405d0edd690624b66baba3068e0edc3ac90f1597d898a1ec8db4e5c43c00fec';

/* ----------------------------------------------------------
   Step 1: Search AllAnime for the show by title
   ---------------------------------------------------------- */
async function aaSearch(title, mode = 'sub') {
  const vars = {
    search: { allowAdult: false, allowUnknown: false, query: title },
    limit: 10,
    page: 1,
    translationType: mode,
    countryOrigin: 'ALL'
  };
  const json = await aaPost(SEARCH_GQL, vars);
  return (json?.data?.shows?.edges) || [];
}

/* ----------------------------------------------------------
   Step 2: Get episode list for a show by its AllAnime _id
   ---------------------------------------------------------- */
async function aaGetEpisodes(showId, mode = 'sub') {
  const json = await aaPost(SHOW_GQL, { showId });
  const show = json?.data?.show || {};
  const aed = show.availableEpisodesDetail || {};
  const keys = (aed[mode] || []).slice().sort((a, b) => parseFloat(a) - parseFloat(b));
  return { show, episodes: keys };
}

/* ----------------------------------------------------------
   Step 3: Get stream sources for a specific episode
   Uses the persisted query hash (Zangetsu SOURCES_HASH)
   ---------------------------------------------------------- */
async function aaGetSources(showId, mode, epNo) {
  const variables = encodeURIComponent(JSON.stringify({
    showId,
    translationType: mode,
    episodeString: String(epNo)
  }));
  const extensions = encodeURIComponent(JSON.stringify({
    persistedQuery: { version: 1, sha256Hash: SOURCES_HASH }
  }));
  const url = `${AA_API}?variables=${variables}&extensions=${extensions}`;
  const res = await aaFetch(url, {}, 12000);
  if (!res.ok) throw new Error(`AllAnime sources HTTP ${res.status}`);
  const text = await res.text();
  const json = JSON.parse(text);
  const sourceUrls = json?.data?.episode?.sourceUrls;
  if (!sourceUrls?.length) throw new Error('AllAnime: no sourceUrls');
  return sourceUrls;
}

/* ----------------------------------------------------------
   Step 4: Resolve the /clock.json CDN paths to real HLS URLs
   ---------------------------------------------------------- */
async function aaResolveClock(path) {
  const url = 'https://allanime.day' + path;
  try {
    const res = await aaFetch(url, {}, 8000);
    if (!res.ok) return [];
    const text = await res.text();
    const json = JSON.parse(text);
    const links = json?.links || [];
    return links
      .filter(lk => lk.link || lk.url)
      .map(lk => {
        const u = lk.link || lk.url;
        const isHls = lk.hls === true || /\.m3u8/.test(u);
        return { url: u, quality: lk.resolutionStr || 'auto', isHls };
      });
  } catch {
    return [];
  }
}

/* ----------------------------------------------------------
   Main: resolve all source URLs to playable links
   ---------------------------------------------------------- */
async function aaResolvePlayable(sourceUrls) {
  const results = [];
  const jobs = [];

  for (const su of sourceUrls) {
    const name = su.sourceName || '';
    const raw = String(su.sourceUrl || '');

    // Skip known dead hosts
    if (name === 'Ss-Hls') continue;

    if (raw.startsWith('--')) {
      // Obfuscated clock path
      const decoded = aaDecodeUrl(raw);
      if (decoded.includes('/apivtwo/clock') || decoded.includes('/clock')) {
        jobs.push(aaResolveClock(decoded).catch(() => []));
      }
    } else if (/^https?:\/\//.test(raw)) {
      // Direct URL
      const isHls = /\.m3u8/.test(raw);
      results.push({ url: raw, quality: 'auto', isHls });
    }
  }

  // Resolve all clock paths in parallel with a 10s deadline
  const settled = await Promise.allSettled(jobs);
  for (const r of settled) {
    if (r.status === 'fulfilled' && r.value?.length) {
      results.push(...r.value);
    }
  }

  return results;
}

/* ----------------------------------------------------------
   AllAnime Episode Count helper
   Returns how many episodes this show actually has (sub mode)
   ---------------------------------------------------------- */
async function aaGetEpisodeCount(title) {
  try {
    const edges = await aaSearch(title, 'sub');
    if (!edges.length) return null;
    const show = edges[0];
    const ae = show.availableEpisodes || {};
    return ae.sub || ae.dub || null;
  } catch {
    return null;
  }
}

/* ----------------------------------------------------------
   Main Extraction Entry Point
   ---------------------------------------------------------- */
window.StreamProviders = {
  /**
   * Extract a playable stream URL using the AllAnime API.
   * @param {number}   anilistId   AniList media ID
   * @param {string}   title       Anime title (English preferred)
   * @param {number}   ep          Episode number (1-based)
   * @param {Function} onProgress  Status callback
   * @param {string}   preferMode  'sub' or 'dub' — which to try first
   * @returns {Promise<{url, provider, subtitles, headers, qualities}|null>}
   */
  async extract(anilistId, title, ep, onProgress = () => {}, preferMode = 'sub') {
    console.log(`[AllAnime] Extracting: "${title}" EP${ep} (prefer: ${preferMode})`);

    // Try preferred mode first, then the other as fallback
    const modes = preferMode === 'dub' ? ['dub', 'sub'] : ['sub', 'dub'];

    for (const mode of modes) {
      try {
        onProgress(`Searching AllAnime (${mode})…`);

        // Search for the show
        const edges = await aaSearch(title, mode);
        if (!edges.length) {
          console.warn(`[AllAnime] No results for "${title}" (${mode})`);
          continue;
        }

        // Use first result
        const showId = edges[0]._id;
        console.log(`[AllAnime] Found show: ${edges[0].name} (id: ${showId})`);

        onProgress(`Found show, getting episode ${ep}…`);

        // Get source URLs for this episode
        let sourceUrls;
        try {
          sourceUrls = await aaGetSources(showId, mode, ep);
        } catch (e) {
          console.warn(`[AllAnime] Sources fetch failed (${mode}):`, e.message);
          continue;
        }

        onProgress('Resolving stream URLs…');

        // Resolve to playable links
        const playable = await aaResolvePlayable(sourceUrls);
        if (!playable.length) {
          console.warn(`[AllAnime] No playable sources resolved (${mode})`);
          continue;
        }

        // Prefer HLS, then any URL
        const best = playable.find(s => s.isHls) || playable[0];
        console.log(`[AllAnime] ✅ Stream (${mode}):`, best.url);

        // Update the media object's episode count while we're here
        const ae = edges[0].availableEpisodes || {};
        const epCount = ae.sub || ae.dub || null;

        return {
          url: best.url,
          provider: `AllAnime (${mode})`,
          subtitles: [],
          headers: { 'Referer': AA_REFERER, 'User-Agent': AA_UA },
          qualities: playable.map((s, i) => ({
            label: s.quality || `Source ${i + 1}`,
            url: s.url
          })),
          _allAnimeEpCount: epCount
        };
      } catch (e) {
        console.warn(`[AllAnime] Error (${mode}):`, e.message);
      }
    }

    // All AllAnime attempts failed
    console.warn('[AllAnime] All modes failed.');
    return null;
  },

  /**
   * Fetch episode count from AllAnime for a given title.
   * Used to fix the "12 episodes" bug for ongoing shows.
   */
  async getEpisodeCount(title) {
    return aaGetEpisodeCount(title);
  }
};
