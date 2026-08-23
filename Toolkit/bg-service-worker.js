importScripts('clearurls-engine.js');

let clearUrlsData = null;
fetch(chrome.runtime.getURL('clearurls-rules.json'))
  .then(res => res.json())
  .then(data => clearUrlsData = data)
  .catch(console.error);

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
      fetch(msg.url)
        .then(res => res.text())
        .then(text => sendResponse({ text }))
        .catch(err => sendResponse({ error: err.toString() }));
      return true;
  }
});

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
  chrome.scripting.executeScript({ target: { tabId }, files: ['fast-inject-class.js'] });
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
        await chrome.scripting.registerContentScripts([{
          id: 'dynamic-dark-mode',
          matches,
          css: ['fast-inject.css'],
          js: ['fast-inject-class.js', 'darkreader.js', 'autodark-init.js'],
          runAt: 'document_idle'
        }]);
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