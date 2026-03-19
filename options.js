(function () {
  // Existing elements (legacy UI)
  var nCheck = document.getElementById("notifEnabled");
  var sList = document.getElementById("searchesList");
  var uIn = document.getElementById("newUrl");
  var kIn = document.getElementById("newKeywords");
  var pIn = document.getElementById("newMaxPrice");
  var addBtn = document.getElementById("addSearch");
  var status = document.getElementById("status");
  var tgTokenEl = document.getElementById("tgToken");
  var tgChatEl = document.getElementById("tgChat");

  // Newer options.html (your screenshot) uses these fields:
  // - Check interval (min)
  // - Min alert score
  // plus a "Save Settings" button.
  // We locate them defensively so this works across layouts.
  function q(sel) { try { return document.querySelector(sel); } catch (e) { return null; } }

  var minScoreEl =
    document.getElementById("minScore") ||
    document.getElementById("minAlertScore") ||
    q('input[name="minScore"]') ||
    q('input[placeholder*="Min alert score"]') ||
    q('input[aria-label*="Min alert score"]');

  var intervalEl =
    document.getElementById("checkIntervalMin") ||
    document.getElementById("checkInterval") ||
    q('input[name="checkIntervalMin"]') ||
    q('input[placeholder*="Check interval"]') ||
    q('input[aria-label*="Check interval"]');

  var saveBtn =
    document.getElementById("saveSettings") ||
    q('button#saveSettingsBtn') ||
    q('button[data-action="saveSettings"]') ||
    q('button');

  function setStatus(msg) {
    if (!status) return;
    status.textContent = msg;
    setTimeout(function(){ status.textContent = ""; }, 2000);
  }

  function load() {
    chrome.storage.local.get(["searches", "settings"], function (res) {
      // Searches
      var ss = res.searches || [];
      renderSearches(ss);

      // Settings
      var set = res.settings || {};
      if (nCheck) nCheck.checked = (set.notificationsEnabled !== false);
      if (tgTokenEl) tgTokenEl.value = set.telegramBotToken || '';
      if (tgChatEl) tgChatEl.value = set.telegramChatId || '';

      if (minScoreEl) minScoreEl.value = (set.minScore != null ? set.minScore : 2);
      if (intervalEl) intervalEl.value = (set.checkIntervalMin != null ? set.checkIntervalMin : 5);
    });
  }

  function renderSearches(arr) {
    if (!sList) return;
    while (sList.firstChild) sList.removeChild(sList.firstChild);
    if (!arr || arr.length === 0) {
      var d = document.createElement("div"); d.textContent = "No searches configured.";
      sList.appendChild(d);
      return;
    }
    arr.forEach(function (s, i) {
      var row = document.createElement("div"); row.style.marginBottom = "8px";
      var txt = document.createElement("span"); txt.textContent = s.url + (s.keywords ? " ["+s.keywords+"]" : "");
      var del = document.createElement("button"); del.textContent = "Del"; del.style.marginLeft = "8px";
      del.onclick = function () {
        arr.splice(i, 1);
        chrome.storage.local.set({ searches: arr }, load);
      };
      row.appendChild(txt); row.appendChild(del); sList.appendChild(row);
    });
  }

  function addS() {
    var u = uIn && uIn.value ? uIn.value.trim() : '';
    if (!u) return alert("URL required");
    if (!u.startsWith("https://")) return alert("HTTPS required");
    var k = kIn ? kIn.value.trim() : null;
    var p = pIn ? parseFloat(pIn.value) : null;
    chrome.storage.local.get(["searches"], function (c) {
      var arr = c.searches || [];
      arr.push({ url: u, keywords: k, maxPrice: p, enabled: true });
      chrome.storage.local.set({ searches: arr }, function () {
        if (uIn) uIn.value = "";
        if (kIn) kIn.value = "";
        if (pIn) pIn.value = "";
        load();
      });
    });
  }

  if (addBtn) addBtn.onclick = addS;

  if (nCheck) {
    nCheck.onchange = function () {
      chrome.storage.local.get(["settings"], function (c) {
        var s = c.settings || {};
        s.notificationsEnabled = nCheck.checked;
        chrome.storage.local.set({ settings: s });
      });
    };
  }

  function saveSettings() {
    chrome.storage.local.get(['settings'], function(c){
      var prev = c.settings || {};
      var merged = Object.assign({}, prev);

      // telegram
      if (tgTokenEl) merged.telegramBotToken = tgTokenEl.value.trim();
      if (tgChatEl) merged.telegramChatId = tgChatEl.value.trim();

      // scanner settings
      if (minScoreEl) {
        var v = parseInt(minScoreEl.value, 10);
        if (!Number.isNaN(v)) merged.minScore = v;
      }
      if (intervalEl) {
        var v2 = parseInt(intervalEl.value, 10);
        if (!Number.isNaN(v2)) merged.checkIntervalMin = v2;
      }

      chrome.storage.local.set({ settings: merged }, function(){
        var err = chrome.runtime && chrome.runtime.lastError;
        if (err) {
          console.warn('options saveSettings lastError:', err);
          setStatus('Save failed');
        } else {
          setStatus('Saved');
        }
      });
    });
  }

  // Save on explicit button if present, else on change of fields
  if (saveBtn) {
    saveBtn.addEventListener('click', function(e){
      // avoid grabbing "Clear Seen History" etc by ensuring button text contains Save
      try {
        var t = (saveBtn.textContent || '').toLowerCase();
        if (t.includes('save')) saveSettings();
      } catch(e2){ saveSettings(); }
    });
  }
  if (minScoreEl) minScoreEl.addEventListener('change', saveSettings);
  if (intervalEl) intervalEl.addEventListener('change', saveSettings);

  // Save Telegram settings on change
  function saveTg() { saveSettings(); }
  if (tgTokenEl) tgTokenEl.addEventListener('change', saveTg);
  if (tgChatEl) tgChatEl.addEventListener('change', saveTg);

  load();
})();

// Live update when popup changes settings
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  if (changes.settings) { try { loadSettings(); } catch (e) {} }
});
