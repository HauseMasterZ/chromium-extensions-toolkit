importScripts('clearurls-engine.js');

let clearUrlsData = null;
let shortenersSet = new Set();
const cssMemoryCache = new Map();
const unshortenCache = new Map();

// Load ClearURLs rules with 3-tier fallback
async function initClearUrlsRules() {
  try {
    const { cachedClearUrlsRules } = await chrome.storage.local.get('cachedClearUrlsRules');
    if (cachedClearUrlsRules?.providers) {
      clearUrlsData = cachedClearUrlsRules;
      return;
    }
  } catch {}

  try {
    const res = await fetch(chrome.runtime.getURL('clearurls-rules.json'));
    clearUrlsData = await res.json();
  } catch (e) {
    console.error('Failed to load bundled clearurls rules:', e);
  }
}

// Load Shortener Domains with 3-tier fallback
async function initShortenersList() {
  try {
    const { cachedShortenersList } = await chrome.storage.local.get('cachedShortenersList');
    if (Array.isArray(cachedShortenersList) && cachedShortenersList.length > 0) {
      shortenersSet = new Set(cachedShortenersList);
      return;
    }
  } catch {}

  try {
    const res = await fetch(chrome.runtime.getURL('shorteners-rules.json'));
    const list = await res.json();
    if (Array.isArray(list)) {
      shortenersSet = new Set(list);
      await chrome.storage.local.set({ cachedShortenersList: list });
    }
  } catch (e) {
    console.error('Failed to load bundled shorteners list:', e);
  }
}

// Fetch live rules from GitHub
async function syncRemoteClearUrlsRules() {
  const REMOTE_URL = 'https://raw.githubusercontent.com/HauseMasterZ/chromium-extensions-toolkit/main/Toolkit/clearurls-rules.json';
  try {
    const res = await fetch(REMOTE_URL, { cache: 'no-cache' });
    if (!res.ok) return;
    const data = await res.json();
    if (data?.providers && data?.globalRules) {
      clearUrlsData = data;
      await chrome.storage.local.set({ cachedClearUrlsRules: data, lastRulesSyncTime: Date.now() });
    }
  } catch {}
}

// Fetch live shorteners & clickthroughs (Repo Mirror 40k+ Dataset -> HaGeZi/AdGuard Upstream Fallback)
async function syncRemoteShortenersList() {
  const REPO_URL = 'https://raw.githubusercontent.com/HauseMasterZ/chromium-extensions-toolkit/main/Toolkit/shorteners-rules.json';
  const HAGEZI_URL = 'https://raw.githubusercontent.com/hagezi/dns-blocklists/main/wildcard/urlshortener-onlydomains.txt';

  try {
    // Primary: Pre-compiled merged dataset (HaGeZi + AdGuard CNAME clickthroughs)
    const res = await fetch(REPO_URL, { cache: 'no-cache' });
    if (res.ok) {
      const jsonList = await res.json();
      if (Array.isArray(jsonList) && jsonList.length > 5000) {
        shortenersSet = new Set(jsonList);
        await chrome.storage.local.set({ cachedShortenersList: jsonList, lastShortenersSyncTime: Date.now() });
        return;
      }
    }
  } catch {}

  try {
    // Secondary fallback: Direct HaGeZi upstream
    const res = await fetch(HAGEZI_URL, { cache: 'no-cache' });
    if (res.ok) {
      const text = await res.text();
      const list = text.split(/\r?\n/).map(s => s.trim().toLowerCase()).filter(s => s && !s.startsWith('#'));
      if (list.length > 500) {
        shortenersSet = new Set(list);
        await chrome.storage.local.set({ cachedShortenersList: list, lastShortenersSyncTime: Date.now() });
      }
    }
  } catch {}
}

initClearUrlsRules();
initShortenersList();
syncRemoteClearUrlsRules();
syncRemoteShortenersList();

chrome.alarms.create('sync_clearurls_alarm', { periodInMinutes: 1440 });
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'sync_clearurls_alarm') {
    syncRemoteClearUrlsRules();
    syncRemoteShortenersList();
  }
});

async function getActiveTab() {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  return tabs && tabs.length > 0 ? tabs[0] : null;
}

function openTarget(targetUrl, isExtensionPage, tabId) {
  if (isExtensionPage && tabId) chrome.tabs.update(tabId, { url: targetUrl });
  else chrome.tabs.create({ url: targetUrl });
}

function showPillToast(tabId, message, durationMs = 1200) {
  if (!tabId) return;
  chrome.scripting.executeScript({
    target: { tabId },
    func: (text, duration) => {
      const existing = document.getElementById('toolkit-pill-toast');
      if (existing) existing.remove();
      const toast = document.createElement('div');
      toast.id = 'toolkit-pill-toast';
      toast.style.cssText = `
        position: fixed !important;
        top: 16px !important;
        left: 50% !important;
        transform: translateX(-50%) translateY(-6px) !important;
        background: rgba(18, 18, 22, 0.9) !important;
        backdrop-filter: blur(10px) !important;
        -webkit-backdrop-filter: blur(10px) !important;
        color: #e2e8f0 !important;
        border: 1px solid rgba(255, 255, 255, 0.1) !important;
        border-radius: 9999px !important;
        padding: 6px 14px !important;
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif !important;
        font-size: 12px !important;
        font-weight: 500 !important;
        box-shadow: 0 4px 16px rgba(0, 0, 0, 0.4) !important;
        z-index: 2147483647 !important;
        display: flex !important;
        align-items: center !important;
        opacity: 0 !important;
        transition: all 0.18s ease-out !important;
        pointer-events: none !important;
      `;
      toast.textContent = text;
      (document.body || document.documentElement).appendChild(toast);
      requestAnimationFrame(() => {
        toast.style.opacity = '1';
        toast.style.transform = 'translateX(-50%) translateY(0)';
      });
      setTimeout(() => {
        toast.style.opacity = '0';
        toast.style.transform = 'translateX(-50%) translateY(-6px)';
        setTimeout(() => toast.remove(), 200);
      }, duration);
    },
    args: [message, durationMs]
  }).catch(() => {});
}

chrome.commands.onCommand.addListener(async c => {
  const tab = await getActiveTab();

  if (c === 'duplicate_tab') {
    if (tab?.id) chrome.tabs.duplicate(tab.id);
    return;
  }
  
  if (c === 'toggle_dark_mode') {
    if (tab?.id) toggleDarkMode(tab.id);
    return;
  }
  
  if (c === 'close_other_tabs') {
    if (!tab) return;
    const allTabs = await chrome.tabs.query({});
    const windows = {};
    for (const t of allTabs) {
      (windows[t.windowId] = windows[t.windowId] || []).push(t.id);
    }

    for (const [winIdStr, tabIds] of Object.entries(windows)) {
      const winId = Number(winIdStr);
      if (winId === tab.windowId) {
        const toRemove = tabIds.filter(id => id !== tab.id);
        if (toRemove.length) await chrome.tabs.remove(toRemove);
      } else {
        await chrome.tabs.create({ windowId: winId });
        await chrome.tabs.remove(tabIds);
      }
    }
    return;
  }

  if (c === 'close_all_windows') {
    // Show immediate visual loading hint on the active tab
    if (tab?.id) {
      chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: () => {
          if (document.getElementById('toolkit-cleaning-overlay')) return;
          const overlay = document.createElement('div');
          overlay.id = 'toolkit-cleaning-overlay';
          overlay.style.cssText = `
            position: fixed !important;
            top: 0 !important;
            left: 0 !important;
            width: 100vw !important;
            height: 100vh !important;
            background: rgba(10, 10, 15, 0.75) !important;
            backdrop-filter: blur(12px) !important;
            -webkit-backdrop-filter: blur(12px) !important;
            z-index: 2147483647 !important;
            display: flex !important;
            align-items: center !important;
            justify-content: center !important;
            opacity: 0 !important;
            transition: opacity 0.15s ease-out !important;
            pointer-events: all !important;
            font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif !important;
          `;

          overlay.innerHTML = `
            <div style="
              background: #1e1e24;
              border: 1px solid rgba(255, 255, 255, 0.12);
              box-shadow: 0 16px 40px rgba(0, 0, 0, 0.6);
              border-radius: 20px;
              padding: 24px 32px;
              display: flex;
              flex-direction: column;
              align-items: center;
              gap: 14px;
              color: #f1f3f5;
              transform: scale(0.92);
              transition: transform 0.18s cubic-bezier(0.1, 0.9, 0.2, 1);
            " id="toolkit-cleaning-card">
              <div style="
                width: 32px;
                height: 32px;
                border: 3.5px solid rgba(59, 130, 246, 0.2);
                border-top-color: #3b82f6;
                border-radius: 50%;
                animation: toolkitSpin 0.75s linear infinite;
              "></div>
              <div style="text-align: center;">
                <div style="font-size: 14.5px; font-weight: 600; letter-spacing: -0.2px;">Clearing Data &amp; Closing...</div>
                <div style="font-size: 11.5px; color: #9ca3af; margin-top: 3px;">Flushing caches &amp; preserving persistent sessions</div>
              </div>
            </div>
            <style>
              @keyframes toolkitSpin { to { transform: rotate(360deg); } }
            </style>
          `;

          (document.body || document.documentElement).appendChild(overlay);
          requestAnimationFrame(() => {
            overlay.style.opacity = '1';
            const card = document.getElementById('toolkit-cleaning-card');
            if (card) card.style.transform = 'scale(1)';
          });
        }
      }).catch(() => {});
    }

    const { persisted_origins = [] } = await chrome.storage.local.get('persisted_origins');
    const dynamicPersistedSet = new Set(persisted_origins);
    dynamicPersistedSet.add('https://hausemasterz.github.io');

    const allTabs = await chrome.tabs.query({});
    const probePromises = allTabs.map(async (t) => {
      if (!t.url || !t.url.startsWith('http') || !t.id) return;
      const origin = new URL(t.url).origin;

      // Skip discarded/sleeping tabs to prevent multi-second forced page reloads
      if (t.discarded) return;

      try {
        const probeTask = chrome.scripting.executeScript({
          target: { tabId: t.id },
          func: async () => {
            const detectedOrigins = [];
            let isCritical = false;

            try {
              // Method 1: In-Memory CORS Resource Timing Harvest
              const entries = performance.getEntriesByType('resource') || [];
              for (const entry of entries) {
                if (!entry.name || !entry.name.startsWith('http')) continue;
                try {
                  const url = new URL(entry.name);
                  if (url.origin !== window.location.origin) {
                    if (/(accounts|auth|login|oauth|idp|sso|session|token|api)\./i.test(url.hostname) ||
                        /(oauth|token|auth|session|rotatecookies)/i.test(url.pathname)) {
                      detectedOrigins.push(url.origin);
                    }
                  }
                } catch {}
              }

              // Tier 1 (Synchronous & Instant): Valid Cryptographic JWT / Auth Token Inspection
              const jwtRegex = /^[A-Za-z0-9-_=]{15,}\.[A-Za-z0-9-_=]{15,}\.?[A-Za-z0-9-_.+/=]*$/;
              const authKeyPattern = /(token|auth|session|master_key|cipher|credentials|supabase\.auth|firebase:authUser)/i;
              const analyticsPattern = /^(_ga|_gid|amp|criteo|ajs_|cookie|theme|volume|banner|popup|sidebar)/i;

              for (let i = 0; i < localStorage.length; i++) {
                const key = localStorage.key(i);
                if (!key || analyticsPattern.test(key)) continue;
                const val = localStorage.getItem(key);
                if (!val || val.length < 20) continue;

                if (jwtRegex.test(val) || (authKeyPattern.test(key) && val.length >= 24)) {
                  isCritical = true;
                  break;
                }
              }

              if (!isCritical) {
                for (let i = 0; i < sessionStorage.length; i++) {
                  const key = sessionStorage.key(i);
                  if (!key || analyticsPattern.test(key)) continue;
                  const val = sessionStorage.getItem(key);
                  if (!val || val.length < 20) continue;

                  if (jwtRegex.test(val) || (authKeyPattern.test(key) && val.length >= 24)) {
                    isCritical = true;
                    break;
                  }
                }
              }

              // Tier 2: Substantial Named Databases (IndexedDB)
              if (!isCritical && window.indexedDB?.databases) {
                const dbs = await window.indexedDB.databases();
                const realDbs = dbs.filter(d => d.name && !/^(_ga|firebase-heartbeat|google-analytics)/i.test(d.name));
                if (realDbs.length >= 2 || realDbs.some(d => /(notesnook|discord|slack|notion|vault|state|auth|session|localforage|matrix|rxdb)/i.test(d.name))) {
                  isCritical = true;
                }
              }

              // Tier 3: Persistent Storage Flag
              if (!isCritical && navigator.storage?.persisted && await navigator.storage.persisted()) {
                isCritical = true;
              }
            } catch {}

            return { isCritical, corsOrigins: detectedOrigins };
          }
        });

        const timeoutPromise = new Promise(resolve => setTimeout(() => resolve(null), 1000));
        const probeRes = await Promise.race([probeTask, timeoutPromise]);
        const res = probeRes?.[0]?.result;

        if (res?.isCritical) {
          dynamicPersistedSet.add(origin);
        }
        if (res?.corsOrigins?.length) {
          for (const co of res.corsOrigins) {
            dynamicPersistedSet.add(co);
          }
        }
      } catch {}
    });

    await Promise.allSettled(probePromises);
    const finalExcludedList = Array.from(dynamicPersistedSet);
    await chrome.storage.local.set({ persisted_origins: finalExcludedList });

    await Promise.all([
      new Promise(resolve => {
        chrome.browsingData.remove({ since: 0 }, {
          history: true,
          downloads: true,
          formData: true
        }, resolve);
      }),
      new Promise(resolve => {
        const removalOptions = { since: 0 };
        if (finalExcludedList.length > 0) {
          removalOptions.excludeOrigins = finalExcludedList;
        }
        chrome.browsingData.remove(removalOptions, {
          cache: true,
          cacheStorage: true,
          fileSystems: true,
          indexedDB: true,
          localStorage: true,
          serviceWorkers: true,
          webSQL: true,
          pluginData: true
        }, resolve);
      })
    ]);

    const windows = await chrome.windows.getAll();
    for (const w of windows) chrome.windows.remove(w.id);
    return;
  }

  if (c === 'copy_clean_url') {
    if (tab?.id && tab.url) {
      try {
        const cleanUrl = clearUrlsData ? cleanUrlWithClearUrls(tab.url, clearUrlsData) : tab.url;
        await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          func: (url) => navigator.clipboard.writeText(url),
          args: [cleanUrl]
        });
        showPillToast(tab.id, 'Clean URL copied', 1200);
      } catch {}
    }
    return;
  }

  if (c === 'discard_background_tabs') {
    const isNewTab = (url) => !url || url.includes('newtab-page.html') || url === 'chrome://newtab/' || url === 'helium://newtab/' || url === 'about:blank' || url === 'about:newtab';

    const allTabs = await chrome.tabs.query({});
    
    // Group tabs by windowId
    const windowsMap = new Map();
    for (const t of allTabs) {
      if (!windowsMap.has(t.windowId)) {
        windowsMap.set(t.windowId, []);
      }
      windowsMap.get(t.windowId).push(t);
    }

    // For every window whose active view is NOT an empty new tab:
    // If an existing new tab is already open in that window, focus it; otherwise create one.
    for (const [winId, wTabs] of windowsMap) {
      const activeTab = wTabs.find(t => t.active);
      if (!activeTab || isNewTab(activeTab.url)) continue;

      const existingNewTab = wTabs.find(t => isNewTab(t.url));
      if (existingNewTab?.id) {
        try {
          await chrome.tabs.update(existingNewTab.id, { active: true });
        } catch {}
      } else {
        try {
          await chrome.tabs.create({ windowId: winId, active: true });
        } catch {}
      }
    }

    // Full sweep discard across all windows and monitors (including helium://, chrome://, and all web pages)
    const refreshedTabs = await chrome.tabs.query({});
    const tabsToDiscard = refreshedTabs.filter(t => t.id && !t.active && !t.discarded && !isNewTab(t.url));

    const discardResults = await Promise.allSettled(
      tabsToDiscard.map(t => chrome.tabs.discard(t.id))
    );

    const discardedCount = discardResults.filter(r => r.status === 'fulfilled' && r.value && r.value.discarded).length;
    showPillToast(tab?.id, discardedCount > 0 ? `Slept ${discardedCount} tab${discardedCount === 1 ? '' : 's'}` : 'Background tabs already asleep', 1500);
    return;
  }

  if (c === 'price_history') {
    if (tab?.id && tab.url) {
      const cleanUrl = clearUrlsData ? cleanUrlWithClearUrls(tab.url, clearUrlsData) : tab.url;
      try {
        await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          func: (url) => navigator.clipboard.writeText(url),
          args: [cleanUrl]
        });
      } catch {}

      const buyhatkeUrl = `https://buyhatke.com/${cleanUrl}`;
      const priceHistoryUrl = `https://pricehistory.app/?search=${encodeURIComponent(cleanUrl)}`;

      await chrome.tabs.create({ url: buyhatkeUrl, index: tab.index + 1 });
      await chrome.tabs.create({ url: priceHistoryUrl, index: tab.index + 2 });
    }
    return;
  }

  if (c === 'restore_last_closed_window') {
    try {
      const recentlyClosed = await chrome.sessions.getRecentlyClosed({ maxResults: 25 });
      const lastClosedWindow = recentlyClosed.find(s => s.window);
      if (lastClosedWindow?.window?.sessionId) {
        await chrome.sessions.restore(lastClosedWindow.window.sessionId);
      } else {
        await chrome.sessions.restore();
      }
    } catch (e) {
      console.error('Failed to restore window:', e);
    }
    return;
  }

  if (!['run', 'run_yt', 'run_incognito'].includes(c) || !tab?.id) return;
  const { featurePasteGo = true } = await chrome.storage.local.get('featurePasteGo');
  if (!featurePasteGo) return;
  
  try {
    let result = null;
    let isExtensionPage = false;

    try {
      const res = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: () => navigator.clipboard.readText() });
      result = res?.[0]?.result ?? null;
    } catch {
      isExtensionPage = true;
      try {
        result = await chrome.tabs.sendMessage(tab.id, { action: 'read_clipboard' });
      } catch {}
    }

    if (!result) return;
    result = result.trim();
    const isUrl = /^https?:\/\//i.test(result);

    if (c === 'run') {
      const finalUrl = isUrl ? result : `https://google.com/search?q=${encodeURIComponent(result)}`;
      openTarget(finalUrl, isExtensionPage, tab.id);
    } else if (c === 'run_yt') {
      openTarget(`https://www.youtube.com/results?search_query=${encodeURIComponent(result)}`, isExtensionPage, tab.id);
    } else if (c === 'run_incognito') {
      const targetUrl = isUrl ? result : `https://google.com/search?q=${encodeURIComponent(result)}`;
      const windows = await chrome.windows.getAll();
      const incognitoWin = windows.find(w => w.incognito);
      if (incognitoWin) {
        chrome.tabs.create({ windowId: incognitoWin.id, url: targetUrl });
        chrome.windows.update(incognitoWin.id, { focused: true });
      } else {
        chrome.windows.create({ url: targetUrl, incognito: true });
      }
    }
  } catch {}
});

// Dynamic Script Registration Helper
async function syncContentScripts(id, enabled, configs) {
  const ids = Array.isArray(id) ? id : [id];
  try {
    const existing = await chrome.scripting.getRegisteredContentScripts();
    const toRemove = existing.map(s => s.id).filter(sId => ids.includes(sId));
    if (toRemove.length) {
      await chrome.scripting.unregisterContentScripts({ ids: toRemove });
    }
  } catch {}
  if (enabled && configs?.length) {
    try { await chrome.scripting.registerContentScripts(configs); } catch (e) { console.error(`Script registration failed [${id}]:`, e); }
  }
}

const updateYtMusicScript = (enabled) => syncContentScripts('yt-music-audio', enabled, [{
  id: 'yt-music-audio',
  matches: ['*://music.youtube.com/*'],
  js: ['yt-music-audio.js'],
  runAt: 'document_idle',
  world: 'MAIN'
}]);

const updateYtFloatSearchScript = (enabled) => syncContentScripts('yt-float-search', enabled, [{
  id: 'yt-float-search',
  matches: ['https://www.youtube.com/*', 'https://m.youtube.com/*'],
  js: ['yt-float-search.js'],
  css: ['yt-float-search.css'],
  runAt: 'document_idle'
}]);

const updateWhatsappScript = (enabled) => syncContentScripts(['whatsapp-virtual-camera', 'whatsapp-wide-style'], enabled, [
  {
    id: 'whatsapp-virtual-camera',
    matches: ['*://web.whatsapp.com/*', 'https://web.whatsapp.com/*'],
    js: ['whatsapp-virtual-camera.js'],
    runAt: 'document_idle',
    world: 'MAIN'
  },
  {
    id: 'whatsapp-wide-style',
    matches: ['*://web.whatsapp.com/*', 'https://web.whatsapp.com/*'],
    js: ['whatsapp-wide-style.js'],
    runAt: 'document_idle'
  }
]);

chrome.runtime.onInstalled.addListener(async () => {
  try {
    const existing = await chrome.scripting.getRegisteredContentScripts();
    const legacy = existing.map(s => s.id).filter(id => id === 'custom-seek');
    if (legacy.length) await chrome.scripting.unregisterContentScripts({ ids: legacy });
  } catch {}

  chrome.storage.local.get({ featureYtMusic: true, featureYtFloatSearch: true, featureWhatsapp: true }, (res) => {
    updateYtMusicScript(res.featureYtMusic);
    updateYtFloatSearchScript(res.featureYtFloatSearch);
    updateWhatsappScript(res.featureWhatsapp);
  });
  rehydrateDarkScripts();
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  switch (msg.action) {
    case 'updateYtMusicScript':
      updateYtMusicScript(msg.enabled);
      break;
    case 'updateYtFloatSearchScript':
      updateYtFloatSearchScript(msg.enabled);
      break;
    case 'updateWhatsappScript':
      updateWhatsappScript(msg.enabled);
      break;
    case 'toggleDarkMode':
      if (msg.tabId) toggleDarkMode(msg.tabId);
      break;
    case 'fetchCSS':
      if (!msg.url || !/^https?:\/\//i.test(msg.url)) {
        sendResponse({ text: '' });
        return false;
      }
      if (cssMemoryCache.has(msg.url)) {
        sendResponse({ text: cssMemoryCache.get(msg.url) });
        return false;
      }
      fetch(msg.url, { cache: 'force-cache' })
        .then(res => res.ok ? res.text() : '')
        .then(text => {
          if (text && text.length < 1000000) {
            if (cssMemoryCache.size > 250) cssMemoryCache.delete(cssMemoryCache.keys().next().value);
            cssMemoryCache.set(msg.url, text);
          }
          sendResponse({ text: text || '' });
        })
        .catch(() => sendResponse({ text: '' }));
      return true;
    case 'unshortenUrl':
      if (!msg.url) {
        sendResponse({ success: false });
        return false;
      }
      resolveAndCleanShortUrl(msg.url).then(cleanUrl => {
        sendResponse({ success: Boolean(cleanUrl), cleanUrl: cleanUrl || msg.url });
      }).catch(() => sendResponse({ success: false, cleanUrl: msg.url }));
      return true;
    case 'openUnshortenedTab':
      if (!msg.url) {
        sendResponse({ success: false });
        return false;
      }
      resolveAndCleanShortUrl(msg.url).then(cleanUrl => {
        const urlToOpen = cleanUrl || msg.url;
        const createProps = { url: urlToOpen, active: false };
        if (sender.tab?.id) {
          createProps.index = sender.tab.index + 1;
          createProps.openerTabId = sender.tab.id;
        }
        chrome.tabs.create(createProps);
        sendResponse({ success: true, cleanUrl: urlToOpen });
      }).catch(() => {
        chrome.tabs.create({ url: msg.url, active: false });
        sendResponse({ success: false });
      });
      return true;
  }
});

function unwrapGatewayUrl(rawUrl) {
  if (!rawUrl) return null;
  try {
    const parsed = new URL(rawUrl);
    const paramNames = ['q', 'url', 'dest', 'destination', 'target', 'u', 'redirect_uri', 'r', 'z', 'link'];
    for (const p of paramNames) {
      const val = parsed.searchParams.get(p);
      if (val && /^https?:\/\//i.test(val)) {
        return val;
      }
    }
  } catch {}
  return null;
}

function isShortenerUrl(urlStr) {
  try {
    const url = new URL(urlStr);
    const host = url.hostname.toLowerCase().replace(/^www\./, '');
    const pathname = url.pathname;

    if (shortenersSet.has(host)) return true;

    const knownShorteners = new Set([
      'bit.ly', 't.co', 'tinyurl.com', 'is.gd', 'v.gd', 'amzn.to', 'buff.ly', 'ow.ly',
      'goo.gl', 'qr.ae', 'cutt.ly', 'rb.gy', 'shorturl.at', 'ift.tt', 'trib.al',
      'rebrand.ly', 'lnkd.in', 'linktr.ee', 'rotf.lol', 'tiny.cc', 'lmg.gg', 'redd.it',
      'spoti.fi', 'apple.co', 'w.wiki', 'wapo.st', 'nyti.ms', 'bit.do', 'shorte.st',
      'geni.us', 'a.co', 'snip.ly', 'snip.li', 't.ly', 'dub.sh', 'snip.to', 's.id'
    ]);
    if (knownShorteners.has(host)) return true;

    const shortTlds = /\.(gg|ly|to|co|is|gd|cc|link|me|click|fi|ms|it|st|app|bio|us|sh|io|so|at|am|ws|nu|ee|ai|xyz|site)$/i;
    if (host.length <= 14 && shortTlds.test(host) && /^\/[a-zA-Z0-9_\-\.]{1,25}\/?$/.test(pathname)) {
      return true;
    }
  } catch {}
  return false;
}

async function resolveAndCleanShortUrl(rawUrl) {
  if (!rawUrl || !/^https?:\/\//i.test(rawUrl)) return null;
  if (unshortenCache.has(rawUrl)) return unshortenCache.get(rawUrl);

  try {
    let currentUrl = rawUrl;
    
    // Step 1: Unwrap outer platform gateway (YouTube, Google, Reddit, etc.)
    const unwrapped = unwrapGatewayUrl(currentUrl);
    if (unwrapped) currentUrl = unwrapped;

    let finalUrl = currentUrl;

    const requestHeaders = {
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.9',
      'Sec-Fetch-Dest': 'document',
      'Sec-Fetch-Mode': 'navigate',
      'Sec-Fetch-Site': 'cross-site'
    };

    // Step 2: Resolve via fast HTTP HEAD (with GET fallback and stream abortion)
    const headController = new AbortController();
    const headTimeoutId = setTimeout(() => headController.abort(), 2000);

    try {
      let res = await fetch(currentUrl, {
        method: 'HEAD',
        redirect: 'follow',
        headers: requestHeaders,
        signal: headController.signal
      });
      clearTimeout(headTimeoutId);
      
      if (res.url && res.url !== currentUrl) {
        finalUrl = res.url;
      } else if (!res.ok && res.status !== 404) {
        const getController = new AbortController();
        const getTimeoutId = setTimeout(() => getController.abort(), 2000);
        res = await fetch(currentUrl, {
          method: 'GET',
          redirect: 'follow',
          headers: requestHeaders,
          signal: getController.signal
        });
        clearTimeout(getTimeoutId);
        finalUrl = res.url || currentUrl;
        // Immediately cancel the response stream to save memory & bandwidth
        try { if (res.body?.cancel) res.body.cancel(); } catch {}
      } else {
        finalUrl = res.url || currentUrl;
      }
    } catch {
      clearTimeout(headTimeoutId);
      finalUrl = currentUrl;
    }

    // Step 3: Check for nested inner gateway
    const secondUnwrap = unwrapGatewayUrl(finalUrl);
    if (secondUnwrap) finalUrl = secondUnwrap;

    // Step 4: Sanitize through ClearURLs engine
    const cleanUrl = typeof cleanUrlWithClearUrls === 'function' ? cleanUrlWithClearUrls(finalUrl, clearUrlsData) : finalUrl;

    if (unshortenCache.size > 1000) unshortenCache.delete(unshortenCache.keys().next().value);
    unshortenCache.set(rawUrl, cleanUrl);

    return cleanUrl;
  } catch (e) {
    return rawUrl;
  }
}

function toggleDarkMode(tabId) {
  if (!tabId) return;

  chrome.scripting.executeScript({
    target: { tabId },
    func: () => window.__DARK_MODE_INJECTED__
  }).then(async results => {
    if (results?.[0]?.result) {
      const res = await chrome.scripting.executeScript({
        target: { tabId },
        func: () => window.__DARK_MODE_TOGGLE__()
      });
      if (res?.[0]) updateDomainMemory(tabId, res[0].result);
    } else {
      injectDarkMode(tabId);
      updateDomainMemory(tabId, true);
    }
  }).catch(console.error);
}

function injectDarkMode(tabId) {
  chrome.scripting.insertCSS({ target: { tabId }, files: ['fast-inject.css'] });
  chrome.scripting.executeScript({ target: { tabId }, files: ['darkreader.js', 'autodark-init.js'] });
}

async function updateDomainMemory(tabId, isEnabled) {
  try {
    const tab = await chrome.tabs.get(tabId);
    if (!tab?.url || tab.url.startsWith('chrome://') || tab.url.startsWith('https://chrome.google.com/webstore')) return;
    const hostname = new URL(tab.url).hostname;
    if (!hostname) return;

    const { darkmode_domains = [] } = await chrome.storage.local.get('darkmode_domains');
    const index = darkmode_domains.indexOf(hostname);
    let changed = false;

    if (isEnabled && index === -1) {
      darkmode_domains.push(hostname);
      changed = true;
    } else if (!isEnabled && index !== -1) {
      darkmode_domains.splice(index, 1);
      changed = true;
    }

    if (changed) {
      await chrome.storage.local.set({ darkmode_domains });
      updateRegisteredDarkModeScript(darkmode_domains);
    }
  } catch {}
}

let darkScriptLock = Promise.resolve();

function updateRegisteredDarkModeScript(domains) {
  darkScriptLock = darkScriptLock.then(async () => {
    try {
      const existing = await chrome.scripting.getRegisteredContentScripts();
      const targetIds = ['dynamic-dark-mode', 'dynamic-dark-mode-css', 'dynamic-dark-mode-js'];
      const toUnregister = existing.map(s => s.id).filter(id => targetIds.includes(id));
      if (toUnregister.length) {
        await chrome.scripting.unregisterContentScripts({ ids: toUnregister });
      }
    } catch {}

    if (domains?.length) {
      const matches = domains.flatMap(d => {
        const base = d.replace(/^www\./, '');
        return [`*://${base}/*`, `*://*.${base}/*`];
      });

      try {
        await chrome.scripting.registerContentScripts([
          {
            id: 'dynamic-dark-mode-css',
            matches,
            css: ['fast-inject.css'],
            runAt: 'document_start'
          },
          {
            id: 'dynamic-dark-mode-js',
            matches,
            js: ['darkreader.js', 'autodark-init.js'],
            runAt: 'document_idle'
          }
        ]);
      } catch (e) {
        console.error('Failed to register dynamic dark mode script:', e);
      }
    }
  });
  return darkScriptLock;
}

function rehydrateDarkScripts() {
  chrome.storage.local.get('darkmode_domains', (res) => {
    if (res?.darkmode_domains) updateRegisteredDarkModeScript(res.darkmode_domains);
  });
}