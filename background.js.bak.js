console.log('[FlipRadar][sw] build_id=2026-02-28T10:08Z');
console.log('[FlipRadar][sw] boot');

// ─────────────────────────────────────────────────────────
// FlipRadar v0.1 — Service Worker (Manifest MV3)
// Production-safe, autonomous tab-based ingestion engine
// ─────────────────────────────────────────────────────────

function safeStringify(x) {
  try { return JSON.stringify(x); } catch (e) { return String(x); }
}
// ── Telegram (deterministic + logged) ─────────────────────
function maskToken(tok) {
  if (!tok) return '';
  tok = String(tok);
  return tok.slice(0, 12) + '…' + tok.slice(-6);
}

async function sendTelegramAlert(alert) {
  try {
    var data = await chrome.storage.local.get({ settings: {} });
    var settings = data.settings || {};
    var token = (settings.telegramBotToken || '').toString().trim();
    var chatId = (settings.telegramChatId || '').toString().trim();

    if (!token || !chatId) {
      console.log('[FlipRadar][sw] telegram_skip missing_token_or_chatId');
      return;
    }

    var text =
      'FlipRadar alert\n' +
      (alert.title ? ('• ' + alert.title + '\n') : '') +
      (alert.price != null ? ('• Price: $' + alert.price + '\n') : '') +
      (alert.score != null ? ('• Score: ' + alert.score + '\n') : '') +
      (alert.search ? ('• Search: ' + alert.search + '\n') : '') +
      (alert.url ? ('• ' + alert.url) : '');

    var url = 'https://api.telegram.org/bot' + token + '/sendMessage';

    console.log('[FlipRadar][sw] telegram_send token=' + maskToken(token) + ' chatId=' + chatId);

    var res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text: text,
        disable_web_page_preview: true
      })
    });

    var bodyText = await res.text();
    console.log('[FlipRadar][sw] telegram_resp status=' + res.status + ' body=' + bodyText);

  } catch (e) {
    console.warn('[FlipRadar][sw] telegram_error', e);
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

// ---------- Strict keyword matching helpers ----------
function normalizeText(s) {
  return (s || '')
    .toString()
    .toLowerCase()
    .replace(/[\u2019']/g, '')      // normalize apostrophes
    .replace(/[^a-z0-9\s]/g, ' ')   // remove punctuation
    .replace(/\s+/g, ' ')
    .trim();
}

function keywordTokens(keywords) {
  const k = normalizeText(keywords);
  if (!k) return [];
  // split on spaces/commas
  return k.split(/[,\s]+/).map(t => t.trim()).filter(Boolean);
}

// "Exact" match here = every token must appear somewhere in the title
function matchesKeywordsExact(title, keywords) {
  var tokens = parseKeywordTokens(keywords);
  if (!tokens.length) return true;

  var t = " " + normalizeText(title) + " "; // pad for boundary-ish matching

  for (var i = 0; i < tokens.length; i++) {
    var tok = normalizeText(tokens[i]);
    if (!tok) continue;

    // require whole-token-ish match
    if (t.indexOf(" " + tok + " ") === -1) return false;
  }
  return true;
}
function scoreListing(listing, search) {
  // IMPORTANT: scoring only. No keyword / price filtering here.
  var pts = 0;

  var title = (listing.title || "").toLowerCase();
  var desc  = (listing.description || "").toLowerCase();

  // Basic positive signals
  if (BRANDS.some(function (b) { return title.indexOf(b) !== -1; })) pts += 2;
  if (CONDITION_WORDS.some(function (c) { return title.indexOf(c) !== -1; })) pts += 1;

  // Electronics signals boost (optional)
  if (ELECTRONICS_SIGNALS.some(function (sig) { return title.indexOf(sig) !== -1 || desc.indexOf(sig) !== -1; })) pts += 1;

  // Negative signals (optional)
  if (NEGATIVE_SIGNALS.some(function (sig) { return title.indexOf(sig) !== -1 || desc.indexOf(sig) !== -1; })) pts -= 2;

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

async function ensureDefaults() {
  var data = await chrome.storage.local.get({ searches: [] });
  if (data.searches.length === 0) {
    await chrome.storage.local.set({ searches: [DEFAULT_SEARCH] });
    console.log('[FlipRadar][sw] seeded_default');
  }
}

// ── Core Engine: Autonomous Tab-Based Ingestion ─────────

// MAX_ALERTS_PER_TICK constant
const MAX_ALERTS_PER_TICK = 3;

async function handleTick() {
  console.log('[FlipRadar][sw] tick_started');

  // 1. Load State
  var data = await chrome.storage.local.get({ settings: {}, searches: [], seenIds: [], tabMap: {}, priceMap: {}, baselineMap: {} });
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
  var seen = new Set(seenIdsArr);
var priceMap = data.priceMap || {};

  // Filter enabled searches
  var enabledSearches = searches.filter(function (s) { return s.enabled !== false; });
  if (enabledSearches.length === 0) {
    console.log('[FlipRadar][sw] tick_complete new_alerts=0 (no enabled searches)');
    return { ok: true, newAlerts: 0 };
  }

  var totalNewAlerts = 0;

  // 2. Process each enabled search
  for (var si = 0; si < enabledSearches.length; si++) {
    var search = enabledSearches[si];
    if (!search.url) continue;

    // Stop if alert cap reached
   var capReached = (totalNewAlerts >= MAX_ALERTS_PER_TICK);
if (capReached) {
  console.log(`[FlipRadar][sw] alert cap reached (${MAX_ALERTS_PER_TICK}) — will keep scanning, but suppress alerts this tick.`);
}

    try {
      // ── A. Tab Management: find or create ──
      var tabId = tabMap[search.url];
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
        tab = await chrome.tabs.create({ url: search.url, active: false });
        tabId = tab.id;
        tabMap[search.url] = tabId; // Store tab mapping
        await chrome.storage.local.set({ tabMap: tabMap });
      } else {
        // Tab exists — navigate or reload to ensure fresh content
        if (tab.url !== search.url) {
          await chrome.tabs.update(tabId, { url: search.url });
        } else {
          await chrome.tabs.reload(tabId);
        }
      }

      // ── B. Wait for tab load complete (30s timeout) ──
      await new Promise(function (resolve, reject) {
        var timeout = setTimeout(function () {
          chrome.tabs.onUpdated.removeListener(listener);
          reject(new Error('timeout_waiting_for_load'));
        }, 30000);

        function listener(tid, changeInfo) {
          if (tid === tabId && changeInfo.status === 'complete') {
            clearTimeout(timeout);
            chrome.tabs.onUpdated.removeListener(listener);
            resolve();
          }
        }
        chrome.tabs.onUpdated.addListener(listener);
      });

      // ── C. SPA render delay (FB Marketplace is React SPA) ──
      await new Promise(function (r) { setTimeout(r, 3000); });


      // ── C2. Auto-scroll to trigger lazy-loaded listing cards ──
      await chrome.scripting.executeScript({
        target: { tabId: tabId },
        func: function () { window.scrollTo(0, document.body.scrollHeight); }
      });
      await new Promise(function (r) { setTimeout(r, 2000); });
      // Second scroll pass for additional lazy-loaded cards
      await chrome.scripting.executeScript({
        target: { tabId: tabId },
        func: function () { window.scrollTo(0, document.body.scrollHeight); }
      });
      await new Promise(function (r) { setTimeout(r, 1000); });

      // ── C3. Wait for listing anchors to appear (up to 5s) ──
      for (var _waitI = 0; _waitI < 10; _waitI++) {
        var _probeResult = await chrome.scripting.executeScript({
          target: { tabId: tabId },
          func: function () { return document.querySelectorAll('a[href*="/marketplace/item/"]').length; }
        });
        var _anchorCount = (_probeResult && _probeResult[0] && _probeResult[0].result) || 0;
        console.log('[FlipRadar][sw] anchor_wait pass=' + (_waitI + 1) + ' anchors=' + _anchorCount);
        if (_anchorCount > 0) break;
        await new Promise(function (r) { setTimeout(r, 500); });
      }

      // ── D. Send scan command to content script ──
      var response = null;
      try {
        response = await chrome.tabs.sendMessage(tabId, { cmd: 'scan_listings' });
      } catch (sendErr) {
        // Content script not present — inject via chrome.scripting (MV3)
        console.log('[FlipRadar][sw] injecting content.js into tab ' + tabId);
        await chrome.scripting.executeScript({
          target: { tabId: tabId },
          files: ['content.js']
        });
        // Brief pause for script to initialize
        await new Promise(function (r) { setTimeout(r, 500); });
        response = await chrome.tabs.sendMessage(tabId, { cmd: 'scan_listings' });
      }

      // DEBUG: log scan outcome every tick/search
      console.log('[FlipRadar][sw] scan_ok=' + (!!response && response.ok) + ' listings_len=' + ((response && response.listings && response.listings.length) || 0));

      // DOM probe if listings empty
      if (!response || !response.listings || response.listings.length === 0) {
        try {
          var _domProbe = await chrome.scripting.executeScript({
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
          });
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

      // ── E. Score + Dedupe + Notify + History ──
      var newForThisSearch = 0;

      for (var li = 0; li < listings.length; li++) {
        
var item = listings[li];
if (!item || !item.id) continue;
// -------- BASELINE (first run for this search) -------- baselineMap = baselineMap || {}; if (!baselineMap[search.url]) { // store the first batch as baseline and mark them as seen baselineMap[search.url] = listings.map(x => x.id).filter(Boolean); for (const id of baselineMap[search.url]) { seen.add(id); } await chrome.storage.local.set({ baselineMap: baselineMap }); console.log('[FlipRadar][sw] baseline_created url=' + search.url + ' ids=' + baselineMap[search.url].length); // Skip alerts on baseline run continue; }

var canAlert = (totalNewAlerts < MAX_ALERTS_PER_TICK);

// -------- STRICT KEYWORDS (ALL tokens must appear) --------
var rawKw = (search.keywords || '').toString().trim();
var title = (item.title || '').toString();

function norm(s) {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}
var titleN = norm(title);

// split keywords into tokens on spaces/commas
var tokens = rawKw ? norm(rawKw).split(/\s+/).filter(Boolean) : [];

// if keywords were provided, require ALL tokens in title
if (tokens.length) {
  var allTok = tokens.every(t => titleN.includes(t));
  if (!allTok) continue;
}

// -------- PRICE GATE (must be <= maxPrice if set) --------
var maxPrice = Number(search.maxPrice || 0);
var price = (item.price == null ? null : Number(item.price));

if (maxPrice > 0) {
  if (price == null || !isFinite(price) || price > maxPrice) continue;
}

// -------- SCORE (optional, but only after keyword+price pass) --------
var score = scoreListing(item, search);
console.log('[FlipRadar][sw] listing "' + (item.title || '(no title)') + '" score=' + score + ' (need >=' + minScore + ')');
if (score < minScore) continue;

// -------- PRICE DROP detection --------
var prevPrice = priceMap[item.id];
if (price != null && isFinite(price)) {
  // store latest observed price
if (prevPrice != null && isFinite(prevPrice) && price < prevPrice) {

  // If we hit the cap, do NOT alert — just move on (priceMap already updated)
  if (!canAlert) {
    continue;
  }

  // price dropped → alert
  totalNewAlerts++;
  newForThisSearch++;

  if (chrome.notifications && chrome.notifications.create) {
    chrome.notifications.create('drop_' + item.id + '_' + Date.now(), {
      type: 'basic',
      iconUrl: 'icons/icon48.png',
      title: 'PRICE DROP: $' + price + ' — ' + (item.title || ''),
      message: 'Was $' + prevPrice + ' | Score ' + score + ' | ' + (item.url || '')
    });
  }

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

  priceMap[item.id] = price;
}

// -------- NEW listing logic (MUST be "Just listed") --------
// This prevents “old unseen” listings from ever alerting.
var isJustListed = titleN.includes('just listed');
if (!isJustListed) continue;

// already alerted as NEW before?
if (seen.has(item.id)) continue;

// Always mark seen so it never re-alerts later
seen.add(item.id);

// If we've hit the cap, DO NOT alert — just skip
if (!canAlert) {
  continue;
}

newForThisSearch++;
totalNewAlerts++;

if (chrome.notifications && chrome.notifications.create) {
  chrome.notifications.create(item.id, {
    type: 'basic',
    iconUrl: 'icons/icon48.png',
    title: '$' + (item.price != null ? item.price : '?') + ' — ' + (item.title || ''),
    message: 'NEW | Score ' + score + ' | ' + (item.url || '')
  });
}

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
      console.log('[FlipRadar][sw] scan_summary total=' + total + ' qualified=' + qualifiedCount + ' unseenQualified=' + unseenQualifiedCount + ' new=' + newForThisSearch);
      console.log('[FlipRadar][sw] search "' + (search.keywords || search.url) + '" result: ' + newForThisSearch + ' new alerts'); // Close the FB Marketplace tab for this search so it doesn't stay open
try {
  const tid = tabMap && tabMap[search.url];
  if (tid) await chrome.tabs.remove(tid);
} catch (e) {}

try { delete tabMap[search.url]; } catch (e) {}
try { await chrome.storage.local.set({ tabMap: tabMap }); } catch (e) {}

    } catch (err) {
      console.warn('[FlipRadar][sw] error_processing_search "' + (search.keywords || search.url) + '": ' + (err && err.message ? err.message : err));
      // Continue to next search — never crash the tick loop
    }
  }

  // 3. Serialize Set back to array, cap at 5000
  var seenArr = Array.from(seen);
  if (seenArr.length > 5000) seenArr = seenArr.slice(-5000);

  // Cap alert history at 50
  if (alertHistory.length > 50) alertHistory = alertHistory.slice(-50);

  // Persist
  await chrome.storage.local.set({
    seenIds: seenArr,
priceMap: priceMap,
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
}

// ── Message Listener ────────────────────────────────────
// — Message Listener —
// — Message listener —
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

      if (msg && msg.cmd === 'clearBaselines') {
        // "Baselines" here = tracked scan tabs (tabMap). Clear tabMap and try to close any matching tabs.
        try {
          const data = await chrome.storage.local.get({ tabMap: {} });
          const tabMap = data.tabMap || {};
          const urls = Object.keys(tabMap);

          console.log('[FlipRadar][sw] clearBaselines requested; tabMap_urls=' + urls.length);

          // Query all FB marketplace tabs and close ones that match our stored search URLs
          let closed = 0;
          let attempted = 0;

          const fbTabs = await chrome.tabs.query({ url: ['*://www.facebook.com/marketplace/*'] });

          for (const u of urls) {
            // close any open tab whose URL starts with the stored URL
            const matches = fbTabs.filter(t => (t.url || '').startsWith(u));
            for (const t of matches) {
              attempted++;
              try {
                await chrome.tabs.remove(t.id);
                closed++;
                console.log('[FlipRadar][sw] clearBaselines closed tab ' + t.id + ' url=' + u);
              } catch (e1) {
                console.log('[FlipRadar][sw] clearBaselines could_not_close tab ' + t.id + ' url=' + u);
              }
            }
          }

          // Always clear tabMap even if closing tabs fails
          await chrome.storage.local.set({ tabMap: {} });

          console.log('[FlipRadar][sw] clearBaselines done; attempted=' + attempted + ' closed=' + closed);
          sendResponse({ ok: true, attempted, closed });
          return;
        } catch (e2) {
          console.error('[FlipRadar][sw] clearBaselines error', e2 && e2.stack ? e2.stack : e2);
          // still try to clear tabMap as a failsafe
          try { await chrome.storage.local.set({ tabMap: {} }); } catch (_) {}
          sendResponse({ ok: false, error: String(e2) });
          return;
        }
      }

      sendResponse({ ok: false, error: 'unknown_cmd' });
    } catch (e) {
      console.error('[FlipRadar][sw] msg_error', e && e.stack ? e.stack : e);
      sendResponse({ ok: false, error: String(e) });
    }
  })();

  // Keep the message channel open for async sendResponse
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
    chrome.notifications.onClicked.addListener(function (notifId) {
      console.log('[FlipRadar][sw] notification_clicked: ' + notifId);
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
      const currentInterval = 5;
      if (!existing || existing.periodInMinutes !== currentInterval) {
        chrome.alarms.create('flipradar-check', { periodInMinutes: currentInterval });
        console.log('[FlipRadar][sw] initial alarm created/updated to ' + currentInterval + ' min');
      }
    });
    console.log('[FlipRadar][sw] ready');
  })
  .catch(function (e) {
    console.error('[FlipRadar][sw] boot_error', e);
  });
