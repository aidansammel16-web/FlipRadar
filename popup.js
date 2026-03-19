// popup.js - Strict CSP safe, class-based DOM only

(function() {
  const container = document.createElement('div');
  container.className = 'container';
  document.body.appendChild(container);

  // --- Components ---

  function createEl(tag, className, text) {
    const el = document.createElement(tag);
    if (className) el.className = className;
    if (text) el.textContent = text;
    return el;
  }

  function createHeader() {
    const h1 = createEl('div', 'h1', 'FlipRadar Extension');
    container.appendChild(h1);
  }

  // --- State ---
  let searches = [];
  let settings = { minScore: 2, checkIntervalMin: 5, testMode: false };
  let alertHistory = [];

  // --- Sections ---

  // 1. Add Search Form
  const searchFormSection = createEl('div', 'section');
  
  const formTitle = createEl('div', 'h2', 'Add New Search');
  searchFormSection.appendChild(formTitle);

  const form = createEl('form');
  
  // URL Input
  const urlGroup = createEl('div', 'form-group');
  urlGroup.appendChild(createEl('label', 'label', 'URL (https:// required)'));
  const urlInput = createEl('input', 'input-text');
  urlInput.type = 'url';
  urlInput.placeholder = 'https://example.com/...';
  urlInput.required = true;
  urlGroup.appendChild(urlInput);
  form.appendChild(urlGroup);

  // Price & Keywords (Flex Row)
  const pkRow = createEl('div', 'flex gap-s');
  
  // Max Price
  const priceGroup = createEl('div', 'form-group w-full');
  priceGroup.appendChild(createEl('label', 'label', 'Max Price'));
  const priceInput = createEl('input', 'input-number');
  priceInput.type = 'number';
  priceInput.min = '0';
  priceInput.step = '0.01';
  priceInput.placeholder = 'Any';
  priceGroup.appendChild(priceInput);
  pkRow.appendChild(priceGroup);

  // Keywords
  const kwGroup = createEl('div', 'form-group w-full');
  kwGroup.appendChild(createEl('label', 'label', 'Keywords (opt)'));
  const kwInput = createEl('input', 'input-text');
  kwInput.placeholder = 'vintage, etc.';
  kwGroup.appendChild(kwInput);
  pkRow.appendChild(kwGroup);

  form.appendChild(pkRow);

  // Enabled Checkbox
  const enRow = createEl('div', 'row-check');
  const enInput = createEl('input', 'input-check');
  enInput.type = 'checkbox';
  enInput.checked = true;
  enRow.appendChild(enInput);
  enRow.appendChild(createEl('span', '', 'Active immediately'));
  form.appendChild(enRow);

  // Submit
  const submitBtn = createEl('button', 'btn btn-primary w-full', 'Save Search');
  submitBtn.type = 'button'; 
  form.appendChild(submitBtn);

  searchFormSection.appendChild(form);
  container.appendChild(searchFormSection);

  // 2. Saved Searches List
  const listSection = createEl('div', 'section mt-m');
  listSection.appendChild(createEl('div', 'h2', 'Monitored Searches'));
  const searchesList = createEl('div', 'list');
  listSection.appendChild(searchesList);
  container.appendChild(listSection);

  // 3. Settings
  const settingsSection = createEl('div', 'section mt-m');
  settingsSection.appendChild(createEl('div', 'h2', 'Settings'));
  
  const setRow = createEl('div', 'flex gap-s align-center');
  
  const minScoreGroup = createEl('div', 'form-group');
  minScoreGroup.appendChild(createEl('label', 'label', 'Min Score'));
  const minScoreInput = createEl('input', 'input-number');
  minScoreInput.type = 'number';
  minScoreInput.min = '0';
  minScoreGroup.appendChild(minScoreInput);
  setRow.appendChild(minScoreGroup);

  const intervalGroup = createEl('div', 'form-group');
  intervalGroup.appendChild(createEl('label', 'label', 'Check (min)'));
  const intervalInput = createEl('input', 'input-number');
  intervalInput.type = 'number';
  intervalInput.min = '1';
  intervalGroup.appendChild(intervalInput);
  setRow.appendChild(intervalGroup);

  settingsSection.appendChild(setRow);

  const saveSettingsBtn = createEl('button', 'btn w-full', 'Update Settings');
  settingsSection.appendChild(saveSettingsBtn);
  container.appendChild(settingsSection);

  // 4. Actions
  const actionsSection = createEl('div', 'section mt-m');
  actionsSection.appendChild(createEl('div', 'h2', 'Actions'));
  
  const actRow = createEl('div', 'flex gap-s flex-wrap');
  
  const testTickBtn = createEl('button', 'btn', 'Run Test Tick');
  const resetSeenBtn = createEl('button', 'btn', 'Reset Seen');
  const resetBaseBtn = createEl('button', 'btn', 'Reset Baselines');
  
  const testModeLabel = createEl('label', 'row-check');
  const testModeInput = createEl('input', 'input-check');
  testModeInput.type = 'checkbox';
  testModeLabel.appendChild(testModeInput);
  testModeLabel.appendChild(document.createTextNode('Test Mode'));

  actRow.appendChild(testTickBtn);
  actRow.appendChild(resetSeenBtn);
  actRow.appendChild(resetBaseBtn);
  actRow.appendChild(testModeLabel);
  
  actionsSection.appendChild(actRow);
  container.appendChild(actionsSection);

  // 5. History
  const historySection = createEl('div', 'section mt-m');
  historySection.appendChild(createEl('div', 'h2', 'Last 50 Alerts'));
  const historyList = createEl('div', 'history-list');
  historySection.appendChild(historyList);
  container.appendChild(historySection);


  // --- Logic ---

  function renderSearches() {
    while (searchesList.firstChild) searchesList.removeChild(searchesList.firstChild);
    
    if (searches.length === 0) {
      searchesList.appendChild(createEl('div', 'search-meta', 'No searches configured.'));
      return;
    }

    searches.forEach((s, idx) => {
      const item = createEl('div', 'search-item');
      
      const info = createEl('div', 'search-info');
      const urlDiv = createEl('div', 'search-url', s.url);
      urlDiv.title = s.url;
      info.appendChild(urlDiv);
      
      const metaText = [];
      if (s.maxPrice) metaText.push(`Max: $${s.maxPrice}`);
      if (s.keywords) metaText.push(`Kw: ${s.keywords}`);
      metaText.push(s.enabled ? 'Active' : 'Paused');
      
      info.appendChild(createEl('div', 'search-meta', metaText.join(' • ')));
      item.appendChild(info);

      const controls = createEl('div', 'flex gap-s');
      
      const toggleBtn = createEl('button', 'btn btn-sm', s.enabled ? 'Pause' : 'Resume');
      toggleBtn.addEventListener('click', async () => {
        s.enabled = !s.enabled;
        await saveSearches();
      });
      controls.appendChild(toggleBtn);

      const delBtn = createEl('button', 'btn btn-sm btn-danger', 'X');
      delBtn.addEventListener('click', async () => {
        searches.splice(idx, 1);
        await saveSearches();
      });
      controls.appendChild(delBtn);

      item.appendChild(controls);
      searchesList.appendChild(item);
    });
  }

  function renderHistory() {
    while (historyList.firstChild) historyList.removeChild(historyList.firstChild);
    
    // Show newest first
    const visible = alertHistory.slice().reverse();
    visible.forEach(h => {
      const row = createEl('div', 'history-item');
      if (typeof h === 'string') {
        row.textContent = h;
      } else {
        const time = h.time ? new Date(h.time).toLocaleTimeString() : '??:??';
        const tSpan = createEl('span', 'history-time', time);
        row.appendChild(tSpan);
        row.appendChild(document.createTextNode(h.title || 'Unknown Alert'));
      }
      historyList.appendChild(row);
    });
  }

  function loadData() {
    chrome.storage.local.get(['searches', 'settings', 'alertHistory'], (res) => {
      searches = res.searches || [];
      settings = res.settings || { minScore: 2, checkIntervalMin: 5, testMode: false };
      alertHistory = res.alertHistory || [];

      // Hydrate UI
      renderSearches();
      renderHistory();
      
      minScoreInput.value = (settings.minScore != null ? settings.minScore : 2);
      intervalInput.value = (settings.checkIntervalMin != null ? settings.checkIntervalMin : 5);
      testModeInput.checked = !!settings.testMode;
    });
  }

  function saveSearches() {
    return new Promise((resolve) => {
      chrome.storage.local.set({ searches }, () => {
        renderSearches();
        resolve();
      });
    });
  }
  
  function saveSettings() {
    // IMPORTANT: merge with existing settings so we don't clobber fields
    // set on the Options page (e.g., Telegram token/chatId).
    chrome.storage.local.get(['settings'], (res) => {
      const prev = res.settings || {};
      const merged = {
        ...prev,
        minScore: parseInt(minScoreInput.value, 10) || 0,
        checkIntervalMin: parseInt(intervalInput.value, 10) || 5,
        testMode: testModeInput.checked
      };
      chrome.storage.local.set({ settings: merged }, () => {
        console.log('Settings saved');
      });
    });
  }

  // Event Listeners

  submitBtn.addEventListener('click', async () => {
    const url = urlInput.value.trim();
    if (!url || !url.startsWith('https://')) {
      alert('Valid HTTPS URL required');
      return;
    }

    searches.push({
      url: url,
      maxPrice: priceInput.value ? parseFloat(priceInput.value) : null,
      keywords: kwInput.value.trim() || null,
      enabled: enInput.checked
    });
    
    // Clear form
    urlInput.value = '';
    priceInput.value = '';
    kwInput.value = '';
    
    await saveSearches();
  });

  saveSettingsBtn.addEventListener('click', saveSettings);
  
  testModeInput.addEventListener('change', () => {
    // Auto-save on toggle? strict req says "Test Mode toggle", implicit save is better UX
    saveSettings();
  });

  resetBaseBtn.addEventListener('click', function() {
    chrome.runtime.sendMessage({ cmd: 'clearBaselines' }, function(resp) {
      if (resp && resp.ok) alert('Baselines cleared. Next tick will re-baseline.');
      else alert('Failed to clear baselines.');
    });
  });

  resetSeenBtn.addEventListener('click', () => {
    chrome.runtime.sendMessage({ cmd: 'clearSeen' }, function(resp) {
      if (resp && resp.ok) alert('Seen items reset.');
      else alert('Failed to reset seen items.');
    });
  });

  testTickBtn.addEventListener('click', () => {
    chrome.runtime.sendMessage({ cmd: 'tick' }, (response) => {
      if (chrome.runtime.lastError) {
        console.error(chrome.runtime.lastError);
        alert('Tick error: ' + chrome.runtime.lastError.message);
        return;
      }
      
      if (response && response.ok) {
        const count = response.newAlerts || 0;
        
        if (count > 0) {
          // Append placeholder alerts as requested
          const placeholders = [];
          for (let i = 0; i < count; i++) {
            placeholders.push({
              title: `Mock Alert #${i + 1}`,
              price: null,
              time: new Date().toISOString()
            });
          }
          
          // Re-fetch history to ensure we append to latest state if concurrent
          chrome.storage.local.get(['alertHistory'], (res) => {
            const current = res.alertHistory || [];
            const updated = current.concat(placeholders).slice(-50);
            
            chrome.storage.local.set({ alertHistory: updated }, () => {
              alertHistory = updated;
              renderHistory();
              // alert(`Tick done. ${count} new alerts generated.`);
            });
          });
        } else {
          // alert('Tick done. No new alerts.');
        }
      } else {
        alert('Tick failed or unknown response.');
      }
    });
  });

  // Initial structure build
  createHeader();

  // ── Options page link (auto-injected) ──
  var optionsLink = createEl('div', 'section mt-m');
  var optBtn = createEl('button', 'btn w-full', 'Open Full Settings');
  optBtn.addEventListener('click', function () {
    if (chrome.runtime.openOptionsPage) {
      chrome.runtime.openOptionsPage();
    }
  });
  optionsLink.appendChild(optBtn);
  container.appendChild(optionsLink);
  loadData();

})();


// Keep UI in sync if options/settings change elsewhere
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  if (changes.settings) { try { loadSettings(); } catch (e) {} }
  if (changes.searches) { try { loadSearches(); } catch (e) {} }
});
