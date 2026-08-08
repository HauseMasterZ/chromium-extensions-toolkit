importScripts('clearurls-engine.js');

let clearUrlsData = null;
fetch(chrome.runtime.getURL('clearurls-rules.json'))
    .then(res => res.json())
    .then(data => clearUrlsData = data)
    .catch(console.error);

chrome.commands.onCommand.addListener(async c => {
  const { featurePasteGo = true } = await chrome.storage.local.get('featurePasteGo');
  if (!featurePasteGo) return;

  if (c === 'duplicate_tab') {
    let [{ id }] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (id) chrome.tabs.duplicate(id);
    return;
  }
  
  if (c === 'toggle_dark_mode') {
    let [{ id }] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (id) toggleDarkMode(id);
    return;
  }
  
  if (c === 'close_other_tabs') {
    let [{ id }] = await chrome.tabs.query({ active: true, currentWindow: true });
    let allTabs = await chrome.tabs.query({});
    let tabsToRemove = allTabs.filter(t => t.id !== id).map(t => t.id);
    if (tabsToRemove.length) chrome.tabs.remove(tabsToRemove);
    return;
  }

  if (c === 'close_all_windows') {
    // 1. Force clear data FIRST to guarantee it finishes before Chrome shuts down
    await new Promise(resolve => {
      chrome.browsingData.remove({
        "since": 0
      }, {
        "history": true,
        "cache": true,
        "cacheStorage": true,
        "downloads": true,
        "formData": true,
        "passwords": true
      }, resolve);
    });

    // 2. Kill all windows
    let windows = await chrome.windows.getAll();
    for (let w of windows) {
      chrome.windows.remove(w.id);
    }
    return;
  }

  if (c === 'copy_clean_url') {
    let [{ id, url }] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (id && url) {
      try {
        let cleanUrl = clearUrlsData ? cleanUrlWithClearUrls(url, clearUrlsData) : url;
        
        await chrome.scripting.executeScript({
          target: { tabId: id },
          func: (cleanUrl) => navigator.clipboard.writeText(cleanUrl),
          args: [cleanUrl]
        });
      } catch (e) {}
    }
    return;
  }
  
  if (c !== 'run' && c !== 'run_yt' && c !== 'run_incognito') return;
  let [{ id, url }] = await chrome.tabs.query({ active: true, currentWindow: true });
  try {
    let result = null;
    let isExtensionPage = false;

    try {
      let res = await chrome.scripting.executeScript({ target: { tabId: id }, func: () => navigator.clipboard.readText() });
      result = res && res[0] ? res[0].result : null;
    } catch (e) {
      isExtensionPage = true;
      try {
        result = await chrome.tabs.sendMessage(id, { action: 'read_clipboard' });
      } catch (e2) {}
    }

    if (result) {
      result = result.trim();
      let isUrl = /^https?:\/\//i.test(result);
      
      if (c === 'run') {
        let finalUrl = isUrl ? result : `https://google.com/search?q=${encodeURIComponent(result)}`;
        if (isExtensionPage) chrome.tabs.update(id, { url: finalUrl });
        else chrome.tabs.create({ url: finalUrl });
      } else if (c === 'run_yt') {
        let finalUrl = `https://www.youtube.com/results?search_query=${encodeURIComponent(result)}`;
        if (isExtensionPage) chrome.tabs.update(id, { url: finalUrl });
        else chrome.tabs.create({ url: finalUrl });
      } else if (c === 'run_incognito') {
        let targetUrl = isUrl ? result : `https://google.com/search?q=${encodeURIComponent(result)}`;
        let windows = await chrome.windows.getAll();
        let incognitoWin = windows.find(w => w.incognito);
        if (incognitoWin) {
          chrome.tabs.create({ windowId: incognitoWin.id, url: targetUrl });
          chrome.windows.update(incognitoWin.id, { focused: true });
        } else {
          chrome.windows.create({ url: targetUrl, incognito: true });
        }
      }
    }
  } catch {}
});

chrome.runtime.onInstalled.addListener(() => {

  chrome.storage.local.get({ featureYtMusic: true, featureYtFloatSearch: true, featureWhatsapp: true }, (res) => {
    updateYtMusicScript(res.featureYtMusic);
    updateYtFloatSearchScript(res.featureYtFloatSearch);
    updateWhatsappScript(res.featureWhatsapp);
  });
  rehydrateDarkScripts();
});


// Manage dynamic content scripts
const updateYtMusicScript = async (enabled) => {
  try {
    await chrome.scripting.unregisterContentScripts({ ids: ["yt-music-audio"] });
  } catch (e) {}

  if (enabled) {
    try {
      await chrome.scripting.registerContentScripts([{
        id: "yt-music-audio",
        matches: ["*://music.youtube.com/*"],
        js: ["yt-music-audio.js"],
        runAt: "document_idle",
        world: "MAIN"
      }]);
    } catch (e) {}
  }
};

const updateYtFloatSearchScript = async (enabled) => {
  try {
    await chrome.scripting.unregisterContentScripts({ ids: ["yt-float-search"] });
  } catch (e) {}

  if (enabled) {
    try {
      await chrome.scripting.registerContentScripts([{
        id: "yt-float-search",
        matches: ["https://www.youtube.com/*", "https://m.youtube.com/*"],
        js: ["yt-float-search.js"],
        css: ["yt-float-search.css"],
        runAt: "document_idle"
      }]);
    } catch (e) {}
  }
};

const updateWhatsappScript = async (enabled) => {
  try {
    await chrome.scripting.unregisterContentScripts({ ids: ["whatsapp-virtual-camera", "whatsapp-wide-style"] });
  } catch (e) {}

  if (enabled) {
    try {
      await chrome.scripting.registerContentScripts([
        {
          id: "whatsapp-virtual-camera",
          matches: ["*://web.whatsapp.com/*", "https://web.whatsapp.com/*"],
          js: ["whatsapp-virtual-camera.js"],
          runAt: "document_idle",
          world: "MAIN"
        },
        {
          id: "whatsapp-wide-style",
          matches: ["*://web.whatsapp.com/*", "https://web.whatsapp.com/*"],
          js: ["whatsapp-wide-style.js"],
          runAt: "document_idle"
        }
      ]);
    } catch (e) {}
  }
};

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.action === 'updateYtMusicScript') {
    updateYtMusicScript(msg.enabled);
  } else if (msg.action === 'updateYtFloatSearchScript') {
    updateYtFloatSearchScript(msg.enabled);
  } else if (msg.action === 'updateWhatsappScript') {
    updateWhatsappScript(msg.enabled);
  } else if (msg.action === 'toggleDarkMode') {
    if (msg.tabId) toggleDarkMode(msg.tabId);
  } else if (msg.action === 'fetchCSS') {
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
        target: { tabId: tabId },
        func: () => window.__DARK_MODE_INJECTED__
    }).then(async results => {
        if (results && results[0] && results[0].result) {
            let res = await chrome.scripting.executeScript({
                target: { tabId: tabId },
                func: () => window.__DARK_MODE_TOGGLE__()
            });
            if (res && res[0]) updateDomainMemory(tabId, res[0].result);
        } else {
            injectDarkMode(tabId);
            updateDomainMemory(tabId, true);
        }
    }).catch(console.error);
}

function injectDarkMode(tabId) {
    chrome.scripting.insertCSS({
        target: { tabId: tabId },
        files: ['fast-inject.css']
    });
    chrome.scripting.executeScript({
        target: { tabId: tabId },
        files: ['fast-inject-class.js']
    });
    chrome.scripting.executeScript({
        target: { tabId: tabId },
        files: ['darkreader.js', 'autodark-init.js']
    });
}

async function updateDomainMemory(tabId, isEnabled) {
    try {
        let tab = await chrome.tabs.get(tabId);
        if (!tab || !tab.url || tab.url.startsWith('chrome://') || tab.url.startsWith('https://chrome.google.com/webstore')) return;
        let hostname = new URL(tab.url).hostname;
        if (!hostname) return;

        let { darkmode_domains = [] } = await chrome.storage.local.get('darkmode_domains');
        let index = darkmode_domains.indexOf(hostname);
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
    } catch(e) {}
}

async function updateRegisteredDarkModeScript(domains) {
    try { await chrome.scripting.unregisterContentScripts({ ids: ["dynamic-dark-mode-css", "dynamic-dark-mode-js"] }); } catch(e) {}
    
    if (domains && domains.length > 0) {
        let matches = domains.flatMap(d => {
            let base = d.replace(/^www\./, '');
            return [`*://${base}/*`, `*://*.${base}/*`];
        });
        
        try {
            await chrome.scripting.registerContentScripts([
                {
                    id: "dynamic-dark-mode-css",
                    matches: matches,
                    css: ["fast-inject.css"],
                    js: ["fast-inject-class.js"],
                    runAt: "document_start"
                },
                {
                    id: "dynamic-dark-mode-js",
                    matches: matches,
                    js: ["darkreader.js", "autodark-init.js"],
                    runAt: "document_idle"
                }
            ]);
        } catch(e) { console.error("Failed to register dynamic dark mode script:", e); }
    }
}

function rehydrateDarkScripts() {
    chrome.storage.local.get('darkmode_domains', (res) => {
        if (res.darkmode_domains) updateRegisteredDarkModeScript(res.darkmode_domains);
    });
}

chrome.runtime.onStartup.addListener(() => {
    rehydrateDarkScripts();
    // Auto-delete on startup to reliably emulate "clear on exit" since 
    // Chrome instantly kills background workers when the last window closes.
    chrome.browsingData.remove({
      "since": 0
    }, {
      "history": true,
      "cache": true,
      "cacheStorage": true,
      "downloads": true,
      "formData": true,
      "passwords": true
    }, () => {});
});