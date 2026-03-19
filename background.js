console.log('[FlipRadar][sw] build_id=2026-02-28T10:08Z');
console.log('[FlipRadar][sw] boot');

// Prevent overlapping ticks (popup spam + alarm)
let __tickRunning = false;


// ─────────────────────────────────────────────────────────
// FlipRadar v0.1 — Service Worker (Manifest MV3)
// Production-safe, autonomous tab-based ingestion engine
// ─────────────────────────────────────────────────────────

function safeStringify(x) {
  try { return JSON.stringify(x); } catch (e) { return String(x); }
}


// Retry wrapper for MV3 tab-race conditions (tab may be closed/discarded between steps)
async function withTabRetry(fn, recreateFn) {
  try {
    return await fn();
  } catch (e) {
    const msg = (e && e.message) ? e.message : String(e);
    if (msg && msg.includes('No tab with id')) {
      // Recreate once and retry
      if (typeof recreateFn === 'function') {
        await recreateFn();
        return await fn();
      }
    }
    throw e;
  }
}

// ── Brand & condition configuration ─────────────────────
var BRANDS = [
  'iphone','ipad','macbook','playstation','ps5','ps4','xbox',
  'nintendo switch','samsung galaxy','airpods','sony','herman miller',
  'steelcase','west elm','cb2','restoration hardware','pottery barn','ikea'
];
var CONDITION_WORDS = ['mint','sealed','like new','brand new','bnib','unused','nib'];

// Electronics signals & negatives (for refined scoring)
var ELECTRONICS_SIGNALS = ['m1','m2','m3','16gb','512gb','1tb','ssd','nvidia','amd','intel'];
var NEGATIVE_SIGNALS = ['broken','for parts','cracked','read description','non-working'];

// ── Helpers ─────────────────────────────────────────────
function hashCode(s) {
  var h = 0;
  for (var i = 0; i < s.length; i++) {
    h = ((h << 5) - h) + s.charCodeAt(i);
    h |= 0;
  }
  return Math.abs(h);
}


/**
 * Keyword matching helpers (STRICT AND match on tokens)
 * - Lowercase
 * - Remove punctuation
 * - Collapse to single spaces
 * - Require every keyword token to appear as a whole token in the title
 */
function normalizeText(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}


function extractIdFromUrl(url) {
  try {
    var m = (url || '').match(/\/marketplace\/item\/(\d+)/);
    if (m) return m[1];
  } catch (e) {}
  return null;
}

function getStableKeys(item) {
  var keys = [];
  if (!item) return keys;
  if (item.id != null) keys.push(String(item.id));
  var url = item.url || item.href || '';
  var uid = extractIdFromUrl(url);
  if (uid) keys.push(String(uid));
  if (url) keys.push(String(url));
  // de-dupe
  return Array.from(new Set(keys));
}

function getPrevPrice(priceMap, keys) {
  for (var i = 0; i < keys.length; i++) {
    var k = keys[i];
    if (priceMap[k] != null) return priceMap[k];
  }
  return null;
}

function setPriceForKeys(priceMap, keys, price) {
  for (var i = 0; i < keys.length; i++) {
    priceMap[keys[i]] = price;
  }
}

function parsePrice(v) {
  if (v === null || v === undefined) return null;
  if (typeof v === 'number') return isFinite(v) ? v : null;
  const s = String(v).trim();
  if (!s) return null;
  const lower = s.toLowerCase();
  if (lower.includes('free')) return 0;
  // Strip currency symbols and other text, keep digits, dots, commas
  const cleaned = lower.replace(/,/g, '').replace(/[^0-9.]+/g, ' ');
  const match = cleaned.match(/\d+(?:\.\d+)?/);
  if (!match) return null;
  const n = parseFloat(match[0]);
  return isFinite(n) ? n : null;
}

/// ---------------- Telegram helper ----------------
function _getByPath(obj, path) {
  try {
    return path.split('.').reduce((acc, k) => (acc && acc[k] !== undefined ? acc[k] : undefined), obj);
  } catch {
    return undefined;
  }
}

function _pickFirst(obj, paths) {
  for (const p of paths) {
    const v = _getByPath(obj, p);
    if (v !== undefined && v !== null) return v;
  }
  return undefined;
}

function _cleanToken(raw) {
  let t = (raw || '').toString().trim();
  if (!t) return '';
  // Allow users to paste full URLs like:
  // https://api.telegram.org/bot<token>/sendMessage
  t = t.replace(/^https?:\/\/api\.telegram\.org\/bot/i, '');
  // Strip any path after token
  t = t.replace(/\/.*$/, '');
  // Some people accidentally paste with "bot" prefix in the token field (BotFather gives token without it)
  t = t.replace(/^bot/i, '').trim();
  return t;
}

async function sendTelegramAlert(payload) {
  try {
    // Options pages sometimes save to sync, popups sometimes save to local, and some code stores nested under "settings".
    const KEYS = [
      'telegramBotToken', 'telegramChatId', 'telegramEnabled',
      'token', 'chatId',
      'settings', 'telegram'
    ];

    const [localCfg, syncCfg] = await Promise.all([
      chrome.storage.local.get(null),
      chrome.storage.sync.get(null)
    ]);

    // Merge (local wins over sync for same top-level keys)
    const merged = { ...(syncCfg || {}), ...(localCfg || {}) };

    // Candidate locations (flat + nested)
    const tokenCandidate = _pickFirst(merged, [
      'telegramBotToken',
      'token',
      'telegram.botToken',
      'telegram.token',
      'settings.telegramBotToken',
      'settings.telegram.botToken',
      'settings.telegram.token',
      'settings.token',
      'options.telegramBotToken',
      'options.telegram.token'
    ]);

    const chatCandidate = _pickFirst(merged, [
      'telegramChatId',
      'chatId',
      'telegram.chatId',
      'settings.telegramChatId',
      'settings.telegram.chatId',
      'settings.chatId',
      'options.telegramChatId',
      'options.telegram.chatId'
    ]);

    const enabledCandidate = _pickFirst(merged, [
      'telegramEnabled',
      'telegram.enabled',
      'settings.telegramEnabled',
      'settings.telegram.enabled'
    ]);

    // Determine enabled: if explicitly false, respect it. Otherwise default ON if we have token+chatId.
    const tokenRaw = _cleanToken(tokenCandidate);
    const chatIdRaw = (chatCandidate || '').toString().trim();
    const enabled =
      (enabledCandidate === false)
        ? false
        : true;

    // Helpful debug: show where we found values (without logging the full token)
    const dbg = {
      hasLocal: !!localCfg,
      hasSync: !!syncCfg,
      tokenFound: !!tokenRaw,
      chatFound: !!chatIdRaw,
      enabledCandidate: enabledCandidate
    };
    console.log('[FlipRadar][sw] telegram_debug', dbg);

    if (!enabled) return;

    if (!tokenRaw || tokenRaw === 'undefined' || tokenRaw.includes('your_bot_token')) {
      console.log('[FlipRadar][sw] telegram_not_configured (missing/invalid token)');
      return;
    }
    if (!chatIdRaw || chatIdRaw === 'undefined') {
      console.log('[FlipRadar][sw] telegram_not_configured (missing chatId)');
      return;
    }

    const text = (() => {
      // If caller provided a full text, use it, but still append a URL if one exists and isn't already included.
      let base = (payload && (payload.text || payload.message)) ? String(payload.text || payload.message) : '';
      if (!base) {
        const parts = [];
        if (payload && payload.title) parts.push(String(payload.title));
        if (payload && payload.price != null && payload.price !== '') parts.push('Price: ' + String(payload.price));
        if (payload && payload.location) parts.push(String(payload.location));
        if (payload && payload.score != null && payload.score !== '') parts.push('Score: ' + String(payload.score));
        const sn = payload && (payload.searchName || payload.search);
        if (sn) parts.push('Search: ' + String(sn));
        base = parts.filter(Boolean).join('\n');
      }
      if (!base) base = '[FlipRadar] Alert';

      const link = payload && payload.url ? String(payload.url).trim() : '';
      if (link && !base.includes(link)) {
        base = base + '\n' + link;
      }
      return base;
    })();
const url = `https://api.telegram.org/bot${tokenRaw}/sendMessage`;
    const body = new URLSearchParams({
      chat_id: chatIdRaw,
      text: String(text),
      disable_web_page_preview: 'false'
    });

    const resp = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8' },
      body
    });

    const data = await resp.json().catch(() => null);

    if (!resp.ok || !data || data.ok !== true) {
      console.log('[FlipRadar][sw] telegram_send_failed status=' + resp.status + ' body=' + JSON.stringify(data));
      // one quick retry (Telegram occasionally flakes / MV3 wakeups can be spiky)
      try {
        await new Promise(r => setTimeout(r, 400));
        const resp2 = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8' },
          body
        });
        const data2 = await resp2.json().catch(() => null);
        if (!resp2.ok || !data2 || data2.ok !== true) {
          console.log('[FlipRadar][sw] telegram_send_failed_retry status=' + resp2.status + ' body=' + JSON.stringify(data2));
          return;
        }
      } catch (e2) {
        console.log('[FlipRadar][sw] telegram_send_retry_exception', e2);
        return;
      }
    }

    console.log('[FlipRadar][sw] telegram_send_ok');
  } catch (e) {
    console.log('[FlipRadar][sw] telegram_send_exception', e);
  }
}




function parseKeywordTokens(keywords) {
  var k = normalizeText(keywords);
  if (!k) return [];
  return k.split(/\s+/).filter(Boolean);
}

function matchesKeywordsExact(title, keywords) {
  // Deterministic keyword match with simple, user-friendly semantics:
  // - If keywords is blank => match all
  // - Commas / newlines / semicolons / pipes separate OR groups
  //   e.g., "switch 2, nintendo switch 2"
  // - Within a group, space-separated tokens are ANDed
  // - Matching is "loose" substring match on normalized text (FB often mashes tokens)
  const raw = String(keywords || '').trim();
  if (!raw) return true;

  const t = normalizeText(title || '');
  const tCompact = t.replace(/\s+/g, '');
  if (!t) return false;

  // OR groups (keep delimiters before normalization)
  const groups = raw.split(/[\n,;|]+/).map(g => g.trim()).filter(Boolean);
  if (!groups.length) return true;

  for (let gi = 0; gi < groups.length; gi++) {
    const gNorm = normalizeText(groups[gi]);
    if (!gNorm) continue;
    const tokens = gNorm.split(/\s+/).map(x => x.trim()).filter(Boolean);
    if (!tokens.length) continue;

    const ok = tokens.every(tok => {
      const tokCompact = String(tok).replace(/\s+/g, '');
      return t.includes(tok) || (tokCompact && tCompact.includes(tokCompact));
    });
    if (ok) return true;
  }
  return false;
}



function scoreListing(listing, search) {
  // Score is used ONLY to rank candidates (baseline top-N + debug).
  // Alerts still require passing the strict filters (keywords + price + just-listed).
  // Range roughly 0–12 so you don't just see "3" all the time.

  const maxPrice = Number(search.maxPrice || 0);
  const price = listing.price == null ? null : Number(listing.price);

  // price component: cheaper relative to maxPrice => higher bonus
  let priceScore = 0;
  if (maxPrice > 0 && price != null && isFinite(price)) {
    if (price <= maxPrice) {
      // 0..8 bonus depending on how far under max
      const frac = Math.max(0, Math.min(1, (maxPrice - price) / maxPrice));
      priceScore = Math.round(frac * 8);
    } else {
      priceScore = -2; // over max, slightly penalize
    }
  }

  // keywords component: count matched tokens (even though alerts require ALL tokens)
  const rawKw = (search.keywords || '').toString().trim();
  let kwScore = 0;
  if (rawKw) {
    const title = (listing.title || '').toString().toLowerCase();
    const tokens = rawKw
      .toLowerCase()
      .replace(/\s+/g, ' ')
      .trim()
      .split(/[ ,]+/)
      .map(t => t.trim())
      .filter(Boolean);

    const matched = tokens.filter(t => title.includes(t)).length;
    kwScore = matched * 2; // each token worth 2 points
  }

  // small bonus for having a price at all (helps rank "real" listings above junk)
  const hasPriceBonus = (price != null && isFinite(price)) ? 1 : 0;

  const pts = Math.max(0, priceScore + kwScore + hasPriceBonus);
  return pts;
}


// ── Default seed search ─────────────────────────────────
var DEFAULT_SEARCH = {
  url: 'https://www.facebook.com/marketplace/vancouver/search?query=macbook+pro',
  keywords: 'macbook pro',
  location: 'Vancouver',
  maxPrice: 800,
  enabled: true
};


// Canonicalize/repair Marketplace search URLs so we use a stable key for baseline/tab tracking.
// Fixes cases like "...sortBy=creation_time_descendQuery=..." (missing &) and ensures sortBy is set.
function canonicalizeSearchUrl(u) {
  try {
    if (!u) return u;
    // Repair common missing-ampersand pattern
    u = u.replace(/creation_time_descendQuery=/g, 'creation_time_descend&query=');
    u = u.replace(/creation_time_descendquery=/g, 'creation_time_descend&query=');
    u = u.replace(/descendQuery=/g, 'descend&query=');
    // Normalize using URL parser
    var urlObj = new URL(u);
    // Ensure we are on marketplace search and keep only relevant params
    var sp = urlObj.searchParams;
    // Force newest-first sorting so new listings appear on top
    if (!sp.get('sortBy')) sp.set('sortBy', 'creation_time_descend');
    // Some FB URLs use "query="; keep as-is.
    urlObj.search = sp.toString();
    return urlObj.toString();
  } catch (e) {
    return u;
  }
}


// Robust tab load waiter: avoids missing fast 'complete' events
async function waitForTabComplete(tabId, timeoutMs) {
  const timeout = timeoutMs || 30000;
  try {
    const t = await chrome.tabs.get(tabId);
    if (t && t.status === 'complete') return;
  } catch (e) {}
  return await new Promise((resolve, reject) => {
    let done = false;
    const to = setTimeout(() => {
      if (done) return;
      done = true;
      chrome.tabs.onUpdated.removeListener(listener);
      reject(new Error('timeout_waiting_for_load'));
    }, timeout);

    function listener(tid, changeInfo) {
      if (tid === tabId && changeInfo && changeInfo.status === 'complete') {
        if (done) return;
        done = true;
        clearTimeout(to);
        chrome.tabs.onUpdated.removeListener(listener);
        resolve();
      }
    }
    chrome.tabs.onUpdated.addListener(listener);

    (async () => {
      try {
        const t2 = await chrome.tabs.get(tabId);
        if (t2 && t2.status === 'complete') listener(tabId, { status: 'complete' });
      } catch (e) {}
    })();
  });
}

async function ensureDefaults() {
  var data = await chrome.storage.local.get({ settings: {}, searches: [], seenIds: [], tabMap: {}, priceMap: {}, baselineMap: {} });
  if (data.searches.length === 0) {
    await chrome.storage.local.set({ searches: [DEFAULT_SEARCH] });
    console.log('[FlipRadar][sw] seeded_default');
  }
}

// ── Core Engine: Autonomous Tab-Based Ingestion ─────────

// MAX_ALERTS_PER_TICK constant
const MAX_ALERTS_PER_TICK = 3;
// After baseline, only alert for unseen items within the top N newest results (sorted by creation_time_descend)
const NEW_LISTINGS_WINDOW = 60;

const IGNORE_STOP_PREFIX = 5; // ignore baseline stopIds appearing in first few results (pinned/reordered)
// --- Notification URL routing (so clicking Chrome notif opens the listing) ---
async function rememberNotifUrl(notifId, url) {
  try {
    if (!notifId || !url) return;
    const data = await chrome.storage.local.get({ notifUrlMap: {} });
    const m = data.notifUrlMap || {};
    m[String(notifId)] = String(url);
    const keys = Object.keys(m);
    if (keys.length > 200) {
      for (const k of keys.slice(0, keys.length - 200)) delete m[k];
    }
    await chrome.storage.local.set({ notifUrlMap: m });
  } catch (e) {
    console.warn('[FlipRadar][sw] rememberNotifUrl_failed', e);
  }
}

async function popNotifUrl(notifId) {
  try {
    const data = await chrome.storage.local.get({ notifUrlMap: {} });
    const m = data.notifUrlMap || {};
    const key = String(notifId);
    const url = m[key];
    if (url) {
      delete m[key];
      await chrome.storage.local.set({ notifUrlMap: m });
      return url;
    }
  } catch (e) {
    console.warn('[FlipRadar][sw] popNotifUrl_failed', e);
  }
  return null;
}


async function handleTick() {
  if (__tickRunning) { console.log('[FlipRadar][sw] tick_skipped (already running)'); return { ok: true, newAlerts: 0, skipped: true }; }
  __tickRunning = true;
  try {
  console.log('[FlipRadar][sw] tick_started');

  // 1. Load State
  var data = await chrome.storage.local.get({
    searches: [],
    seenIds: [],
    alertHistory: [],
    settings: { minScore: 2, checkIntervalMin: 5 },
    tabMap: {},
    priceMap: {},
    baselineMap: {},
    notifUrlMap: {}
  });

  var searches = data.searches || [];
  var seenIdsArr = data.seenIds || [];
  var alertHistory = data.alertHistory || [];
  var settings = data.settings || { minScore: 2, checkIntervalMin: 5 };
  var tabMap = data.tabMap || {};
  var priceMap = data.priceMap || {};
  var baselineMap = data.baselineMap || {};

  var minScore = Number(settings.minScore) || 2;
  var checkMin = Number(settings.checkIntervalMin) || 5;

  // Convert seenIds to Set for O(1) lookups
  var seen = new Set((seenIdsArr || []).map(function(x){ return String(x); }));

  // Filter enabled searches
  var enabledSearches = searches.filter(function (s) { return s.enabled !== false; });
  try {
    console.log('[FlipRadar][sw] tick_search_list total=' + (searches ? searches.length : 0));
    (searches || []).forEach(function(s, idx){
      console.log('[FlipRadar][sw] tick_search['+idx+'] enabled=' + (s && s.enabled !== false) + ' url=' + (s && s.url ? s.url : '(none)') + ' kw=' + (s && (s.keywords||'')));
    });
    console.log('[FlipRadar][sw] tick_enabled_count=' + (enabledSearches ? enabledSearches.length : 0));
  } catch(e) {}

  if (enabledSearches.length === 0) {
    console.log('[FlipRadar][sw] tick_complete new_alerts=0 (no enabled searches)');
    return { ok: true, newAlerts: 0 };
  }

  var totalNewAlerts = 0;

  // 2. Process each enabled search
  for (let searchIndex = 0; searchIndex < enabledSearches.length; searchIndex++) {
    try { console.log('[FlipRadar][sw] search_loop_enter idx=' + searchIndex + ' label=' + (enabledSearches[searchIndex] && (enabledSearches[si].keywords || enabledSearches[si].url))); } catch(e) {}

    const search = enabledSearches[searchIndex];
    var urlKey = canonicalizeSearchUrl(search.url);
    if (!search.url) continue;

    // Stop if alert cap reached
    // If we've hit the per-tick alert cap, we still continue scanning remaining searches
    // to keep baselines/seenIds/priceMap up to date. We just suppress further notifications.
    var alertsSuppressed = (totalNewAlerts >= MAX_ALERTS_PER_TICK);
    if (alertsSuppressed) {
      console.log(`[FlipRadar][sw] alert cap (${MAX_ALERTS_PER_TICK}) reached; suppressing further notifications but continuing scans.`);
    }
    var canNotifyThisSearch = !alertsSuppressed;
    var notifyBudget = Math.max(0, MAX_ALERTS_PER_TICK - totalNewAlerts);

    try {
      // ── A. Tab Management: find or create ──
      var tabId = tabMap[urlKey];
      var tab = null;

      if (tabId) {
        try {
          tab = await chrome.tabs.get(tabId);
        } catch (e) {
          tab = null; // tab was closed
        }
      }

      if (!tab) {
        // Create a new background tab
        tab = await chrome.tabs.create({ url: urlKey, active: false });
        tabId = tab.id;
        tabMap[urlKey] = tabId; // Store tab mapping
        await chrome.storage.local.set({ tabMap: tabMap });
      } else {
        // Tab exists — navigate or reload to ensure fresh content
        if (tab.url !== urlKey) {
          await chrome.tabs.update(tabId, { url: urlKey });
        } else {
          await chrome.tabs.reload(tabId);
        }
      }

      // ── B. Wait for tab load complete (robust) ──
      await waitForTabComplete(tabId, 30000);

      // ── C. SPA render delay (FB Marketplace is React SPA) ──
      await new Promise(function (r) { setTimeout(r, 3000); });




// Helper to recreate the Marketplace tab if Chrome discards/closes it mid-tick.
async function recreateMarketplaceTab() {
  try { if (tabId) { try { await chrome.tabs.remove(tabId); } catch (e) {} } } catch (e) {}
  const t = await chrome.tabs.create({ url: urlKey, active: false });
  tabId = t.id;
  tabMap[urlKey] = tabId;
  await chrome.storage.local.set({ tabMap: tabMap });

  // wait for load complete again
  await waitForTabComplete(tabId, 30000);
  await new Promise(function (r) { setTimeout(r, 1500); });
}
      // ── C2. Auto-scroll to trigger lazy-loaded listing cards ──
      // Facebook Marketplace often only loads ~24 items at first. We scroll multiple
      // times to try to load more results before we ask content.js to collect them.
      //
      // Tune these if you want more/less depth:
      var TARGET_ANCHORS = 200;   // try to load up to ~200 listing links
      var MAX_SCROLL_PASSES = 10; // safety cap
      for (var sp = 0; sp < MAX_SCROLL_PASSES; sp++) {
        var _scrollProbe = await withTabRetry(() => chrome.scripting.executeScript({
          target: { tabId: tabId },
          func: function () {
            window.scrollTo(0, document.body.scrollHeight);
            var anchors = document.querySelectorAll('a[href*="/marketplace/item/"]');
            return anchors.length;
          }
        }), recreateMarketplaceTab);
        var _anchorCountNow = (_scrollProbe && _scrollProbe[0] && _scrollProbe[0].result) || 0;
        if (_anchorCountNow >= TARGET_ANCHORS) break;
        // Wait a bit for the next batch to lazy-load
        await new Promise(function (r) { setTimeout(r, 2500); });
      }

      // ── C3. Wait for listing anchors to appear (up to 5s) ──
      for (var _waitI = 0; _waitI < 20; _waitI++) {
        var _probeResult = await withTabRetry(() => chrome.scripting.executeScript({
          target: { tabId: tabId },
          func: function () { return document.querySelectorAll('a[href*="/marketplace/item/"]').length; }
        }), recreateMarketplaceTab);
        var _anchorCount = (_probeResult && _probeResult[0] && _probeResult[0].result) || 0;
        console.log('[FlipRadar][sw] anchor_wait pass=' + (_waitI + 1) + ' anchors=' + _anchorCount);
        if (_anchorCount > 0) break;
        await new Promise(function (r) { setTimeout(r, 900); });
      }

      // ── D. Send scan command to content script ──
      var response = null;
      try {
        response = await withTabRetry(() => chrome.tabs.sendMessage(tabId, { cmd: 'scan_listings' }), recreateMarketplaceTab);
      } catch (sendErr) {
        // Content script not present — inject via chrome.scripting (MV3)
        console.log('[FlipRadar][sw] injecting content.js into tab ' + tabId);
        await withTabRetry(() => chrome.scripting.executeScript({
          target: { tabId: tabId },
          files: ['content.js']
        }), recreateMarketplaceTab);
        // Brief pause for script to initialize
        await new Promise(function (r) { setTimeout(r, 900); });
        response = await chrome.tabs.sendMessage(tabId, { cmd: 'scan_listings' });
      }

      // DEBUG: log scan outcome every tick/search
      console.log('[FlipRadar][sw] scan_ok=' + (!!response && response.ok) + ' listings_len=' + ((response && response.listings && response.listings.length) || 0));

      // DOM probe if listings empty
      if (!response || !response.listings || response.listings.length === 0) {
        try {
          var _domProbe = await withTabRetry(() => chrome.scripting.executeScript({
            target: { tabId: tabId },
            func: function () {
              var anchors = document.querySelectorAll('a[href*="/marketplace/item/"]');
              var hrefs = [];
              for (var i = 0; i < Math.min(anchors.length, 5); i++) {
                hrefs.push(anchors[i].getAttribute('href'));
              }
              return {
                href: location.href,
                readyState: document.readyState,
                anchorCount: anchors.length,
                sampleHrefs: hrefs
              };
            }
        }), recreateMarketplaceTab);
          var _probeData = (_domProbe && _domProbe[0] && _domProbe[0].result) || {};
          console.log('[FlipRadar][sw] dom_probe href=' + _probeData.href + ' readyState=' + _probeData.readyState + ' anchors=' + _probeData.anchorCount + ' samples=' + JSON.stringify(_probeData.sampleHrefs));
        } catch (_probeErr) {
          console.warn('[FlipRadar][sw] dom_probe_failed', _probeErr);
        }
      }

      // Guard: validate response
      if (!response || !response.ok || !response.listings) {
        throw new Error('scan_failed_or_empty');
      }

            var listings = response.listings || [];
            var total = listings.length;
            var qualifiedCount = 0;
            var unseenQualifiedCount = 0;
            var olderSkippedCount = 0;

            // ── BASELINE (first run for this search URL) ──
            // Prevents "old but unseen" listings from alerting on the first scan.
            // New behavior: on the baseline run, send up to 3 alerts for the best-scoring
            // listings that match filters (keywords + max price + min score), then mark
            // everything as seen so baseline items never alert again.
            var baselineRun = false;
            if (!baselineMap[urlKey]) {
              baselineRun = true;
              var baselineCreatedAt = Date.now();
              var stopIds = listings.slice(0, NEW_LISTINGS_WINDOW).map(function(x){ return x && x.id ? String(x.id) : null; }).filter(Boolean);
              baselineMap[urlKey] = { createdAt: baselineCreatedAt, stopIds: stopIds };

              // 1) Mark everything as seen + seed priceMap so drops work later
              for (var bi = 0; bi < listings.length; bi++) {
                var b = listings[bi];
                if (!b || !b.id) continue;
                seen.add(String(b.id));

                var bp = parsePrice(b.price);
                if (bp != null && isFinite(bp)) priceMap[String(b.id)] = bp;
              }

              // 2) Pick top 3 "best" matches from this baseline batch
              var baselineCandidates = [];
              var baselineMaxPrice = parsePrice(search.maxPrice) || 0;
              for (var ci = 0; ci < listings.length; ci++) {
                var it = listings[ci];
                if (!it || !it.id) continue;

                if (!matchesKeywordsExact(it.title || '', search.keywords || '')) continue;
                var sc = scoreListing(it, search);

                var pr = parsePrice(it.price);
                var okPrice = (baselineMaxPrice <= 0) || (pr != null && isFinite(pr) && pr <= baselineMaxPrice);
                if (!okPrice) continue;

                baselineCandidates.push({ item: it, score: sc, price: pr });
              }

              baselineCandidates.sort(function (a, b) {
                if (b.score !== a.score) return b.score - a.score;
                var ap = (a.price == null || !isFinite(a.price)) ? Number.POSITIVE_INFINITY : a.price;
                var bp2 = (b.price == null || !isFinite(b.price)) ? Number.POSITIVE_INFINITY : b.price;
                return ap - bp2;
              });

              
// Deduplicate and cap stopIds so we can detect the "old listings" boundary later.
// After baseline, we only consider listings that appear BEFORE we hit any of these IDs
// in the (newest-first) results.
try {
  var uniq = [];
  var seenStop = new Set();
  for (var si = 0; si < stopIds.length; si++) {
    var sid = stopIds[si];
    if (!sid || seenStop.has(sid)) continue;
    seenStop.add(sid);
    uniq.push(sid);
    if (uniq.length >= 60) break;
  }
  baselineMap[urlKey].stopIds = uniq;
} catch (e) {
  // non-fatal
}

var baselineTopN = 0; // disabled: no baseline notifications
              
// 3) Persist baseline marker + priceMap (so price-drops work next tick)
              try {
                await chrome.storage.local.set({ baselineMap: baselineMap, priceMap: priceMap });
              } catch (e) {
                console.warn('[FlipRadar][sw] baseline_persist_failed', e);
              }

              console.log('[FlipRadar][sw] baseline_created url=' + urlKey + ' ids=' + total + ' topSent=' + Math.min(baselineCandidates.length, baselineTopN));
            }

            // ── E. Score + Dedupe + Notify + History ──
            var newForThisSearch = 0;

            if (!baselineRun) {
              
              // Build boundary set from baseline stop IDs (string-normalized)
              var stopIds2 = (baselineMap[urlKey] && baselineMap[urlKey].stopIds) ? baselineMap[urlKey].stopIds : [];
              var stopSet = new Set((stopIds2 || []).map(function(x){ return String(x); }));
              var pastBaseline = false;
              var stopHit = false;
              var stopId = null;
              var brokeAtIndex = -1;
              var oldScanLimit = 200;

for (var li = 0; li < listings.length; li++) {
  if (pastBaseline && li > oldScanLimit) { break; }

  var item = listings[li];
  if (item && item.id && (!item.url || String(item.url).trim()==='')) {
    item.url = 'https://www.facebook.com/marketplace/item/' + String(item.id) + '/';
  }


  // Ignore very old results beyond the newest window; still mark them seen so they don't alert later.
  if (li >= NEW_LISTINGS_WINDOW) {
    if (item) {
            var _keysSeen = getStableKeys(item);
            for (var _si = 0; _si < _keysSeen.length; _si++) seen.add(_keysSeen[_si]);
          }
continue;
  }

  // Results are sorted newest-first. Once we hit any baseline ID,
  // everything after it is "old" (pre-baseline). Don't alert on it.
  if (stopSet && item && item.id && stopSet.has(String(item.id))) {
    // If a baseline stopId shows up super early, it can be a pinned/reordered older listing.
    // Ignore it in the first few results so we still catch true new items near the top.
    if (li >= IGNORE_STOP_PREFIX) {
      stopHit = true;
      stopId = String(item.id);
      brokeAtIndex = li;
      pastBaseline = true;
      break;
    }
  }

                if (!item || !item.id) continue;

                // STRICT keyword match: every token must appear as a whole word in the title
                if (!matchesKeywordsExact(item.title || '', search.keywords || '')) continue;

                // Score gate (after keyword match)
                var score = scoreListing(item, search);
                if (score >= minScore) qualifiedCount++;
                // Do not hard-gate alerts by score; score is informational only.

                // Price gate (maxPrice)
                var maxPrice = parsePrice(search.maxPrice) || 0;
                var price = parsePrice(item.price);
                var priceOk = (maxPrice <= 0) || (price != null && isFinite(price) && price <= maxPrice);

                // Track price changes regardless of seen/new
                var _keysPrice = getStableKeys(item);
                var prevPrice = getPrevPrice(priceMap, _keysPrice);
                var hasPrev = (prevPrice != null && isFinite(prevPrice));
                var hasNow = (price != null && isFinite(price));
                var isDrop = hasPrev && hasNow && price < prevPrice;

                // Always store latest observed price if valid
                if (hasNow) setPriceForKeys(priceMap, _keysPrice, price);

                // Alert cap: never stop scanning; just stop notifying when cap reached
      var canAlert = (!alertsSuppressed) && (notifyBudget > 0) && (totalNewAlerts < MAX_ALERTS_PER_TICK);

                // PRICE DROP alert (only if it matches filters right now)
                if (isDrop && priceOk) {
                  if (canAlert) {
                    // baseline top alerts do not consume per-tick cap
                    newForThisSearch++;
                    notifyBudget = Math.max(0, notifyBudget - 1);
                    totalNewAlerts++;

                    if (chrome.notifications && chrome.notifications.create) {
                      var _dropId = 'drop_' + item.id + '_' + Date.now();
                      await rememberNotifUrl(_dropId, item.url);
                      chrome.notifications.create(_dropId, {
                        type: 'basic',
                        iconUrl: 'icons/icon48.png',
                        title: 'PRICE DROP: $' + price + ' — ' + (item.title || ''),
                        message: 'Was $' + prevPrice + ' | Score ' + score + ' | ' + (item.url || '')
                      });
                    }

                    // consume one notification budget for baseline_top
                notifyBudget = Math.max(0, notifyBudget - 1);
                totalNewAlerts++;

                await sendTelegramAlert({
                      title: '[PRICE DROP] ' + (item.title || ''),
                      price: price,
                      url: item.url,
                      score: score,
                      search: (search.keywords || search.url)
                    });

                    alertHistory.push({
                      id: item.id,
                      title: item.title,
                      price: price,
                      prevPrice: prevPrice,
                      url: item.url,
                      score: score,
                      ts: new Date().toISOString(),
                      type: 'price_drop',
                      searchUrl: search.url
                    });
                  }
                }

                // NEW listing alert (first time we ever see it, and it matches filters right now)
                if (!pastBaseline && !seen.has(String(item.id))) {
                  unseenQualifiedCount++;
                  seen.add(String(item.id)); // mark seen even if we can't alert (prevents re-alerting later)

                  if (priceOk) {
                    if (canAlert) {
                      // baseline top alerts do not consume per-tick cap
                      newForThisSearch++;
                      notifyBudget = Math.max(0, notifyBudget - 1);
                      totalNewAlerts++;

                      if (chrome.notifications && chrome.notifications.create) {
                        await rememberNotifUrl(item.id, item.url);
                        chrome.notifications.create(item.id, {
                          type: 'basic',
                          iconUrl: 'icons/icon48.png',
                          title: '$' + (item.price != null ? item.price : '?') + ' — ' + (item.title || ''),
                          message: 'NEW | Score ' + score + ' | ' + (item.url || '')
                        });
                      }

                      // consume one notification budget for baseline_top
                notifyBudget = Math.max(0, notifyBudget - 1);
                totalNewAlerts++;

                await sendTelegramAlert({
                        title: '[NEW] ' + (item.title || ''),
                        price: item.price,
                        url: item.url,
                        score: score,
                        search: (search.keywords || search.url)
                      });

                      alertHistory.push({
                        id: item.id,
                        title: item.title,
                        price: item.price,
                        url: item.url,
                        score: score,
                        ts: new Date().toISOString(),
                        type: 'new',
                        searchUrl: search.url
                      });
                    }
                  } else {
                    olderSkippedCount++;
                  }
                }
              }
            }

console.log('[FlipRadar][sw] scan_summary total=' + total + ' qualified=' + qualifiedCount + ' unseenQualified=' + unseenQualifiedCount + ' new=' + newForThisSearch + ' stopHit=' + stopHit + ' stopId=' + (stopId||'') + ' brokeAt=' + brokeAtIndex + ' pastBaseline=' + pastBaseline);
      console.log('[FlipRadar][sw] search "' + (search.keywords || search.url) + '" result: ' + newForThisSearch + ' new alerts');

    } catch (err) {
      console.warn('[FlipRadar][sw] error_processing_search "' + (search.keywords || search.url) + '": ' + (err && err.message ? err.message : err));
      // Continue to next search — never crash the tick loop
    }
    finally {
      // Always close the Marketplace tab we opened for this search
      // Always close the Marketplace tab we opened for this search.
      // Use the local tabId when available (more reliable than tabMap lookup).
      const tid = (typeof tabId !== 'undefined' && tabId) ? tabId : (tabMap && tabMap[urlKey]);
      if (tid) {
        try { await chrome.tabs.remove(tid); } catch (e) {}
      }
      try { if (tabMap) delete tabMap[urlKey]; } catch (e) {}
      try { await chrome.storage.local.set({ tabMap: tabMap }); } catch (e) {}
    }
    try { console.log('[FlipRadar][sw] search_loop_exit idx=' + searchIndex); } catch(e) {}

  }


  // 3. Serialize Set back to array, cap at 5000
  var seenArr = Array.from(seen);
  if (seenArr.length > 5000) seenArr = seenArr.slice(-5000);

  // Keep priceMap bounded too (otherwise chrome.storage writes can fail and then
  // nothing persists — which looks like "baseline_created" happening every tick).
  // We keep only prices for items still in our seen list.
  try {
    var keepIds = new Set(seenArr);
    var nextPriceMap = {};
    for (var k in priceMap) {
      if (keepIds.has(k)) nextPriceMap[k] = priceMap[k];
    }
    priceMap = nextPriceMap;
  } catch (e) {
    console.warn('[FlipRadar][sw] priceMap_prune_failed', e);
  }

  // Cap alert history at 50
  if (alertHistory.length > 50) alertHistory = alertHistory.slice(-50);

  // Persist
  await chrome.storage.local.set({
    seenIds: seenArr,
    priceMap: priceMap,
    baselineMap: baselineMap,
    alertHistory: alertHistory,
    tabMap: tabMap
  });

  console.log('[FlipRadar][sw] tick_complete new_alerts=' + totalNewAlerts);

  // 4. Reschedule alarm to match current checkIntervalMin
  try {
    await chrome.alarms.clear('flipradar-check');
    chrome.alarms.create('flipradar-check', { periodInMinutes: checkMin });
  } catch (e) {
    console.warn('[FlipRadar][sw] warning: failed to reschedule alarm', e);
  }

  return { ok: true, newAlerts: totalNewAlerts };
  } finally {
    __tickRunning = false;
  }
}

// ── Message Listener ────────────────────────────────────
chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
  (async function () {
    try {
      if (msg && msg.cmd === 'tick') {
        console.log('[FlipRadar][sw] tick_requested');
        var result = await handleTick();
        sendResponse(result);
        return;
      }
      if (msg && msg.cmd === 'clearSeen') {
        await chrome.storage.local.set({ seenIds: [] });
        console.log('[FlipRadar][sw] seen_cleared');
        sendResponse({ ok: true });
        return;
      }
      
      if (msg && (msg.cmd === 'clearBaselines' || msg.cmd === 'resetBaselines')) {
        await chrome.storage.local.set({ baselineMap: {}, seenIds: [], notifUrlMap: {} });
        console.log('[FlipRadar][sw] baselines_cleared');
        sendResponse({ ok: true });
        return;
      }
sendResponse({ ok: false, error: 'unknown_cmd' });
    } catch (e) {
      console.error('[FlipRadar][sw] msg_error', e && e.stack ? e.stack : e);
      sendResponse({ ok: false, error: String(e) });
    }
  })();
  return true;
});

// ── Alarm listener ──────────────────────────────────────
try {
  chrome.alarms.onAlarm.addListener(function (alarm) {
    if (alarm.name === 'flipradar-check') handleTick();
  });
} catch (e) {
  console.error('[FlipRadar][sw] alarm_listener_error', e);
}

// ── Notification click handler ──────────────────────────
try {
  if (chrome.notifications && chrome.notifications.onClicked) {
    chrome.notifications.onClicked.addListener(async function (notifId) {
  console.log('[FlipRadar][sw] notification_clicked: ' + notifId);
  const url = await popNotifUrl(notifId);
  if (url) {
    try {
      await chrome.tabs.create({ url });
    } catch (e) {
      chrome.tabs.create({ url });
    }
  }
});
  }
} catch (e) {
  console.error('[FlipRadar][sw] notif_listener_error', e);
}

// ── Boot ────────────────────────────────────────────────
ensureDefaults()
  .then(function () {
    // Ensure alarm exists and is configured with the current settings' interval
    chrome.alarms.get('flipradar-check', function (existing) {
      // If no alarm or interval changed, create/recreate it
      chrome.storage.local.get({ settings: { checkIntervalMin: 5 } }, function(res){
      const currentInterval = Number((res.settings||{}).checkIntervalMin) || 5;
      if (!existing || existing.periodInMinutes !== currentInterval) {
        chrome.alarms.create('flipradar-check', { periodInMinutes: currentInterval });
        console.log('[FlipRadar][sw] initial alarm created/updated to ' + currentInterval + ' min');
      }
    });
    });
    console.log('[FlipRadar][sw] ready');
  })
  .catch(function (e) {
    console.error('[FlipRadar][sw] boot_error', e);
  });