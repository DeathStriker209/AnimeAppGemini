'use strict';

/* =========================================================
   Anime Stream+ Application Core
   ========================================================= */

const API_URL = 'https://graphql.anilist.co';
const bridge = window.api || null;

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
}[c]));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const store = {
  get(k, d) {
    try {
      const v = localStorage.getItem(k);
      return v == null ? d : JSON.parse(v);
    } catch {
      return d;
    }
  },
  set(k, v) {
    try {
      localStorage.setItem(k, JSON.stringify(v));
    } catch { }
  }
};

const titleOf = (m) => m?.title?.english || m?.title?.romaji || 'Untitled';
const cleanDesc = (d) => (d || '').replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, '').replace(/\n{3,}/g, '\n\n').trim();
const fmtTime = (s) => {
  s = Math.max(0, Math.floor(s || 0));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), x = s % 60;
  return (h ? h + ':' + String(m).padStart(2, '0') : m) + ':' + String(x).padStart(2, '0');
};

const FORMAT = {
  TV: 'TV',
  TV_SHORT: 'TV Short',
  MOVIE: 'Movie',
  SPECIAL: 'Special',
  OVA: 'OVA',
  ONA: 'ONA',
  MUSIC: 'Music'
};

const STATUS = {
  RELEASING: 'Airing',
  FINISHED: 'Finished',
  NOT_YET_RELEASED: 'Upcoming',
  CANCELLED: 'Cancelled',
  HIATUS: 'On hiatus'
};

const ICONS = {
  CURRENT: '▶',
  PLANNING: '📋',
  COMPLETED: '✓',
  PAUSED: '⏸',
  DROPPED: '✕'
};

const cap = (s) => (s ? s[0] + s.slice(1).toLowerCase() : '');

function currentSeason() {
  const d = new Date(), mo = d.getMonth();
  return { season: ['WINTER', 'SPRING', 'SUMMER', 'FALL'][Math.floor(mo / 3)], year: d.getFullYear() };
}

function snap(m) {
  return {
    id: m.id,
    title: m.title,
    coverImage: m.coverImage,
    bannerImage: m.bannerImage,
    format: m.format,
    episodes: m.episodes,
    seasonYear: m.seasonYear,
    averageScore: m.averageScore,
    genres: m.genres
  };
}

const clock12 = (d) => d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true });
const getProfile = () => store.get('profile', { name: '' });
const initial = (name) => (name || 'U').trim().charAt(0).toUpperCase() || 'U';
const getSkip = () => { const n = Number(store.get('skip', 10)); return [5, 10, 15, 20].includes(n) ? n : 10; };

function updateAvatar() {
  const a = $('#avatar');
  if (!a) return;
  const v = AL.viewer;
  if (v?.avatar) {
    a.innerHTML = `<img src="${esc(v.avatar)}" alt="">`;
    a.title = `${v.name} (AniList)`;
  } else {
    a.textContent = initial(getProfile().name);
    a.title = getProfile().name || 'Settings';
  }
}

let toastTimer;
function toast(msg) {
  const t = $('#toast');
  if (!t) return;
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, 3200);
}

function openExternal(url) {
  if (bridge?.openExternal) {
    bridge.openExternal(url);
  } else {
    window.open(url, '_blank', 'noopener');
  }
}

const DEFAULT_SOURCES = [
  { name: 'Anikoto TV', url: 'https://anikototv.to/watch/{slug}?ep={ep}', id: 'anikoto' },
  { name: 'Miruro', url: 'https://www.miruro.tv/watch?id={id}&ep={ep}', id: 'miruro' },
  { name: 'HiAnime', url: 'https://hianime.to/search?keyword={title}', id: 'hianime' },
  { name: 'AnimePahe', url: 'https://animepahe.ru/api?m=search&q={title}', id: 'animepahe' }
];

function toSlug(str) {
  return String(str || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

const getSources = () => {
  const raw = store.get('sources', DEFAULT_SOURCES);
  // Ensure Crunchyroll is removed everywhere as requested
  const filtered = Array.isArray(raw)
    ? raw.filter((s) => s && !/crunchyroll/i.test(s.name || '') && !/crunchyroll\.com/i.test(s.url || ''))
    : DEFAULT_SOURCES;

  // Make sure Anikoto TV and Miruro are always available
  if (!filtered.some((s) => /anikoto/i.test(s.name || ''))) {
    filtered.unshift({ name: 'Anikoto TV', url: 'https://anikototv.to/watch/{slug}?ep={ep}', id: 'anikoto' });
  }
  if (!filtered.some((s) => /miruro/i.test(s.name || ''))) {
    filtered.splice(1, 0, { name: 'Miruro', url: 'https://www.miruro.tv/watch?id={id}&ep={ep}', id: 'miruro' });
  }
  return filtered;
};

function sourceURL(src, m, ep = 1) {
  const en = m.title?.english || m.title?.romaji || '', ro = m.title?.romaji || en;
  const slug = toSlug(en || ro);
  return (src.url || '')
    .replace(/{(title|query)}/gi, encodeURIComponent(en || ro))
    .replace(/{english}/gi, encodeURIComponent(en))
    .replace(/{romaji}/gi, encodeURIComponent(ro))
    .replace(/{slug}/gi, slug)
    .replace(/{id}/gi, String(m.id || ''))
    .replace(/{ep}/gi, String(ep || 1));
}

function getEpisodeStreamUrl(sourceKey, m, ep = 1) {
  const en = m.title?.english || m.title?.romaji || '';
  const ro = m.title?.romaji || en;
  const preferredTitle = en || ro;
  const slug = toSlug(preferredTitle);
  const id = m.id;

  if (sourceKey === 'anikoto') {
    return `https://anikototv.to/watch/${slug}?ep=${ep}`;
  }
  if (sourceKey === 'miruro') {
    return `https://www.miruro.tv/watch?id=${id}&ep=${ep}`;
  }
  if (sourceKey === 'hianime') {
    return `https://hianime.to/search?keyword=${encodeURIComponent(preferredTitle)}`;
  }
  if (sourceKey === 'animepahe') {
    return `https://animepahe.ru/api?m=search&q=${encodeURIComponent(preferredTitle)}`;
  }

  const found = getSources().find((s) => (s.id && s.id === sourceKey) || s.name?.toLowerCase().includes(sourceKey));
  if (found) {
    return sourceURL(found, m, ep);
  }
  return `https://anikototv.to/watch/${slug}?ep=${ep}`;
}

const getHistory = () => store.get('history', {});
const getLibrary = () => store.get('library', {});

/* =========================================================
   AniList Core GraphQL APIs & Synchronization
   ========================================================= */
const CARD = `fragment card on Media {
  id title { romaji english } coverImage { large extraLarge color } bannerImage
  averageScore episodes format genres seasonYear status
}`;

const gqlCache = new Map();

async function gql(query, variables = {}, { auth = false, fresh = false } = {}) {
  const key = query + JSON.stringify(variables);
  if (!fresh && !auth && gqlCache.has(key)) return gqlCache.get(key);
  const headers = { 'Content-Type': 'application/json', Accept: 'application/json' };
  if (auth && AL.token) headers.Authorization = `Bearer ${AL.token}`;

  for (let attempt = 0; attempt < 3; attempt++) {
    const res = await fetch(API_URL, {
      method: 'POST',
      headers,
      body: JSON.stringify({ query, variables })
    });
    if (auth && (res.status === 401 || res.status === 400)) {
      const j = await res.json().catch(() => ({}));
      const msg = j.errors?.[0]?.message || '';
      if (res.status === 401 || /invalid token|unauthorized/i.test(msg)) {
        alLogout(true);
        throw new Error('Your AniList login expired.');
      }
      throw new Error(msg || 'AniList request failed.');
    }
    if (res.status === 429) {
      await sleep((Number(res.headers.get('Retry-After')) || 5) * 1000);
      continue;
    }
    const json = await res.json();
    if (json.errors?.length) throw new Error(json.errors[0].message);
    if (!auth) gqlCache.set(key, json.data);
    return json.data;
  }
  throw new Error('AniList rate limit hit. Try again in a moment.');
}

const mediaById = new Map();
const remember = (list) => {
  (list || []).forEach((m) => m && mediaById.set(m.id, m));
  return list || [];
};

/* =========================================================
   User List & Playlists
   ========================================================= */
const LIST_STATUSES = [
  ['CURRENT', 'Watching'],
  ['PLANNING', 'Planning'],
  ['COMPLETED', 'Completed'],
  ['PAUSED', 'Paused'],
  ['DROPPED', 'Dropped']
];
const statusLabel = (s) => (s === 'REPEATING' ? 'Rewatching' : (LIST_STATUSES.find((x) => x[0] === s) || [0, 'In list'])[1]);
const listTab = (s) => (s === 'REPEATING' ? 'CURRENT' : s);
const getList = () => store.get('mylist', {});

const AL = {
  token: store.get('al_token', ''),
  viewer: store.get('al_viewer', null),
  entries: new Map(),
  loaded: false,
  loading: null
};

async function alInit() {
  if (!AL.token) return;
  try {
    const d = await gql(`query { Viewer { id name avatar { large } siteUrl } }`, {}, { auth: true });
    AL.viewer = { id: d.Viewer.id, name: d.Viewer.name, avatar: d.Viewer.avatar?.large, url: d.Viewer.siteUrl };
    store.set('al_viewer', AL.viewer);
    updateAvatar();
    await alLoadList(true);
  } catch (err) {
    console.warn('AniList init failed:', err);
  }
}

function alLoadList(force = false) {
  if (!AL.token || !AL.viewer) return Promise.resolve();
  if (AL.loaded && !force) return Promise.resolve();
  if (AL.loading) return AL.loading;

  AL.loading = (async () => {
    const d = await gql(`query($u: Int) {
      MediaListCollection(userId: $u, type: ANIME) {
        lists {
          entries {
            id status progress score(format: POINT_10) updatedAt media { ...card }
          }
        }
      }
    } ${CARD}`, { u: AL.viewer.id }, { auth: true });

    AL.entries.clear();
    for (const l of d.MediaListCollection?.lists || []) {
      for (const e of l.entries || []) {
        if (!AL.entries.has(e.media.id)) {
          AL.entries.set(e.media.id, {
            id: e.id,
            status: e.status,
            progress: e.progress,
            score: e.score,
            updatedAt: e.updatedAt,
            media: e.media
          });
        }
      }
    }
    remember([...AL.entries.values()].map((e) => e.media));
    AL.loaded = true;
  })().finally(() => { AL.loading = null; });

  return AL.loading;
}

async function alLogin() {
  if (!bridge?.anilistLogin) {
    toast('Logging in works in the desktop app.');
    return;
  }
  const clientId = ($('#al-client')?.value || store.get('al_client', '')).trim();
  store.set('al_client', clientId);
  const r = await bridge.anilistLogin(clientId);
  if (r?.error) {
    toast(r.error);
    return;
  }
  if (r?.token) await alSetToken(r.token);
}

async function alSetToken(token) {
  AL.token = token.trim();
  store.set('al_token', AL.token);
  AL.viewer = null;
  AL.loaded = false;
  await alInit();
  if (AL.viewer) toast(`Logged in as ${AL.viewer.name}.`);
  else { toast('Login failed.'); alLogout(true); }
  render({ keepScroll: true });
}

function alLogout(silent = false) {
  AL.token = '';
  AL.viewer = null;
  AL.entries.clear();
  AL.loaded = false;
  store.set('al_token', '');
  store.set('al_viewer', null);
  updateAvatar();
  if (!silent) {
    toast('Logged out of AniList');
    render({ keepScroll: true });
  }
}

function listEntry(id) {
  if (AL.token && AL.viewer) return AL.entries.get(id) || null;
  const e = getList()[id];
  return e ? { status: e.status || 'PLANNING', progress: 0, media: e, updatedAt: (e.added || 0) / 1000 } : null;
}

const listBtnLabel = (id) => {
  const e = listEntry(id);
  return e ? `✓ ${statusLabel(e.status)}` : '+ Add to My List';
};

async function setListStatus(m, status) {
  if (AL.token && AL.viewer) {
    if (status) {
      const d = await gql(`mutation($m: Int, $s: MediaListStatus) {
        SaveMediaListEntry(mediaId: $m, status: $s) { id status progress score(format: POINT_10) updatedAt }
      }`, { m: m.id, s: status }, { auth: true });
      const e = d.SaveMediaListEntry;
      AL.entries.set(m.id, {
        id: e.id,
        status: e.status,
        progress: e.progress,
        score: e.score,
        updatedAt: e.updatedAt,
        media: { ...snap(m) }
      });
    } else {
      const cur = AL.entries.get(m.id);
      if (cur) await gql(`mutation($id: Int) { DeleteMediaListEntry(id: $id) { deleted } }`, { id: cur.id }, { auth: true });
      AL.entries.delete(m.id);
    }
  } else {
    const l = getList();
    if (status) l[m.id] = { ...snap(m), added: l[m.id]?.added || Date.now(), status };
    else delete l[m.id];
    store.set('mylist', l);
  }
  toast(status ? `Saved to ${statusLabel(status)}` : `Removed from My List`);
  $$(`[data-action="list-menu"][data-id="${m.id}"]`).forEach((b) => { b.textContent = listBtnLabel(m.id); });
  const top = state.stack[state.stack.length - 1];
  if (top.view === 'mylist' || top.view === 'home' || top.view === 'detail') render({ keepScroll: true });
}

const modal = $('#modal');

function openListMenu(m, trigger) {
  const cur = listEntry(m.id)?.status;
  const curTab = cur && listTab(cur);
  state.modal = { m, trigger };
  modal.innerHTML = `<div class="modal-card" role="dialog" aria-modal="true" aria-label="Save to list">
    <h3>Save to list</h3>
    <div class="modal-sub">${esc(titleOf(m))}</div>
    <div class="modal-opts">${LIST_STATUSES.map(([s, l]) => `<button class="modal-opt ${curTab === s ? 'on' : ''}" data-nav data-status="${s}">
      <span class="mi">${ICONS[s] || '•'}</span>${l}${curTab === s ? '<span class="tick">Current</span>' : ''}</button>`).join('')}</div>
    <div class="modal-foot">
      ${cur ? `<button class="btn danger" data-nav data-status="">Remove from list</button>` : ''}
      <button class="btn" data-nav data-close>Cancel</button>
    </div>
  </div>`;
  modal.hidden = false;
  ($('.modal-opt.on', modal) || $('.modal-opt', modal))?.focus();
}

function closeModal() {
  if (modal.hidden) return;
  modal.hidden = true;
  modal.innerHTML = '';
  state.modal?.trigger?.focus?.({ preventScroll: true });
  state.modal = null;
}

modal.addEventListener('click', async (e) => {
  if (e.target === modal || e.target.closest('[data-close]')) {
    closeModal();
    return;
  }
  const b = e.target.closest('[data-status]');
  if (!b || !state.modal) return;
  const { m } = state.modal;
  $$('button', modal).forEach((x) => { x.disabled = true; });
  try {
    await setListStatus(m, b.dataset.status || null);
    closeModal();
  } catch (err) {
    toast(err.message);
    $$('button', modal).forEach((x) => { x.disabled = false; });
  }
});

/* =========================================================
   HTML Templates & Components
   ========================================================= */
function cardHTML(m, opts = {}) {
  const score = m.averageScore ? `<span class="card-score">★ ${(m.averageScore / 10).toFixed(1)}</span>` : '';
  const local = getLibrary()[m.id];
  const badge = local ? `<span class="card-badge">ON DISK</span>` : '';
  const sub = opts.sub ?? [FORMAT[m.format], m.episodes ? `${m.episodes} eps` : null, m.seasonYear].filter(Boolean).join(' / ');
  return `<div class="card" tabindex="0" data-nav data-id="${m.id}">
    <div class="card-img" style="--c:${esc(m.coverImage?.color || '#131d2d')}">
      <img loading="lazy" src="${esc(m.coverImage?.large || '')}" alt="">${score}${badge}
    </div>
    <div class="card-title">${esc(titleOf(m))}</div>
    <div class="card-sub">${esc(sub)}</div>
  </div>`;
}

function wideHTML(h) {
  const m = h.media;
  const pct = h.dur ? Math.min(100, (h.time / h.dur) * 100) : 0;
  const img = m.bannerImage || m.coverImage?.extraLarge || m.coverImage?.large || '';
  const epLabel = h.label ? esc(h.label) : `Ep ${h.ep || 1}`;
  const durLabel = h.dur ? ` / ${Math.round(h.time / 60)}/${Math.round(h.dur / 60)} min` : '';
  return `<div class="wide" tabindex="0" data-nav data-action="resume" data-id="${m.id}" data-ep="${h.ep || 1}">
    <img loading="lazy" src="${esc(img)}" alt="">
    <div class="wide-body">
      <div class="wide-title">${esc(titleOf(m))}</div>
      <div class="wide-sub">${epLabel}${durLabel}</div>
      <div class="prog"><i style="width:${pct}%"></i></div>
    </div>
  </div>`;
}

const rail = (title, inner, cls = '') => inner ? `<h2 class="section">${esc(title)}</h2><div class="rail ${cls}">${inner}</div>` : '';

const GENRES = [
  'Action', 'Adventure', 'Comedy', 'Drama', 'Fantasy', 'Horror', 'Mahou Shoujo', 'Mecha', 'Music',
  'Mystery', 'Psychological', 'Romance', 'Sci-Fi', 'Slice of Life', 'Sports', 'Supernatural', 'Thriller'
];
const TAGS = [
  'Isekai', 'Shounen', 'Shoujo', 'Seinen', 'Josei', 'Martial Arts', 'Super Power', 'Magic', 'School',
  'Military', 'Historical', 'Samurai', 'Ninja', 'Vampire', 'Demons', 'Gods', 'Dragons', 'Mythology', 'Zombie',
  'Survival', 'Post-Apocalyptic', 'Dystopian', 'Cyberpunk', 'Space', 'Robots', 'Time Manipulation', 'Reincarnation',
  'Video Games', 'Virtual World', 'Detective', 'Crime', 'Tragedy', 'Iyashikei', 'Parody', 'Coming of Age',
  'Found Family', 'Anti-Hero', 'Villainess', 'Urban Fantasy', 'Kaiju', 'Pirates', 'Food', 'Band', 'Idol',
  'Workplace', 'Family Life', 'Delinquents', 'Boys\' Love', 'Yuri', 'Card Battle', 'Esports', 'Racing'
];
const CATEGORIES = [...GENRES.map((n) => ({ name: n, kind: 'genre' })), ...TAGS.map((n) => ({ name: n, kind: 'tag' }))];
const catColor = (i) => `hsl(${(i * 47) % 360} 42% 28%)`;

const genreTile = (c, i) => `<button class="genre" data-nav ${c.kind === 'tag' ? 'data-tag' : 'data-genre'}="${esc(c.name)}" style="--g:${catColor(i)}"><span class="glyph">${esc(c.name.slice(0, 2))}</span>${esc(c.name)}</button>`;

const loadingHTML = () => `<div class="loading"><div><div class="spinner"></div>Loading…</div></div>`;
const errorHTML = (err) => `<div class="empty"><h3>Couldn't load this page</h3><p>${esc(err.message || err)}</p></div>`;

/* =========================================================
   Application Navigation Shell Router
   ========================================================= */
const state = {
  stack: [{ view: 'home', params: {} }],
  fwd: [],
  renderId: 0,
  heroTimer: null,
  heroIndex: 0,
  heroes: [],
  modal: null,
  detail: null
};

const TAB_FOR = {
  home: 'home',
  schedule: 'schedule',
  browse: 'browse',
  genres: 'genres',
  movies: 'movies',
  mylist: 'mylist',
  library: 'library',
  settings: 'settings'
};

function go(view, params = {}) {
  const top = state.stack[state.stack.length - 1];
  if (top && top.view === view && JSON.stringify(top.params) === JSON.stringify(params)) {
    render();
    return;
  }
  state.stack.push({ view, params });
  state.fwd = [];
  render();
}

function back() {
  if (state.stack.length > 1) {
    state.fwd.push(state.stack.pop());
    render();
  }
}

function forward() {
  if (state.fwd.length) {
    state.stack.push(state.fwd.pop());
    render();
  }
}

async function render({ keepScroll = false } = {}) {
  const id = ++state.renderId;
  const { view, params } = state.stack[state.stack.length - 1];
  clearInterval(state.heroTimer);
  const tab = params.tab || TAB_FOR[view];
  $$('[data-go]').forEach((b) => b.classList.toggle('active', b.dataset.go === tab));

  const el = $('#view');
  const scroll = el.scrollTop;
  if (!keepScroll) el.innerHTML = loadingHTML();

  let out;
  try {
    const handler = VIEWS[view];
    if (!handler) throw new Error(`Unknown view: ${view}`);
    out = await handler(params);
  } catch (err) {
    console.error(err);
    out = { html: errorHTML(err) };
  }

  if (id !== state.renderId) return;
  el.innerHTML = out.html;
  el.scrollTop = keepScroll ? scroll : 0;
  out.after?.();
  if (!keepScroll || !el.contains(document.activeElement)) focusFirst();
}

function focusFirst() {
  const el = $('[data-autofocus]', $('#view')) || $('[data-nav]', $('#view'));
  el?.focus({ preventScroll: true });
}

/* =========================================================
   Episode File Linking & Matching (Desktop API)
   ========================================================= */
function guessEp(name) {
  const clean = name.replace(/\.[^.]+$/, '').replace(/\[[^\]]*\]|\([^\)]*\)/g, ' ').trim();
  let m = clean.match(/(?:ep(?:isode)?\.?|e)\s*(\d{1,4})/i);
  if (m) return parseInt(m[1], 10);
  m = clean.match(/(?:s\d+\s*)?(?:e|ep|episode)\s*(\d{1,4})/i);
  if (m) return parseInt(m[1], 10);
  m = clean.match(/(?:^|[^\d])(\d{1,4})(?:v\d+)?(?:[^\d]|$)/);
  if (m) return parseInt(m[1], 10);
  return 1;
}

async function linkFiles(m) {
  if (!bridge?.pickVideos) {
    toast('Linking local files is available in the desktop app.');
    return;
  }
  const picked = await bridge.pickVideos();
  if (!picked || !picked.length) return;

  const files = picked.map((f) => ({
    ...f,
    ep: guessEp(f.name)
  })).sort((a, b) => a.ep - b.ep);

  const lib = getLibrary();
  lib[m.id] = { media: snap(m), files };
  store.set('library', lib);
  toast(`Linked ${files.length} episode file(s) for ${titleOf(m)}`);
  render({ keepScroll: true });
}

/* =========================================================
   Sub-Views
   ========================================================= */
const VIEWS = {
  async home() {
    const { season, year } = currentSeason();
    const d = await gql(`query($season: MediaSeason, $year: Int) {
      trending: Page(perPage: 20) {
        media(sort: TRENDING_DESC, type: ANIME, isAdult: false) {
          ...card description(asHtml: false)
        }
      }
      season: Page(perPage: 20) {
        media(season: $season, seasonYear: $year, sort: POPULARITY_DESC, type: ANIME, isAdult: false) {
          ...card
        }
      }
      recent: Page(perPage: 20) {
        media(sort: START_DATE_DESC, type: ANIME, isAdult: false, status: RELEASING, popularity_greater: 3000) {
          ...card
        }
      }
      top: Page(perPage: 20) {
        media(sort: SCORE_DESC, type: ANIME, isAdult: false, popularity_greater: 20000) {
          ...card
        }
      }
      popular: Page(perPage: 20) {
        media(sort: POPULARITY_DESC, type: ANIME, isAdult: false) {
          ...card
        }
      }
    } ${CARD}`, { season, year });

    const trending = remember(d.trending.media);
    remember(d.season.media);
    remember(d.recent.media);
    remember(d.top.media);
    remember(d.popular.media);

    state.heroes = trending.filter((m) => m.bannerImage).slice(0, 6);
    state.heroIndex = 0;

    const history = Object.values(getHistory()).sort((a, b) => (b.at || 0) - (a.at || 0));
    await alLoadList().catch(() => { });
    const alWatching = AL.viewer
      ? [...AL.entries.values()].filter((e) => e.status === 'CURRENT' || e.status === 'REPEATING').sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))
      : [];

    const airing = d.season.media.map((m) => wideHTML({
      media: m,
      label: [FORMAT[m.format], m.episodes ? `${m.episodes} eps` : 'Airing'].filter(Boolean).join(' / '),
      time: 0,
      dur: 0
    }).replace('data-action="resume" ', '')).join('');

    return {
      html: `
        <div class="hero" id="hero">${heroHTML(state.heroes[0])}</div>
        ${history.length ? rail('Continue watching', history.map(wideHTML).join(''), 'wide-rail') : ''}
        ${alWatching.length ? rail('Watching on AniList', alWatching.map((e) => cardHTML(e.media, { sub: `EP ${e.progress || 0}${e.media.episodes ? ' / ' + e.media.episodes : ''}` })).join('')) : ''}
        ${rail('Airing this season', airing, 'wide-rail')}
        ${rail('Popular categories', CATEGORIES.slice(0, 24).map(genreTile).join(''), 'genres-rail')}
        ${rail('Trending now', trending.map((m) => cardHTML(m)).join(''))}
        ${rail('Popular this season', d.season.media.map((m) => cardHTML(m)).join(''))}
        ${rail('Recently started', d.recent.media.map((m) => cardHTML(m)).join(''))}
        ${rail('Top rated', d.top.media.map((m) => cardHTML(m)).join(''))}
        ${rail('All-time popular', d.popular.media.map((m) => cardHTML(m)).join(''))}
      `,
      after() {
        state.heroTimer = setInterval(() => {
          const hero = $('#hero');
          if (!hero || hero.contains(document.activeElement) || state.heroes.length < 2) return;
          setHero((state.heroIndex + 1) % state.heroes.length);
        }, 9000);
      }
    };
  },

  async browse(params = {}) {
    const d = await browseQuery(browseVars(params, 1));
    const title = params.title || (params.q ? `Results for "${params.q}"` : params.genre || params.tag || 'Browse');
    const chips = params.q || params.format || params.tag ? '' : `
      <div class="chips">
        <button class="chip ${!params.genre ? 'on' : ''}" data-nav data-genre="">All</button>
        ${GENRES.map((g) => `<button class="chip ${params.genre === g ? 'on' : ''}" data-nav data-genre="${esc(g)}">${esc(g)}</button>`).join('')}
      </div>
    `;
    const list = remember(d.Page.media);
    return {
      html: `
        <div class="page-title">${esc(title)}</div>
        ${chips}
        ${list.length ? `<div class="grid">${list.map((m) => cardHTML(m)).join('')}</div>` : `<div class="empty"><h3>No matches found</h3></div>`}
        <div class="more-wrap">${d.Page.pageInfo.hasNextPage ? `<button class="btn" data-nav data-action="load-more">Load more</button>` : ''}</div>
      `
    };
  },

  async genres() {
    return {
      html: `
        <div class="page-title">Genres & Themes</div>
        <div class="genre-grid">${CATEGORIES.map(genreTile).join('')}</div>
      `
    };
  },

  async movies() {
    return VIEWS.browse({ format: 'MOVIE', title: 'Movies', tab: 'movies' });
  },

  async mylist(params = {}) {
    const tab = params.status || 'ALL';
    let all;
    if (AL.token && AL.viewer) {
      await alLoadList();
      all = [...AL.entries.values()];
    } else {
      all = Object.values(getList()).map((x) => ({ status: x.status || 'PLANNING', progress: 0, media: x, updatedAt: (x.added || 0) / 1000 }));
    }
    remember(all.map((e) => e.media));

    const count = (s) => all.filter((e) => listTab(e.status) === s).length;
    const tabs = [['ALL', 'All', all.length], ...LIST_STATUSES.map(([s, l]) => [s, l, count(s)])];
    const order = ['ALL', 'CURRENT', 'COMPLETED', 'PAUSED', 'DROPPED', 'PLANNING'];
    tabs.sort((a, b) => order.indexOf(a[0]) - order.indexOf(b[0]));

    const shown = all.filter((e) => tab === 'ALL' || listTab(e.status) === tab).sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
    const head = AL.viewer
      ? `<div class="list-head"><img src="${esc(AL.viewer.avatar || '')}" alt=""><span>Synced with AniList as <b>${esc(AL.viewer.name)}</b></span></div>`
      : `<div class="list-head"><span>Saved locally</span></div>`;
    const sub = (e) => AL.viewer ? `${statusLabel(e.status)} · ${e.progress || 0}/${e.media.episodes || '?'} eps` : statusLabel(e.status);

    return {
      html: `
        <div class="page-title">My List</div>
        ${head}
        <div class="chips list-tabs">
          ${tabs.map(([s, l, n]) => `<button class="chip ${tab === s ? 'on' : ''}" data-nav data-status-tab="${s}">${l} <span class="count">${n}</span></button>`).join('')}
        </div>
        ${shown.length ? `<div class="grid">${shown.map((e) => cardHTML(e.media, { sub: sub(e) })).join('')}</div>` : `<div class="empty"><h3>No anime in this list</h3></div>`}
      `
    };
  },

  async library() {
    const lib = Object.values(getLibrary());
    remember(lib.map((e) => e.media));
    return {
      html: `
        <div class="page-title">My Local Library</div>
        ${lib.length
          ? `<div class="grid">${lib.map((e) => cardHTML(e.media, { sub: `${e.files?.length || 0} episodes linked` })).join('')}</div>`
          : `<div class="empty">
              <h3>No linked local files yet</h3>
              <p>Go to any anime's details page and click <b>"Link episode files"</b> to connect your downloaded episodes from your PC.</p>
            </div>`}
      `
    };
  },

  async schedule(params = {}) {
    const day = Number(params.day || 0);
    const start = new Date();
    start.setHours(0, 0, 0, 0);
    start.setDate(start.getDate() + day);
    const s0 = Math.floor(start.getTime() / 1000), s1 = s0 + 86400;

    const d = await gql(`query($a: Int, $b: Int) {
      Page(page: 1, perPage: 50) {
        airingSchedules(airingAt_greater: $a, airingAt_lesser: $b, sort: TIME) {
          airingAt episode media { ...card isAdult }
        }
      }
    } ${CARD}`, { a: s0, b: s1 });

    const list = (d.Page.airingSchedules || []).filter((x) => x.media && !x.media.isAdult);
    remember(list.map((x) => x.media));

    const days = Array.from({ length: 7 }, (_, i) => {
      const dt = new Date();
      dt.setDate(dt.getDate() + i);
      return `<button class="chip ${i === day ? 'on' : ''}" data-nav data-action="day" data-day="${i}">${dt.toLocaleDateString('en-US', { weekday: 'short' })}</button>`;
    }).join('');

    return {
      html: `
        <div class="page-title">Airing Schedule</div>
        <div class="chips">${days}</div>
        <div class="sched-list">
          ${list.map((x) => `
            <div class="sched" tabindex="0" data-nav data-id="${x.media.id}">
              <div class="sched-time">${clock12(new Date(x.airingAt * 1000))}</div>
              <img loading="lazy" src="${esc(x.media.coverImage?.large || '')}" alt="">
              <div>
                <div class="sched-title">${esc(titleOf(x.media))}</div>
                <div class="sched-sub">Episode ${x.episode}</div>
              </div>
            </div>
          `).join('')}
        </div>
      `
    };
  },

  async settings() {
    const skip = getSkip();
    const hist = Object.values(getHistory()).length;
    const lib = Object.keys(getLibrary()).length;
    const list = AL.viewer ? AL.entries.size : Object.keys(getList()).length;
    const v = AL.viewer;
    const sources = getSources();

    const alBlock = v
      ? `<div class="settings-block">
          <h3>AniList Account</h3>
          <p>Connected as <b>${esc(v.name)}</b></p>
          <button class="btn danger" data-nav data-action="al-logout">Log Out</button>
        </div>`
      : `<div class="settings-block">
          <h3>Sync with AniList</h3>
          <p>Sign in to sync your watch list, history, and status directly with your AniList account.</p>
          <div class="field-row">
            <label class="field">
              AniList Client ID
              <input id="al-client" type="text" data-nav placeholder="e.g. 12345" value="${esc(store.get('al_client', ''))}">
            </label>
            <button class="btn primary" data-nav data-action="al-login">Connect</button>
          </div>
          <details class="al-help">
            <summary>How to get an AniList Client ID?</summary>
            <p>1. Go to anilist.co &gt; Settings &gt; Developer.</p>
            <p>2. Create a new client with Redirect URL: <code>https://anilist.co/api/v2/oauth/pin</code>.</p>
            <p>3. Copy the numeric Client ID and paste it here.</p>
          </details>
        </div>`;

    return {
      html: `
        <div class="page-title">Settings</div>

        <div class="settings-block">
          <h3>Profile & Preferences</h3>
          <div class="profile-row">
            <div class="avatar big">${initial(getProfile().name)}</div>
            <label class="field">
              Display Name
              <input id="prof-name" type="text" data-nav value="${esc(getProfile().name)}" placeholder="Enter your name">
            </label>
          </div>
          <div class="field-row">
            <label class="field">
              Skip forward / back interval
              <select id="skip-val" data-nav style="background:var(--bg);color:var(--text);border:1px solid var(--line);border-radius:8px;height:40px;padding:0 12px;">
                ${[5, 10, 15, 20].map((s) => `<option value="${s}" ${s === skip ? 'selected' : ''}>${s} seconds</option>`).join('')}
              </select>
            </label>
          </div>
        </div>

        ${alBlock}

        <div class="settings-block">
          <h3>Data & Storage</h3>
          <div class="stats">
            <div><b>${hist}</b> Episodes in history</div>
            <div><b>${list}</b> Anime in your list</div>
            <div><b>${lib}</b> Anime with linked local files</div>
          </div>
        </div>

        <div class="settings-block">
          <h3>Where to Watch Sources</h3>
          <p>Configure quick-access streaming providers that show up on each anime's details page. Use <code>{title}</code> in the URL template.</p>
          <div class="src-list">
            ${sources.map((s, idx) => `
              <div class="src-row">
                <b>${esc(s.name)}</b>
                <span>${esc(s.url)}</span>
                <button class="btn small danger" data-nav data-action="remove-source" data-idx="${idx}">Remove</button>
              </div>
            `).join('')}
          </div>
          <div class="field-row">
            <label class="field">Source Name <input id="new-src-name" type="text" placeholder="e.g. HiAnime"></label>
            <label class="field">URL Template <input id="new-src-url" class="wide-input" type="text" placeholder="https://example.com/search?q={title}"></label>
            <button class="btn primary" data-nav data-action="add-source">Add Source</button>
          </div>
        </div>

        <div class="settings-block">
          <h3>Keyboard Shortcuts</h3>
          <div class="keys">
            <div><kbd>Arrow Keys</kbd></div><div>Navigate focus</div>
            <div><kbd>Enter</kbd></div><div>Select / Open</div>
            <div><kbd>Esc</kbd> / <kbd>Backspace</kbd></div><div>Back / Close player</div>
            <div><kbd>/</kbd></div><div>Focus search</div>
            <div><kbd>Space</kbd> or <kbd>K</kbd></div><div>Play / Pause video</div>
            <div><kbd>←</kbd> / <kbd>→</kbd></div><div>Skip back / forward</div>
            <div><kbd>↑</kbd> / <kbd>↓</kbd></div><div>Adjust volume</div>
            <div><kbd>F</kbd></div><div>Toggle Fullscreen</div>
            <div><kbd>M</kbd></div><div>Mute / Unmute</div>
            <div><kbd>C</kbd></div><div>Toggle subtitles / Load file</div>
            <div><kbd>N</kbd> / <kbd>P</kbd></div><div>Next / Previous episode</div>
            <div><kbd>E</kbd></div><div>Toggle episode list in player</div>
            <div><kbd>0</kbd>–<kbd>9</kbd></div><div>Jump to 0%–90% progress</div>
          </div>
        </div>
      `,
      after() {
        $('#prof-name')?.addEventListener('change', (e) => {
          store.set('profile', { name: e.target.value.trim() });
          updateAvatar();
          toast('Profile updated');
        });
        $('#skip-val')?.addEventListener('change', (e) => {
          store.set('skip', Number(e.target.value));
          toast('Skip interval saved');
        });
      }
    };
  },

  async detail({ id }) {
    const d = await gql(`query($id: Int) {
      Media(id: $id) {
        ...card
        title { native }
        synonyms
        description(asHtml: false)
        duration
        source
        season
        externalLinks { site url type color }
        streamingEpisodes { title thumbnail url site }
      }
    } ${CARD}`, { id });

    const m = d.Media;
    remember([m]);
    state.detail = m;
    const desc = cleanDesc(m.description);
    const local = getLibrary()[m.id];
    const linkedCount = local?.files?.length || 0;
    const hist = getHistory()[m.id];
    const resumeEp = hist?.ep || 1;

    const sources = getSources();
    const externalButtons = sources.map((src) => `
      <button class="btn" data-nav data-action="open-url" data-url="${esc(sourceURL(src, m))}">
        ${esc(src.name)} ↗
      </button>
    `).join('');

    const officialLinks = (m.externalLinks || [])
      .filter((l) => l.url && /streaming/i.test(l.type || '') && !/crunchyroll/i.test(l.site || '') && !/crunchyroll\.com/i.test(l.url || ''))
      .map((l) => `
      <button class="btn" data-nav data-action="open-url" data-url="${esc(l.url)}" style="--accent:${esc(l.color || 'var(--accent)')}">
        ${esc(l.site)} ↗
      </button>
    `).join('');

    return {
      html: `
        <div class="detail">
          <div class="d-banner">
            ${m.bannerImage ? `<img src="${esc(m.bannerImage)}" alt="">` : ''}
          </div>
          <div class="d-main">
            <div class="d-cover">
              <img src="${esc(m.coverImage?.extraLarge || m.coverImage?.large || '')}" alt="">
            </div>
            <div class="d-info">
              <h1>${esc(titleOf(m))}</h1>
              ${m.title?.native ? `<div class="d-native">${esc(m.title.native)}</div>` : ''}
              <div class="d-facts">
                ${m.averageScore ? `<span class="fact score">★ ${(m.averageScore / 10).toFixed(1)}</span>` : ''}
                ${m.format ? `<span class="fact">${FORMAT[m.format] || m.format}</span>` : ''}
                ${m.status ? `<span class="fact">${STATUS[m.status] || m.status}</span>` : ''}
                ${m.episodes ? `<span class="fact">${m.episodes} Episodes</span>` : ''}
                ${m.seasonYear ? `<span class="fact">${m.seasonYear}</span>` : ''}
              </div>
              <p class="d-desc">${esc(desc)}</p>
              <div class="btn-row">
                <button class="btn primary" data-nav data-action="play-ep" data-id="${m.id}" data-ep="${resumeEp}">
                  ▶ ${hist ? `Resume Ep ${resumeEp}` : 'Play Ep 1'}
                </button>
                <button class="btn" data-nav data-action="link-files" data-id="${m.id}">
                  📁 ${linkedCount ? `Re-link Files (${linkedCount})` : 'Link Episode Files'}
                </button>
                <button class="btn" data-nav data-action="stream-url" data-id="${m.id}">
                  🌐 Play Stream URL
                </button>
                <button class="btn" data-nav data-action="list-menu" data-id="${m.id}">
                  ${listBtnLabel(m.id)}
                </button>
              </div>
            </div>
          </div>

          ${(externalButtons || officialLinks) ? `
            <div class="d-section" style="margin-top: 24px;">
              <h2>Where to Watch</h2>
              <div class="btn-row">
                ${officialLinks}
                ${externalButtons}
              </div>
            </div>
          ` : ''}

          <div class="d-section" style="margin-top: 32px;">
            <h2>Episodes</h2>
            <div class="d-sub">${linkedCount ? `${linkedCount} local video(s) linked on disk` : 'No local files linked yet. Click "Link Episode Files" or click an episode to play/stream.'}</div>
            <div id="ep-area">${episodesHTML(m)}</div>
          </div>
        </div>
      `
    };
  }
};

function browseVars(p, page) {
  return {
    page,
    q: p.q || undefined,
    g: p.genre || undefined,
    t: p.tag || undefined,
    f: p.format || undefined,
    sort: p.q ? ['SEARCH_MATCH'] : ['POPULARITY_DESC']
  };
}

async function browseQuery(vars) {
  return gql(`query($page: Int, $q: String, $g: String, $t: String, $f: MediaFormat, $sort: [MediaSort]) {
    Page(page: $page, perPage: 42) {
      pageInfo { hasNextPage }
      media(search: $q, genre: $g, tag: $t, format: $f, sort: $sort, type: ANIME, isAdult: false) {
        ...card
      }
    }
  } ${CARD}`, vars);
}

function heroHTML(m) {
  if (!m) return '';
  const score = m.averageScore ? `★ ${(m.averageScore / 10).toFixed(1)}` : '';
  return `
    <img class="hero-bg" src="${esc(m.bannerImage || m.coverImage?.extraLarge || '')}" alt="">
    <div class="hero-body">
      <div class="meta">${[FORMAT[m.format], m.seasonYear, score].filter(Boolean).join(' · ')}</div>
      <h1>${esc(titleOf(m))}</h1>
      <p>${esc(cleanDesc(m.description))}</p>
      <div class="btn-row">
        <button class="btn primary" data-nav data-go="detail" data-id="${m.id}">Inspect Details</button>
        <button class="btn" data-nav data-action="list-menu" data-id="${m.id}">${listBtnLabel(m.id)}</button>
      </div>
    </div>
  `;
}

function setHero(i) {
  state.heroIndex = i;
  const h = $('#hero');
  if (h) h.innerHTML = heroHTML(state.heroes[i]);
}

function episodeCount(m) {
  return m.episodes || 12;
}

function episodesHTML(m) {
  const total = episodeCount(m);
  const localFiles = getLibrary()[m.id]?.files || [];
  const fileMap = new Map();
  localFiles.forEach((f) => fileMap.set(f.ep, f));
  const hist = getHistory()[m.id];
  let tiles = '';
  const cover = m.bannerImage || m.coverImage?.extraLarge || m.coverImage?.large || '';

  for (let n = 1; n <= total; n++) {
    const local = fileMap.get(n);
    const isLocal = !!local;
    const badge = isLocal ? 'ON DISK' : `EP ${n}`;
    const subText = isLocal ? esc(local.name) : 'Play / Stream';
    const hasProgress = hist && hist.ep === n && hist.dur > 0;
    const pct = hasProgress ? Math.min(100, (hist.time / hist.dur) * 100) : 0;

    tiles += `
      <div class="ep ${isLocal ? 'local' : ''}" tabindex="0" data-nav data-action="play-ep" data-id="${m.id}" data-ep="${n}">
        <div class="ep-thumb">
          <img loading="lazy" src="${esc(cover)}" alt="">
          <span class="ep-badge">${badge}</span>
          ${pct > 0 ? `<div class="prog"><i style="width:${pct}%"></i></div>` : ''}
        </div>
        <div class="ep-title">Episode ${n}</div>
        <div class="ep-sub">${subText}</div>
      </div>
    `;
  }
  return `<div class="ep-grid">${tiles}</div>`;
}

/* =========================================================
   Built-in Video Player Engine
   ========================================================= */
const P = {
  open: false,
  id: 0,
  media: null,
  ep: 1,
  file: null,
  srcUrl: ''
};

const player = $('#player');
const video = $('#video');

function flash(msg, side = '') {
  const f = $('#p-flash');
  if (!f) return;
  f.textContent = msg;
  f.className = 'p-flash show ' + side;
  clearTimeout(flash._timer);
  flash._timer = setTimeout(() => { f.className = 'p-flash'; }, 650);
}

let idleTimer;
function wake() {
  player.classList.remove('idle');
  clearTimeout(idleTimer);
  if (!video.paused) {
    idleTimer = setTimeout(() => {
      if (!video.paused) player.classList.add('idle');
    }, 3200);
  }
}

function srtToVtt(srt) {
  let vtt = 'WEBVTT\n\n' + srt.trim().replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  vtt = vtt.replace(/(\d{2}:\d{2}:\d{2}),(\d{3})/g, '$1.$2');
  return vtt;
}

function clearSubtitles() {
  [...video.querySelectorAll('track')].forEach((t) => t.remove());
  $('#p-subs-pill').hidden = true;
  $('#b-cc').classList.remove('on');
}

function applySubtitleText(text) {
  clearSubtitles();
  if (!text) return;
  const vttText = text.startsWith('WEBVTT') ? text : srtToVtt(text);
  const blob = new Blob([vttText], { type: 'text/vtt' });
  const track = document.createElement('track');
  track.kind = 'subtitles';
  track.label = 'Subtitles';
  track.srclang = 'en';
  track.src = URL.createObjectURL(blob);
  track.default = true;
  video.appendChild(track);
  track.track.mode = 'showing';
  $('#p-subs-pill').hidden = false;
  $('#b-cc').classList.add('on');
  flash('Subtitles Enabled');
}

async function playEpisode(m, ep = 1, file = null, customUrl = null) {
  const localList = getLibrary()[m.id]?.files || [];
  if (!file && !customUrl) {
    file = localList.find((f) => f.ep === ep) || null;
  }

  // If there is no local file and no custom URL, prompt the user with choices
  if (!file && !customUrl) {
    showPlayPromptModal(m, ep);
    return;
  }

  P.open = true;
  P.id = m.id;
  P.media = m;
  P.ep = ep;
  P.file = file;
  P.srcUrl = customUrl || file?.url || '';

  $('#p-name').textContent = titleOf(m);
  $('#p-sub').textContent = file ? `Episode ${ep} · ${file.name}` : `Episode ${ep} · Stream`;
  $('#p-msg').hidden = true;
  clearSubtitles();

  player.hidden = false;
  video.src = P.srcUrl;

  // Restore saved playback position
  const hist = getHistory()[m.id];
  if (hist && hist.ep === ep && hist.time > 5 && hist.dur && hist.time < (hist.dur - 15)) {
    video.currentTime = hist.time;
  }

  video.play().catch((err) => {
    console.warn('Playback play request:', err);
  });

  // Check for sidecar subtitle file
  if (file?.sub && bridge?.readSubtitle) {
    try {
      const subData = await bridge.readSubtitle(file.sub);
      if (subData?.text) {
        applySubtitleText(subData.text);
      }
    } catch (err) {
      console.warn('Subtitle read error:', err);
    }
  }

  buildEpisodeList();
  highlightEpisode();
  syncVolume();
  wake();
  player.focus();
}

function showPlayPromptModal(m, ep) {
  modal.innerHTML = `
    <div class="modal-card" role="dialog" aria-modal="true">
      <h3>Play Episode ${ep}</h3>
      <div class="modal-sub">${esc(titleOf(m))}</div>
      <p style="color:var(--muted);font-size:14px;line-height:1.5;margin-bottom:18px;">
        No local file is linked for Episode ${ep} yet. What would you like to do?
      </p>
      <div class="modal-opts">
        <button class="modal-opt" data-nav data-action="link-and-play" data-ep="${ep}">
          <span class="mi">📁</span> Select Local Video File
        </button>
        <button class="modal-opt" data-nav data-action="enter-stream-url" data-ep="${ep}">
          <span class="mi">🌐</span> Enter Direct Stream URL
        </button>
        <button class="modal-opt" data-nav data-action="open-web-watch">
          <span class="mi">↗</span> Open Official Watch Sites
        </button>
      </div>
      <div class="modal-foot">
        <button class="btn" data-nav data-close>Cancel</button>
      </div>
    </div>
  `;
  modal.hidden = false;
  $('.modal-opt', modal)?.focus();
}

function closePlayer() {
  if (!P.open) return;
  saveProgress();
  P.open = false;
  video.pause();
  video.removeAttribute('src');
  video.load();
  player.hidden = true;
  clearSubtitles();
  render({ keepScroll: true });
}

function saveProgress() {
  if (!P.id || !video.duration) return;
  const h = getHistory();
  h[P.id] = {
    media: snap(P.media),
    ep: P.ep,
    time: Math.floor(video.currentTime || 0),
    dur: Math.floor(video.duration || 0),
    at: Date.now()
  };
  store.set('history', h);
}

function buildEpisodeList() {
  const epsEl = $('#p-eps');
  if (!epsEl || !P.media) return;
  const total = episodeCount(P.media);
  const localFiles = getLibrary()[P.id]?.files || [];
  const fileMap = new Map();
  localFiles.forEach((f) => fileMap.set(f.ep, f));
  const cover = P.media.bannerImage || P.media.coverImage?.extraLarge || P.media.coverImage?.large || '';

  let html = '';
  for (let n = 1; n <= total; n++) {
    const f = fileMap.get(n);
    const isCur = n === P.ep;
    html += `
      <div class="p-ep ${isCur ? 'current' : ''} ${!f && !P.srcUrl ? 'missing' : ''}" data-nav data-ep="${n}">
        <img loading="lazy" src="${esc(cover)}" alt="">
        <div>
          <b>Episode ${n}</b>
          <small>${f ? esc(f.name) : (isCur ? 'Currently playing' : 'Not linked')}</small>
        </div>
      </div>
    `;
  }
  epsEl.innerHTML = html;
}

function highlightEpisode() {
  $$('.p-ep', $('#p-eps')).forEach((el) => {
    el.classList.toggle('current', Number(el.dataset.ep) === P.ep);
  });
}

function syncVolume() {
  const vol = Number(store.get('volume', 1));
  video.volume = Math.max(0, Math.min(1, vol));
  const vSlider = $('#vol');
  if (vSlider) vSlider.value = video.volume;
}

/* =========================================================
   Player Controls & Video Events
   ========================================================= */
$('#p-close').onclick = closePlayer;

$('#b-play').onclick = () => {
  if (video.paused) {
    video.play();
    flash('Play');
  } else {
    video.pause();
    flash('Pause');
  }
};

$('#b-back').onclick = () => {
  const skip = getSkip();
  video.currentTime = Math.max(0, video.currentTime - skip);
  flash(`-${skip}s`, 'left');
};

$('#b-fwd').onclick = () => {
  const skip = getSkip();
  video.currentTime = Math.min(video.duration || 0, video.currentTime + skip);
  flash(`+${skip}s`, 'right');
};

$('#b-prev').onclick = () => {
  if (P.ep > 1) playEpisode(P.media, P.ep - 1);
};

$('#b-next').onclick = () => {
  const total = episodeCount(P.media);
  if (P.ep < total) playEpisode(P.media, P.ep + 1);
};

$('#b-mute').onclick = () => {
  video.muted = !video.muted;
  player.classList.toggle('muted', video.muted);
  flash(video.muted ? 'Muted' : 'Unmuted');
};

$('#vol').oninput = (e) => {
  const v = Number(e.target.value);
  video.volume = v;
  video.muted = false;
  player.classList.remove('muted');
  store.set('volume', v);
  flash(`Vol ${Math.round(v * 100)}%`);
};

$('#b-cc').onclick = async () => {
  const tracks = video.textTracks;
  if (tracks.length > 0) {
    const isShowing = tracks[0].mode === 'showing';
    tracks[0].mode = isShowing ? 'hidden' : 'showing';
    $('#b-cc').classList.toggle('on', !isShowing);
    $('#p-subs-pill').hidden = isShowing;
    flash(isShowing ? 'Subtitles Off' : 'Subtitles On');
  } else if (bridge?.pickSubtitle) {
    const picked = await bridge.pickSubtitle();
    if (picked?.text) applySubtitleText(picked.text);
  } else {
    toast('No subtitles loaded.');
  }
};

$('#b-list').onclick = () => {
  player.classList.toggle('list-hidden');
};

$('#b-full').onclick = () => {
  if (document.fullscreenElement) {
    document.exitFullscreen();
  } else {
    player.requestFullscreen();
  }
};

video.addEventListener('play', () => {
  player.classList.add('playing');
  wake();
});

video.addEventListener('pause', () => {
  player.classList.remove('playing');
  wake();
  saveProgress();
});

video.addEventListener('ended', () => {
  const total = episodeCount(P.media);
  if (P.ep < total) {
    toast(`Playing next: Episode ${P.ep + 1}`);
    playEpisode(P.media, P.ep + 1);
  }
});

video.addEventListener('timeupdate', () => {
  const d = video.duration || 0, t = video.currentTime || 0;
  const pct = d ? (t / d) * 100 : 0;
  const fill = $('#pbar-fill'), knob = $('#pbar-knob'), timeLabel = $('#p-time');
  if (fill) fill.style.width = pct + '%';
  if (knob) knob.style.left = pct + '%';
  if (timeLabel) timeLabel.textContent = `${fmtTime(t)} / ${fmtTime(d)}`;

  if (Math.floor(t) % 5 === 0) saveProgress();
});

video.addEventListener('error', () => {
  const msg = $('#p-msg');
  if (msg) {
    msg.hidden = false;
    msg.innerHTML = `
      <h3>Playback Failed</h3>
      <p>Could not play video source. If this file uses HEVC (H.265) or AC3 audio, standard Chromium video player may not support it directly. Consider MP4 (H.264/AAC).</p>
      <button class="btn" style="margin-top:14px" onclick="document.getElementById('p-close').click()">Close Player</button>
    `;
  }
});

// Seek bar interaction
const pbar = $('#pbar');
if (pbar) {
  pbar.addEventListener('click', (e) => {
    const rect = pbar.getBoundingClientRect();
    const pos = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    if (video.duration) video.currentTime = pos * video.duration;
  });
  pbar.addEventListener('mousemove', (e) => {
    const rect = pbar.getBoundingClientRect();
    const pos = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    const tip = $('#pbar-tip'), ptime = $('#pbar-time');
    if (tip && video.duration) {
      tip.style.left = `${pos * 100}%`;
      if (ptime) ptime.textContent = fmtTime(pos * video.duration);
    }
  });
}

player.addEventListener('mousemove', wake);
$('#p-eps')?.addEventListener('click', (e) => {
  const epEl = e.target.closest('.p-ep');
  if (!epEl) return;
  const ep = Number(epEl.dataset.ep);
  if (ep) playEpisode(P.media, ep);
});

/* =========================================================
   Global Delegation & Navigation Actions
   ========================================================= */
document.addEventListener('click', async (e) => {
  const t = e.target.closest('[data-go],[data-action],[data-ep],[data-id],[data-genre],[data-tag],[data-status-tab]');
  if (!t) return;

  // View navigation
  if (t.dataset.go) {
    return go(t.dataset.go);
  }

  // Genre / Tag filtering
  if (t.hasAttribute('data-genre')) {
    const g = t.getAttribute('data-genre');
    return go('browse', { genre: g || undefined });
  }
  if (t.hasAttribute('data-tag')) {
    const tg = t.getAttribute('data-tag');
    return go('browse', { tag: tg || undefined });
  }

  // List status tab filter
  if (t.dataset.statusTab) {
    return go('mylist', { status: t.dataset.statusTab });
  }

  // Actions
  const action = t.dataset.action;
  const id = Number(t.dataset.id || t.getAttribute('data-id'));

  if (action === 'list-menu') {
    e.stopPropagation();
    const m = mediaById.get(id) || state.detail;
    if (m) openListMenu(m, t);
    return;
  }

  if (action === 'link-files') {
    e.stopPropagation();
    const m = mediaById.get(id) || state.detail;
    if (m) await linkFiles(m);
    return;
  }

  if (action === 'play-ep' || action === 'play') {
    e.stopPropagation();
    const m = mediaById.get(id) || state.detail;
    const ep = Number(t.dataset.ep || 1);
    if (m) playEpisode(m, ep);
    return;
  }

  if (action === 'resume') {
    e.stopPropagation();
    const m = mediaById.get(id);
    const ep = Number(t.dataset.ep || 1);
    if (m) playEpisode(m, ep);
    return;
  }

  if (action === 'stream-url') {
    e.stopPropagation();
    const m = mediaById.get(id) || state.detail;
    const url = prompt('Enter direct video stream URL (MP4, WebM, HLS):');
    if (url && m) playEpisode(m, 1, null, url.trim());
    return;
  }

  if (action === 'open-url') {
    e.stopPropagation();
    const url = t.dataset.url;
    if (url) openExternal(url);
    return;
  }

  if (action === 'day') {
    return go('schedule', { day: Number(t.dataset.day || 0) });
  }

  if (action === 'al-login') {
    return alLogin();
  }

  if (action === 'al-logout') {
    return alLogout();
  }

  if (action === 'load-more') {
    const curParams = state.stack[state.stack.length - 1].params || {};
    // Load next page logic could append to grid
    toast('End of catalog results');
    return;
  }

  if (action === 'add-source') {
    const name = $('#new-src-name')?.value.trim();
    const url = $('#new-src-url')?.value.trim();
    if (!name || !url) {
      toast('Please enter both name and URL template.');
      return;
    }
    const sources = getSources();
    sources.push({ name, url });
    store.set('sources', sources);
    toast(`Added source "${name}"`);
    render({ keepScroll: true });
    return;
  }

  if (action === 'remove-source') {
    const idx = Number(t.dataset.idx);
    const sources = getSources();
    sources.splice(idx, 1);
    store.set('sources', sources);
    toast('Source removed');
    render({ keepScroll: true });
    return;
  }

  // Modal choice actions
  if (action === 'link-and-play') {
    const ep = Number(t.dataset.ep || 1);
    closeModal();
    const m = state.detail;
    if (m && bridge?.pickVideos) {
      const picked = await bridge.pickVideos();
      if (picked && picked.length) {
        const files = picked.map((f) => ({ ...f, ep: guessEp(f.name) }));
        const lib = getLibrary();
        lib[m.id] = { media: snap(m), files };
        store.set('library', lib);
        const epFile = files.find((f) => f.ep === ep) || files[0];
        playEpisode(m, epFile.ep, epFile);
      }
    }
    return;
  }

  if (action === 'enter-stream-url') {
    const ep = Number(t.dataset.ep || 1);
    closeModal();
    const url = prompt(`Enter stream URL for Episode ${ep}:`);
    if (url && state.detail) {
      playEpisode(state.detail, ep, null, url.trim());
    }
    return;
  }

  if (action === 'open-web-watch') {
    closeModal();
    if (state.detail) {
      const src = getSources()[0];
      if (src) openExternal(sourceURL(src, state.detail));
    }
    return;
  }

  // Default card click -> go to details page
  if (id && !action) {
    go('detail', { id });
  }
});

/* =========================================================
   Keyboard Navigation Shell (Spec Compliant)
   ========================================================= */
window.addEventListener('keydown', (e) => {
  document.body.classList.add('kbd');

  // If currently typing in an input, don't trigger global shortcuts
  if (['INPUT', 'SELECT', 'TEXTAREA'].includes(document.activeElement?.tagName)) {
    if (e.key === 'Escape') document.activeElement.blur();
    return;
  }

  // Global / key focuses search
  if (e.key === '/' && !P.open && modal.hidden) {
    e.preventDefault();
    $('#search')?.focus();
    return;
  }

  // Player Controls when Player is open
  if (P.open) {
    wake();
    const skip = getSkip();

    if (e.key === ' ' || e.key.toLowerCase() === 'k') {
      e.preventDefault();
      $('#b-play')?.click();
      return;
    }
    if (e.key === 'ArrowLeft' || e.key.toLowerCase() === 'j') {
      e.preventDefault();
      video.currentTime = Math.max(0, video.currentTime - skip);
      flash(`-${skip}s`, 'left');
      return;
    }
    if (e.key === 'ArrowRight' || e.key.toLowerCase() === 'l') {
      e.preventDefault();
      video.currentTime = Math.min(video.duration || 0, video.currentTime + skip);
      flash(`+${skip}s`, 'right');
      return;
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault();
      video.volume = Math.min(1, video.volume + 0.05);
      syncVolume();
      flash(`Vol ${Math.round(video.volume * 100)}%`);
      return;
    }
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      video.volume = Math.max(0, video.volume - 0.05);
      syncVolume();
      flash(`Vol ${Math.round(video.volume * 100)}%`);
      return;
    }
    if (e.key.toLowerCase() === 'f') {
      e.preventDefault();
      $('#b-full')?.click();
      return;
    }
    if (e.key.toLowerCase() === 'm') {
      e.preventDefault();
      $('#b-mute')?.click();
      return;
    }
    if (e.key.toLowerCase() === 'c') {
      e.preventDefault();
      $('#b-cc')?.click();
      return;
    }
    if (e.key.toLowerCase() === 'e') {
      e.preventDefault();
      $('#b-list')?.click();
      return;
    }
    if (e.key.toLowerCase() === 'n') {
      e.preventDefault();
      $('#b-next')?.click();
      return;
    }
    if (e.key.toLowerCase() === 'p') {
      e.preventDefault();
      $('#b-prev')?.click();
      return;
    }
    if (/^[0-9]$/.test(e.key)) {
      e.preventDefault();
      if (video.duration) {
        const pct = Number(e.key) / 10;
        video.currentTime = pct * video.duration;
        flash(`${Math.round(pct * 100)}%`);
      }
      return;
    }
    if (e.key === 'Escape' || e.key === 'Backspace') {
      e.preventDefault();
      closePlayer();
      return;
    }
  }

  // Modal open
  if (!modal.hidden) {
    if (e.key === 'Escape' || e.key === 'Backspace') {
      e.preventDefault();
      closeModal();
      return;
    }
  }

  // App navigation back
  if (e.key === 'Backspace' || e.key === 'Escape') {
    if (state.stack.length > 1) {
      e.preventDefault();
      back();
    }
    return;
  }

  // Directional navigation between [data-nav] elements
  if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.key)) {
    e.preventDefault();
    navigateSpatial(e.key);
  }
});

function navigateSpatial(dir) {
  const items = $$('[data-nav]:not([hidden]):not([disabled])', document.body).filter((el) => {
    const rect = el.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  });
  if (!items.length) return;

  const cur = document.activeElement;
  if (!cur || !items.includes(cur)) {
    items[0].focus();
    return;
  }

  const cRect = cur.getBoundingClientRect();
  const cX = cRect.left + cRect.width / 2;
  const cY = cRect.top + cRect.height / 2;

  let best = null, bestDist = Infinity;

  for (const it of items) {
    if (it === cur) continue;
    const r = it.getBoundingClientRect();
    const x = r.left + r.width / 2;
    const y = r.top + r.height / 2;

    const dx = x - cX;
    const dy = y - cY;

    if (dir === 'ArrowUp' && dy >= -5) continue;
    if (dir === 'ArrowDown' && dy <= 5) continue;
    if (dir === 'ArrowLeft' && dx >= -5) continue;
    if (dir === 'ArrowRight' && dx <= 5) continue;

    // Favor collinear alignment in the direction of movement
    const dist = (dir === 'ArrowUp' || dir === 'ArrowDown')
      ? Math.abs(dy) + Math.abs(dx) * 2.5
      : Math.abs(dx) + Math.abs(dy) * 2.5;

    if (dist < bestDist) {
      bestDist = dist;
      best = it;
    }
  }

  if (best) {
    best.focus({ preventScroll: false });
    best.scrollIntoView?.({ block: 'nearest', inline: 'nearest', behavior: 'smooth' });
  }
}

/* =========================================================
   Search Bar Handling
   ========================================================= */
const searchInput = $('#search');
let searchDebounce;
if (searchInput) {
  searchInput.addEventListener('input', (e) => {
    clearTimeout(searchDebounce);
    const q = e.target.value.trim();
    searchDebounce = setTimeout(() => {
      if (q.length > 1) {
        go('browse', { q, title: `Search: "${q}"` });
      }
    }, 400);
  });
  searchInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      clearTimeout(searchDebounce);
      const q = searchInput.value.trim();
      if (q) go('browse', { q, title: `Search: "${q}"` });
    }
  });
}

/* =========================================================
   Application Initialization
   ========================================================= */
function tick() {
  const t = clock12(new Date());
  const clk = $('#clock'), pclk = $('#p-clock');
  if (clk) clk.textContent = t;
  if (pclk) pclk.textContent = t;
}
tick();
setInterval(tick, 10000);

updateAvatar();

Promise.race([alInit(), sleep(2500)]).finally(() => {
  render();
});