
(() => {
  'use strict';

  function absUrl(href) {
    if (!href) return '';
    if (href.startsWith('http')) return href;
    if (href.startsWith('/')) return 'https://www.facebook.com' + href;
    return href;
  }

  function clean(s) {
    return (s || '').replace(/\s+/g, ' ').trim();
  }

  function extractId(url) {
    const m = (url || '').match(/\/marketplace\/item\/(\d+)/);
    return m ? m[1] : null;
  }

  function parsePrice(text) {
    // Matches $700, CA$700, $ 700, 700$
    const t = (text || '').replace(/\u00A0/g, ' ');
    const m = t.match(/(?:CA?\$|\$)\s*([\d,.]+)/i) || t.match(/([\d,.]+)\s*\$/);
    if (!m) return null;
    const num = Number(String(m[1]).replace(/,/g, ''));
    return Number.isFinite(num) ? num : null;
  }

  function bestText(el) {
    if (!el) return '';
    const aria = el.getAttribute && el.getAttribute('aria-label');
    if (aria) return clean(aria);
    return clean(el.textContent || '');
  }

  function scanListings(max = 120) {
    const anchors = Array.from(document.querySelectorAll('a[href*="/marketplace/item/"]'));
    const seen = new Set();
    const out = [];

    for (const a of anchors) {
      const href = absUrl(a.getAttribute('href') || '');
      if (!href) continue;

      // De-dupe on item id if possible, otherwise url
      const id = extractId(href);
      const key = id || href;
      if (seen.has(key)) continue;
      seen.add(key);

      // Title: prefer aria-label on anchor; otherwise nearest role="link" wrapper text
      let title = bestText(a);
      if (!title || title.length < 3) {
        const wrap = a.closest('[role="link"], [role="article"]') || a.parentElement;
        title = bestText(wrap);
      }

      // Price: search within the card container first
      let price = null;
      const card = a.closest('[role="article"], [data-pagelet], div') || a.parentElement;
      if (card) {
        // Grab a chunk of text and parse a currency looking value
        const chunk = clean(card.textContent || '');
        price = parsePrice(chunk);
      }

      out.push({
        id: id,
        url: href,
        title: title || '(no title)',
        price: price
      });

      if (out.length >= max) break;
    }

    return out;
  }

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg && msg.cmd === 'scan_listings') {
      try {
        const listings = scanListings(msg.max || 120);
        sendResponse({ ok: true, listings });
      } catch (e) {
        sendResponse({ ok: false, error: String(e), listings: [] });
      }
    }
    return false;
  });
})();
