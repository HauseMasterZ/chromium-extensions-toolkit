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

// Fetch live shorteners with Option A (HaGeZi Upstream / CDN) -> Option B (Repo Mirror) fallback
async function syncRemoteShortenersList() {
  const UPSTREAM_URL = 'https://raw.githubusercontent.com/hagezi/dns-blocklists/main/wildcard/urlshortener-onlydomains.txt';
  const CDN_BACKUP_URL = 'https://cdn.jsdelivr.net/gh/hagezi/dns-blocklists@latest/wildcard/urlshortener-onlydomains.txt';
  const REPO_FALLBACK_URL = 'https://raw.githubusercontent.com/HauseMasterZ/chromium-extensions-toolkit/main/Toolkit/shorteners-rules.json';

  const tryFetchTextList = async (url) => {
    try {
      const res = await fetch(url, { cache: 'no-cache' });
      if (!res.ok) return null;
      const text = await res.text();
      const list = text.split(/\r?\n/).map(s => s.trim().toLowerCase()).filter(s => s && !s.startsWith('#'));
      return list.length > 500 ? list : null;
    } catch {
      return null;
    }
  };

  // Option A1: Primary Upstream HaGeZi
  let list = await tryFetchTextList(UPSTREAM_URL);
  
  // Option A2: Fast jsDelivr CDN
  if (!list) list = await tryFetchTextList(CDN_BACKUP_URL);

  if (list) {
    shortenersSet = new Set(list);
    await chrome.storage.local.set({ cachedShortenersList: list, lastShortenersSyncTime: Date.now() });
    return;
  }

  // Option B: Secondary Fallback to Repo Mirror JSON
  try {
    const res = await fetch(REPO_FALLBACK_URL, { cache: 'no-cache' });
    if (res.ok) {
      const jsonList = await res.json();
      if (Array.isArray(jsonList) && jsonList.length > 500) {
        shortenersSet = new Set(jsonList);
        await chrome.storage.local.set({ cachedShortenersList: jsonList, lastShortenersSyncTime: Date.now() });
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

chrome.commands.onCommand.addListener(async c => {
  const { featurePasteGo = true } = await chrome.storage.local.get('featurePasteGo');
  if (!featurePasteGo) return;

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
    await new Promise(resolve => {
      chrome.browsingData.remove({ since: 0 }, {
        history: true, downloads: true, formData: true,
        cache: true, cacheStorage: true, pluginData: true, fileSystems: true, webSQL: true
      }, resolve);
    });

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
      } catch {}
    }
    return;
  }

  if (c === 'discard_background_tabs') {
    const tabs = await chrome.tabs.query({ discarded: false });
    for (const t of tabs) {
      if (!t.active && t.id) {
        chrome.tabs.discard(t.id).catch(() => {});
      }
    }
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

function setupContextMenus() {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: 'open_clean_link_tab',
      title: 'Open Clean / Unshortened Link',
      contexts: ['link']
    });
  });
}

setupContextMenus();

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId === 'open_clean_link_tab' && info.linkUrl) {
    const cleanUrl = await resolveAndCleanShortUrl(info.linkUrl) || info.linkUrl;
    const createProps = { url: cleanUrl };
    if (tab?.id) {
      createProps.index = tab.index + 1;
      createProps.openerTabId = tab.id;
    }
    chrome.tabs.create(createProps);
  }
});

chrome.runtime.onInstalled.addListener(async () => {
  setupContextMenus();
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

    // Generic short TLD single slug pattern
    const shortTlds = /\.(gg|ly|to|co|is|gd|cc|link|me|click|fi|ms|it|st|app|bio|us|sh|io|so|at|am|ws|nu|ee|ai|xyz|site)$/i;
    if (host.length <= 14 && shortTlds.test(host) && /^\/[a-zA-Z0-9_\-\.]{1,25}\/?$/.test(pathname)) {
      return true;
    }

    // Generic vanity short link pattern (e.g. piavpn.com/ltt, dbrand.com/pcb)
    if (/^\/[a-zA-Z0-9_\-]{1,24}\/?$/.test(pathname) && !pathname.includes('.')) {
      const standardRoots = new Set(['/login', '/signup', '/register', '/about', '/terms', '/privacy', '/contact', '/help', '/support', '/pricing', '/faq']);
      if (!standardRoots.has(pathname.toLowerCase().replace(/\/$/, ''))) {
        return true;
      }
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

    // Step 2: If currentUrl is a shortener, resolve via HTTP HEAD/GET with 4s timeout
    if (isShortenerUrl(currentUrl)) {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 4000);

      try {
        let res = await fetch(currentUrl, { method: 'HEAD', redirect: 'follow', signal: controller.signal });
        clearTimeout(timeoutId);
        
        // If res.url changed, we followed the redirect successfully regardless of final status code (e.g. 503 bot protect)
        if (res.url && res.url !== currentUrl) {
          finalUrl = res.url;
        } else if (!res.ok && res.status !== 404) {
          const getController = new AbortController();
          const getTimeout = setTimeout(() => getController.abort(), 3000);
          res = await fetch(currentUrl, { method: 'GET', redirect: 'follow', signal: getController.signal });
          clearTimeout(getTimeout);
          finalUrl = res.url || currentUrl;
        } else {
          finalUrl = res.url || currentUrl;
        }
      } catch {
        clearTimeout(timeoutId);
        finalUrl = currentUrl;
      }
    }

    // Step 3: Check for nested inner gateway
    const secondUnwrap = unwrapGatewayUrl(finalUrl);
    if (secondUnwrap) finalUrl = secondUnwrap;

    // Step 4: Sanitize through ClearURLs engine
    const cleanUrl = typeof cleanUrlWithClearUrls === 'function' ? cleanUrlWithClearUrls(finalUrl, clearUrlsData) : finalUrl;

    if (unshortenCache.size > 500) unshortenCache.delete(unshortenCache.keys().next().value);
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