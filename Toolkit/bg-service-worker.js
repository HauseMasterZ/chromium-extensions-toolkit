importScripts('clearurls-engine.js');
importScripts('display-zoom.js');

let clearUrlsData = null;
let shortenersSet = new Set();
const cssMemoryCache = new Map();
const unshortenCache = new Map();
const reverseUnshortenCache = new Map();
const ytSuggestControllers = new Map();

let unshortenInitPromise = null;
let persistUnshortenTimer = null;

function ensureUnshortenCacheInitialized() {
  if (unshortenInitPromise) return unshortenInitPromise;

  unshortenInitPromise = (async () => {
    try {
      if (chrome.storage?.session) {
        const res = await chrome.storage.session.get(['unshorten_cache', 'reverse_unshorten_cache']);
        if (Array.isArray(res?.unshorten_cache)) {
          for (const [k, v] of res.unshorten_cache) {
            if (typeof k === 'string' && typeof v === 'string' && !unshortenCache.has(k)) {
              unshortenCache.set(k, v);
            }
          }
        }
        if (Array.isArray(res?.reverse_unshorten_cache)) {
          for (const [k, v] of res.reverse_unshorten_cache) {
            if (typeof k === 'string' && typeof v === 'string' && !reverseUnshortenCache.has(k)) {
              reverseUnshortenCache.set(k, v);
            }
          }
        }
      }
    } catch {}
  })();

  return unshortenInitPromise;
}

function persistUnshortenCache() {
  if (persistUnshortenTimer) clearTimeout(persistUnshortenTimer);
  persistUnshortenTimer = setTimeout(async () => {
    persistUnshortenTimer = null;
    try {
      await ensureUnshortenCacheInitialized();
      if (chrome.storage?.session) {
        await chrome.storage.session.set({
          unshorten_cache: Array.from(unshortenCache.entries()),
          reverse_unshorten_cache: Array.from(reverseUnshortenCache.entries())
        });
      }
    } catch {}
  }, 300);
}

// Load ClearURLs rules with 3-tier fallback
let clearUrlsInitPromise = null;
async function initClearUrlsRules() {
  if (clearUrlsInitPromise) return clearUrlsInitPromise;
  clearUrlsInitPromise = (async () => {
    try {
      const { cachedClearUrlsRules } = await chrome.storage.local.get('cachedClearUrlsRules');
      if (cachedClearUrlsRules?.providers) {
        if (!clearUrlsData || !clearUrlsData.providers) {
          clearUrlsData = cachedClearUrlsRules;
        }
        return;
      }
    } catch {}

    try {
      const res = await fetch(chrome.runtime.getURL('clearurls-rules.json'));
      const bundled = await res.json();
      if (!clearUrlsData || !clearUrlsData.providers) {
        clearUrlsData = bundled;
      }
    } catch (e) {
      console.error('Failed to load bundled clearurls rules:', e);
    }
  })();
  return clearUrlsInitPromise;
}

// Load Shortener Domains with 3-tier fallback
let shortenersInitPromise = null;
async function initShortenersList() {
  if (shortenersInitPromise) return shortenersInitPromise;
  shortenersInitPromise = (async () => {
    try {
      const { cachedShortenersList } = await chrome.storage.local.get('cachedShortenersList');
      if (Array.isArray(cachedShortenersList) && cachedShortenersList.length > 0) {
        if (!shortenersSet || shortenersSet.size === 0) {
          shortenersSet = new Set(cachedShortenersList);
        }
        return;
      }
    } catch {}

    try {
      const res = await fetch(chrome.runtime.getURL('shorteners-rules.json'));
      const list = await res.json();
      if (Array.isArray(list)) {
        if (!shortenersSet || shortenersSet.size === 0) {
          shortenersSet = new Set(list);
        }
        await chrome.storage.local.set({ cachedShortenersList: list });
      }
    } catch (e) {
      console.error('Failed to load bundled shorteners list:', e);
    }
  })();
  return shortenersInitPromise;
}

// Fetch live rules from GitHub
async function syncRemoteClearUrlsRules(force = false) {
  await initClearUrlsRules();
  if (!force) {
    try {
      const { lastRulesSyncTime } = await chrome.storage.local.get('lastRulesSyncTime');
      if (lastRulesSyncTime && (Date.now() - lastRulesSyncTime) < 86400000) {
        return;
      }
    } catch {}
  }

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
async function syncRemoteShortenersList(force = false) {
  await initShortenersList();
  if (!force) {
    try {
      const { lastShortenersSyncTime } = await chrome.storage.local.get('lastShortenersSyncTime');
      if (lastShortenersSyncTime && (Date.now() - lastShortenersSyncTime) < 86400000) {
        return;
      }
    } catch {}
  }

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

// ============================================================================
// Centralized Weather & Geolocation Sync (30-min weather, strictly 24-hr geo)
// ============================================================================
let weatherSyncPromise = null;

async function getOrUpdateCoordinates() {
  const ONE_DAY_MS = 24 * 60 * 60 * 1000;
  const now = Date.now();

  let cachedCoords = null;
  let cachedTime = 0;

  try {
    const res = await chrome.storage.local.get(['geoCoordsCache', 'geoCoordsCacheTime']);
    cachedCoords = res?.geoCoordsCache || null;
    cachedTime = parseInt(res?.geoCoordsCacheTime, 10) || 0;
  } catch {}

  // Strictly limit location ping to once per 24 hours per project rules
  if (cachedCoords && cachedTime && (now - cachedTime) < ONE_DAY_MS) {
    return cachedCoords;
  }

  // Mark attempt timestamp immediately to prevent spamming on rapid calls if network fails
  try {
    await chrome.storage.local.set({ geoCoordsCacheTime: now.toString() });
  } catch {}

  try {
    let lat = null, lon = null;
    try {
      const geoRes = await fetch('https://freeipapi.com/api/json', { signal: AbortSignal.timeout(3000) });
      if (geoRes.ok) {
        const geoData = await geoRes.json();
        if (geoData?.latitude && geoData?.longitude) {
          lat = geoData.latitude;
          lon = geoData.longitude;
        }
      }
    } catch {}

    if (!lat || !lon) {
      try {
        const fallbackRes = await fetch('https://ipapi.co/json/', { signal: AbortSignal.timeout(3000) });
        if (fallbackRes.ok) {
          const fallbackData = await fallbackRes.json();
          if (fallbackData?.latitude && fallbackData?.longitude) {
            lat = fallbackData.latitude;
            lon = fallbackData.longitude;
          }
        }
      } catch {}
    }

    if (lat && lon) {
      const coords = { lat, lon };
      await chrome.storage.local.set({
        geoCoordsCache: coords,
        geoCoordsCacheTime: now.toString()
      });
      return coords;
    }
  } catch {}

  // Fall back to previously cached coordinates if daily refresh failed
  return cachedCoords;
}

async function syncWeather(force = false) {
  if (weatherSyncPromise) return weatherSyncPromise;

  weatherSyncPromise = (async () => {
    const now = Date.now();
    const THIRTY_MINUTES_MS = 30 * 60 * 1000;

    if (!force) {
      try {
        const { weatherCache, weatherCacheTime } = await chrome.storage.local.get(['weatherCache', 'weatherCacheTime']);
        const cachedTime = parseInt(weatherCacheTime, 10);
        if (weatherCache && !isNaN(cachedTime) && (now - cachedTime) < THIRTY_MINUTES_MS) {
          return weatherCache;
        }
      } catch {}
    }

    // Check offline status before attempting network request
    if (typeof navigator !== 'undefined' && navigator.onLine === false) {
      try {
        const { weatherCache } = await chrome.storage.local.get('weatherCache');
        if (weatherCache) return weatherCache;
      } catch {}
      return null;
    }

    try {
      const coords = await getOrUpdateCoordinates();
      if (!coords?.lat || !coords?.lon) {
        throw new Error('Unable to resolve IP location');
      }

      const res = await fetch(`https://api.open-meteo.com/v1/forecast?latitude=${coords.lat}&longitude=${coords.lon}&current=temperature_2m,wind_speed_10m&hourly=precipitation_probability&timezone=auto&forecast_days=1`, {
        signal: AbortSignal.timeout(7000)
      });
      if (!res.ok) throw new Error(`Weather fetch failed: ${res.status}`);
      const data = await res.json();
      if (!data?.current || typeof data.current.temperature_2m !== 'number') {
        throw new Error('Invalid weather payload: missing current temperature');
      }
      const temp = data.current.temperature_2m;
      const wind = typeof data.current.wind_speed_10m === 'number' ? data.current.wind_speed_10m : 0;
      const hourIndex = Math.min(23, Math.max(0, new Date().getHours()));
      const hourlyRain = Array.isArray(data.hourly?.precipitation_probability) ? data.hourly.precipitation_probability[hourIndex] : 0;
      const rain = typeof hourlyRain === 'number' ? hourlyRain : 0;

      const weatherString = `${temp}°C &nbsp;|&nbsp; Rain ${rain}% &nbsp;|&nbsp; Wind ${wind} km/h`;

      await chrome.storage.local.set({
        weatherCache: weatherString,
        weatherCacheTime: now.toString()
      });
      return weatherString;
    } catch (e) {
      console.warn('[CToolkit] Weather sync transient network failure, falling back to cache:', e?.message || e);
      try {
        // Schedule a single retry after 15 seconds if network was temporarily unavailable during startup
        chrome.alarms?.create('retry_weather_alarm', { when: Date.now() + 15000 });
      } catch {}
      try {
        const { weatherCache } = await chrome.storage.local.get('weatherCache');
        if (weatherCache) return weatherCache;
      } catch {}
      return null;
    } finally {
      weatherSyncPromise = null;
    }
  })();

  return weatherSyncPromise;
}

(async () => {
  await initClearUrlsRules();
  await syncRemoteClearUrlsRules(false);
})();
(async () => {
  await initShortenersList();
  await syncRemoteShortenersList(false);
})();
ensureUnshortenCacheInitialized();
syncWeather(false);

chrome.alarms.get('sync_clearurls_alarm', (alarm) => {
  if (!alarm) {
    chrome.alarms.create('sync_clearurls_alarm', { periodInMinutes: 1440 });
  }
});
chrome.alarms.get('sync_weather_alarm', (alarm) => {
  if (!alarm) {
    chrome.alarms.create('sync_weather_alarm', { periodInMinutes: 30 });
  }
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'sync_clearurls_alarm') {
    syncRemoteClearUrlsRules(true);
    syncRemoteShortenersList(true);
  } else if (alarm.name === 'sync_weather_alarm') {
    syncWeather(true);
  } else if (alarm.name === 'retry_weather_alarm') {
    syncWeather(true);
  } else if (alarm.name === 'host_idle_teardown_alarm') {
    if (telemetryClients.size === 0) {
      stopNativeTelemetry();
    }
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

let offscreenCreationPromise = null;
let offscreenCloseTimer = null;

function refreshOffscreenIdleTimer() {
  if (offscreenCloseTimer) clearTimeout(offscreenCloseTimer);
  offscreenCloseTimer = setTimeout(() => {
    closeOffscreenDocument();
  }, 60000);
}

async function ensureOffscreenDocument() {
  refreshOffscreenIdleTimer();

  if (chrome.offscreen?.hasDocument && await chrome.offscreen.hasDocument()) {
    return;
  }

  const existingContexts = await chrome.runtime.getContexts?.({ contextTypes: ['OFFSCREEN_DOCUMENT'] }) || [];
  if (existingContexts.length > 0) return;

  if (offscreenCreationPromise) {
    await offscreenCreationPromise;
    return;
  }

  offscreenCreationPromise = chrome.offscreen.createDocument({
    url: 'ocr-offscreen.html',
    reasons: ['WORKERS', 'BLOBS'],
    justification: 'Run offline Tesseract.js WASM OCR engine'
  }).catch((err) => {
    if (!err?.message?.includes('Only a single offscreen document')) {
      console.error('Failed to create offscreen document:', err);
    }
  }).finally(() => {
    offscreenCreationPromise = null;
  });

  await offscreenCreationPromise;
}

async function closeOffscreenDocument() {
  try {
    if (chrome.offscreen?.hasDocument && await chrome.offscreen.hasDocument()) {
      await chrome.offscreen.closeDocument();
    }
  } catch {}
}

function resolvePasteUrl(input) {
  if (!input) return null;
  const str = input.trim();
  if (!str) return null;

  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//i.test(str)) {
    return str;
  }
  if (/^localhost(:\d+)?(\/.*)?$/i.test(str)) {
    return `http://${str}`;
  }
  if (/^(\d{1,3}\.){3}\d{1,3}(:\d+)?(\/.*)?$/.test(str)) {
    return `http://${str}`;
  }
  if (!/\s/.test(str) && /^([a-zA-Z0-9-]+\.)+[a-zA-Z]{2,}(:\d+)?(\/.*)?$/i.test(str)) {
    return `https://${str}`;
  }
  return `https://www.google.com/search?q=${encodeURIComponent(str)}`;
}

async function showPillToast(tabId, message, durationMs = 1200) {
  if (!tabId) return;
  try {
    const tab = await chrome.tabs.get(tabId);
    if (!tab?.url || !/^https?:\/\//i.test(tab.url)) return;
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
  } catch {}
}

function setupContextMenu() {
  if (!chrome.contextMenus) return;
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: 'copy_raw_link',
      title: 'Copy raw link address',
      contexts: ['link']
    }, () => {
      if (chrome.runtime.lastError) {}
    });
  });
}

chrome.runtime.onInstalled.addListener(setupContextMenu);
chrome.runtime.onStartup.addListener(setupContextMenu);

async function copyTextToTabClipboard(tabId, frameId, text) {
  const func = (t) => {
    if (navigator.clipboard?.writeText) {
      return navigator.clipboard.writeText(t).catch(() => {
        const ta = document.createElement('textarea');
        ta.value = t;
        ta.style.position = 'fixed';
        ta.style.opacity = '0';
        (document.body || document.documentElement).appendChild(ta);
        ta.focus();
        ta.select();
        document.execCommand('copy');
        ta.remove();
      });
    } else {
      const ta = document.createElement('textarea');
      ta.value = t;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      (document.body || document.documentElement).appendChild(ta);
      ta.focus();
      ta.select();
      document.execCommand('copy');
      ta.remove();
    }
  };

  try {
    const target = { tabId };
    if (typeof frameId === 'number' && frameId > 0) {
      target.frameIds = [frameId];
    }
    await chrome.scripting.executeScript({
      target,
      func,
      args: [text]
    });
    return true;
  } catch {
    try {
      await chrome.scripting.executeScript({
        target: { tabId },
        func,
        args: [text]
      });
      return true;
    } catch {
      return false;
    }
  }
}

async function handleCopyRawLink(info, tab) {
  if (!tab?.id || !info?.linkUrl) return;

  let rawUrl = null;
  try {
    const sendOptions = typeof info.frameId === 'number' && info.frameId > 0 ? { frameId: info.frameId } : {};
    const res = await chrome.tabs.sendMessage(tab.id, { action: 'get_raw_link', linkUrl: info.linkUrl }, sendOptions);
    if (res?.rawUrl) {
      rawUrl = res.rawUrl;
    }
  } catch {}

  if (!rawUrl && info.linkUrl) {
    await ensureUnshortenCacheInitialized();
    rawUrl = reverseUnshortenCache.get(info.linkUrl) || null;
  }

  if (!rawUrl) {
    rawUrl = info.linkUrl;
  }

  const copied = await copyTextToTabClipboard(tab.id, info.frameId, rawUrl);
  if (copied) {
    showPillToast(tab.id, 'Raw link copied', 1200);
  }
}

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId === 'copy_raw_link') {
    handleCopyRawLink(info, tab);
  }
});

const DEFAULT_PERSISTED_ORIGINS = [
  'https://web.whatsapp.com',
  'https://whatsapp.com',
  'https://www.whatsapp.com',
  'https://discord.com',
  'https://ptb.discord.com',
  'https://canary.discord.com',
  'https://discordapp.com',
  'https://status.discord.com',
  'https://web.telegram.org',
  'https://k.telegram.org',
  'https://z.telegram.org',
  'https://a.telegram.org',
  'https://telegram.org',
  'https://open.spotify.com',
  'https://spotify.com',
  'https://accounts.spotify.com',
  'https://api.spotify.com',
  'https://gae2-spclient.spotify.com',
  'https://app.notesnook.com',
  'https://notesnook.com',
  'https://auth.notesnook.com',
  'https://api.notesnook.com',
  'https://app.slack.com',
  'https://slack.com',
  'https://www.notion.so',
  'https://notion.so',
  'https://vault.bitwarden.com',
  'https://hausemasterz.github.io'
];
const DEFAULT_PERSISTED_SET = new Set(DEFAULT_PERSISTED_ORIGINS);

function isNewTabUrl(url) {
  return !url || url.includes('newtab-page.html') || url === 'chrome://newtab/' || url === 'helium://newtab/' || url === 'about:blank' || url === 'about:newtab';
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
    const dynamicPersistedSet = new Set(DEFAULT_PERSISTED_ORIGINS);
    for (let i = 0; i < persisted_origins.length; i++) {
      dynamicPersistedSet.add(persisted_origins[i]);
    }

    const allTabs = await chrome.tabs.query({});
    const probePromises = allTabs.map(async (t) => {
      if (!t.url || !t.url.startsWith('http') || !t.id) return;
      let origin;
      try {
        origin = new URL(t.url).origin;
      } catch {
        return;
      }

      // If tab is discarded/sleeping, we cannot run executeScript without triggering an expensive reload.
      // But if its origin matches a known persistent app or is already tracked, ensure it is preserved.
      if (t.discarded) {
        if (DEFAULT_PERSISTED_SET.has(origin) || dynamicPersistedSet.has(origin)) {
          dynamicPersistedSet.add(origin);
        }
        return;
      }

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
              const authKeyPattern = /(token|auth|session|master_key|cipher|credentials|supabase\.auth|firebase:authUser|fingerprint|wa-|last-wid|signal|matrix)/i;
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
                if (realDbs.length >= 2 || realDbs.some(d => /(wawc|model-storage|signal-protocol-store|whatsapp|notesnook|discord|slack|notion|vault|state|auth|session|localforage|matrix|rxdb|keyval-store)/i.test(d.name))) {
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

        let timerId = null;
        const timeoutPromise = new Promise(resolve => {
          timerId = setTimeout(() => resolve(null), 2000);
        });
        let probeRes = null;
        try {
          probeRes = await Promise.race([probeTask, timeoutPromise]);
        } finally {
          if (timerId) clearTimeout(timerId);
        }
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
    if (tab?.id && tab.url && /^https?:\/\//i.test(tab.url)) {
      try {
        const cleanUrl = clearUrlsData ? cleanUrlWithClearUrls(tab.url, clearUrlsData) : tab.url;
        await copyTextToTabClipboard(tab.id, null, cleanUrl);
        showPillToast(tab.id, 'Clean URL copied', 1200);
      } catch {}
    }
    return;
  }

  if (c === 'discard_background_tabs') {
    const allTabs = await chrome.tabs.query({});
    
    // Group tabs by windowId in single pass
    const windowsMap = new Map();
    for (let i = 0; i < allTabs.length; i++) {
      const t = allTabs[i];
      let list = windowsMap.get(t.windowId);
      if (!list) {
        list = [];
        windowsMap.set(t.windowId, list);
      }
      list.push(t);
    }

    // For every window whose active view is NOT an empty new tab and NOT playing media:
    // If an existing new tab is already open in that window, focus it; otherwise create one.
    for (const [winId, wTabs] of windowsMap) {
      const activeTab = wTabs.find(t => t.active);
      if (!activeTab || isNewTabUrl(activeTab.url) || activeTab.audible) continue;

      const existingNewTab = wTabs.find(t => isNewTabUrl(t.url));
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

    // Full sweep discard across all windows and monitors, skipping active, sleeping, new tab, and media/audible tabs
    const refreshedTabs = await chrome.tabs.query({});
    const tabsToDiscard = [];
    for (let i = 0; i < refreshedTabs.length; i++) {
      const t = refreshedTabs[i];
      if (t.id && !t.active && !t.discarded && !isNewTabUrl(t.url) && !t.audible) {
        tabsToDiscard.push(t.id);
      }
    }

    const discardResults = await Promise.allSettled(
      tabsToDiscard.map(id => chrome.tabs.discard(id))
    );

    const discardedCount = discardResults.filter(r => r.status === 'fulfilled' && r.value && r.value.discarded).length;
    showPillToast(tab?.id, discardedCount > 0 ? `Slept ${discardedCount} tab${discardedCount === 1 ? '' : 's'}` : 'Background tabs already asleep', 1500);
    return;
  }

  if (c === 'price_history') {
    if (tab?.id && tab.url && /^https?:\/\//i.test(tab.url)) {
      const cleanUrl = clearUrlsData ? cleanUrlWithClearUrls(tab.url, clearUrlsData) : tab.url;
      try {
        await copyTextToTabClipboard(tab.id, null, cleanUrl);
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

  if (c === 'ocr_dom') {
    if (tab?.id && tab.url && /^https?:\/\//i.test(tab.url)) {
      try {
        await chrome.tabs.sendMessage(tab.id, { action: 'toggle_ocr' });
      } catch {
        try {
          await chrome.scripting.insertCSS({ target: { tabId: tab.id }, files: ['ocr-dom-overlay.css'] });
          await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['ocr-dom-overlay.js'] });
          setTimeout(() => {
            chrome.tabs.sendMessage(tab.id, { action: 'toggle_ocr' }).catch(() => {});
          }, 100);
        } catch {}
      }
    }
    return;
  }

  if (!['run', 'run_yt', 'run_incognito'].includes(c) || !tab?.id) return;
  const { featurePasteGo = true } = await chrome.storage.local.get('featurePasteGo');
  if (!featurePasteGo) return;
  
  try {
    let result = null;
    const isExtensionPage = Boolean(tab.url && (tab.url.startsWith('chrome-extension://') || tab.url.startsWith('chrome://') || tab.url.startsWith('about:') || tab.url.startsWith('edge://')));

    if (isExtensionPage) {
      try {
        result = await chrome.tabs.sendMessage(tab.id, { action: 'read_clipboard' });
      } catch {}
    } else {
      try {
        const res = await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          func: async () => {
            try {
              if (navigator.clipboard?.readText) {
                return await navigator.clipboard.readText();
              }
            } catch {}
            try {
              const ta = document.createElement('textarea');
              document.body.appendChild(ta);
              ta.focus();
              document.execCommand('paste');
              const text = ta.value;
              ta.remove();
              return text;
            } catch {}
            return null;
          }
        });
        result = res?.[0]?.result ?? null;
      } catch {
        try {
          result = await chrome.tabs.sendMessage(tab.id, { action: 'read_clipboard' });
        } catch {}
      }
    }

    if (!result) return;
    result = result.trim();

    if (c === 'run') {
      const finalUrl = resolvePasteUrl(result);
      openTarget(finalUrl, isExtensionPage, tab.id);
    } else if (c === 'run_yt') {
      if (/^https?:\/\/(www\.)?(youtube\.com|youtu\.be)/i.test(result)) {
        openTarget(result, isExtensionPage, tab.id);
      } else {
        openTarget(`https://www.youtube.com/results?search_query=${encodeURIComponent(result)}`, isExtensionPage, tab.id);
      }
    } else if (c === 'run_incognito') {
      const targetUrl = resolvePasteUrl(result);
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

// Dynamic Script Registration Helper with Mutex Lock
let scriptSyncLock = Promise.resolve();

function syncContentScripts(id, enabled, configs) {
  const ids = Array.isArray(id) ? id : [id];
  scriptSyncLock = scriptSyncLock.then(async () => {
    try {
      const existing = await chrome.scripting.getRegisteredContentScripts();
      const registeredIds = new Set(existing.map(s => s.id));
      const toRemove = ids.filter(sId => registeredIds.has(sId));
      if (toRemove.length > 0) {
        await chrome.scripting.unregisterContentScripts({ ids: toRemove });
      }
      if (enabled && configs?.length) {
        await chrome.scripting.registerContentScripts(configs);
      }
    } catch (e) {
      console.error(`Script registration failed [${ids.join(',')}]:`, e);
    }
  });
  return scriptSyncLock;
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

function rehydrateFeatureScripts() {
  chrome.storage.local.get({
    featureYtMusic: true,
    featureYtFloatSearch: true,
    featureWhatsapp: true,
    darkmode_domains: []
  }, (res) => {
    updateYtMusicScript(res.featureYtMusic);
    updateYtFloatSearchScript(res.featureYtFloatSearch);
    updateWhatsappScript(res.featureWhatsapp);
    if (res?.darkmode_domains) {
      const sanitized = res.darkmode_domains.filter(d => !isDarkModeBlacklisted(d));
      if (sanitized.length !== res.darkmode_domains.length) {
        chrome.storage.local.set({ darkmode_domains: sanitized });
      }
      updateRegisteredDarkModeScript(sanitized);
    }
  });
}

chrome.runtime.onInstalled.addListener(async () => {
  try {
    const existing = await chrome.scripting.getRegisteredContentScripts();
    const legacy = existing.map(s => s.id).filter(id => id === 'custom-seek');
    if (legacy.length) await chrome.scripting.unregisterContentScripts({ ids: legacy });
  } catch {}

  rehydrateFeatureScripts();
});

chrome.runtime.onStartup.addListener(() => {
  rehydrateFeatureScripts();
});


function dispatchNativeHostMessage(payload) {
  cancelHostTeardown();
  if (!nativeTelemetryPort) {
    startNativeTelemetry();
  }
  if (nativeTelemetryPort) {
    try {
      nativeTelemetryPort.postMessage(payload);
    } catch (e) {
      console.error('Failed to post message to native host:', e);
    }
  }
  if (telemetryClients.size === 0) {
    scheduleHostTeardown();
  }
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  switch (msg.action) {
    case 'updateYtMusicScript':
      updateYtMusicScript(msg.enabled);
      break;
    case 'updateYtFloatSearchScript':
      updateYtFloatSearchScript(msg.enabled);
      break;
    case 'fetchYtSuggestions': {
      const query = (typeof msg.query === 'string') ? msg.query.trim().slice(0, 200) : '';
      const token = msg.token;
      if (!query) {
        try {
          sendResponse({ success: true, suggestions: [], query: '', token });
        } catch {}
        return false;
      }

      const tabKey = sender?.tab?.id ?? 'global';
      const prevController = ytSuggestControllers.get(tabKey);
      if (prevController) {
        try { prevController.abort(); } catch {}
      }

      const controller = new AbortController();
      ytSuggestControllers.set(tabKey, controller);

      const timeoutId = setTimeout(() => {
        try { controller.abort(); } catch {}
      }, 5000);

      const suggestUrl = `https://suggestqueries.google.com/complete/search?client=firefox&ds=yt&q=${encodeURIComponent(query)}`;
      fetch(suggestUrl, { signal: controller.signal })
        .then(res => {
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          return res.json();
        })
        .then(data => {
          const suggestions = (Array.isArray(data) && Array.isArray(data[1]))
            ? data[1].filter(s => typeof s === 'string').slice(0, 8)
            : [];
          try {
            sendResponse({ success: true, suggestions, query, token });
          } catch {}
        })
        .catch(err => {
          const isAbort = err?.name === 'AbortError' || controller.signal.aborted;
          try {
            sendResponse({ success: false, aborted: isAbort, suggestions: [], query, token });
          } catch {}
        })
        .finally(() => {
          clearTimeout(timeoutId);
          if (ytSuggestControllers.get(tabKey) === controller) {
            ytSuggestControllers.delete(tabKey);
          }
        });
      return true;
    }
    case 'updateWhatsappScript':
      updateWhatsappScript(msg.enabled);
      break;
    case 'toggleDarkMode':
      if (msg.tabId) toggleDarkMode(msg.tabId);
      break;
    case 'set_monitor_brightness':
      dispatchNativeHostMessage({
        action: 'set_brightness',
        monitorId: msg.monitorId,
        pnpId: msg.pnpId,
        gdiDevice: msg.gdiDevice,
        value: Number(msg.value)
      });
      sendResponse({ success: true });
      return false;
    case 'set_panel_control':
      recordInternalDisplaySetting(msg);
      dispatchNativeHostMessage({
        action: 'set_panel_control',
        monitorId: msg.monitorId,
        pnpId: msg.pnpId,
        gdiDevice: msg.gdiDevice,
        control: msg.control,
        value: Number(msg.value),
        isInternal: Boolean(msg.isInternal)
      });
      sendResponse({ success: true });
      return false;
    case 'probe_monitors':
    case 'refresh_monitors':
      dispatchNativeHostMessage({
        action: msg.action === 'refresh_monitors' ? 'refresh_monitors' : 'probe_monitors',
        probeId: msg.probeId || 0,
        contrast: internalDisplaySettings.contrast,
        gainR: internalDisplaySettings.gainR,
        gainG: internalDisplaySettings.gainG,
        gainB: internalDisplaySettings.gainB
      });
      sendResponse({ success: true });
      return false;
    case 'pasteAndGo':
      if (msg.url) {
        const targetUrl = resolvePasteUrl(msg.url);
        const createProps = { url: targetUrl, active: true };
        if (sender.tab?.id) {
          createProps.index = sender.tab.index + 1;
          createProps.openerTabId = sender.tab.id;
        }
        chrome.tabs.create(createProps);
        sendResponse({ success: true });
      }
      return false;
    case 'ocrProcessImage':
      (async () => {
        try {
          await ensureOffscreenDocument();
          let dataUrl = msg.dataUrl;

          // If content script couldn't read cross-origin image pixels, fetch via background
          if (!dataUrl && msg.imgUrl && /^https?:\/\//i.test(msg.imgUrl)) {
            try {
              const res = await fetch(msg.imgUrl, { credentials: 'include' });
              if (res.ok) {
                const arrayBuffer = await res.arrayBuffer();
                const bytes = new Uint8Array(arrayBuffer);
                const len = bytes.byteLength;
                const chunkSize = 16384;
                const chunks = [];
                for (let i = 0; i < len; i += chunkSize) {
                  chunks.push(String.fromCharCode.apply(null, bytes.subarray(i, Math.min(i + chunkSize, len))));
                }
                const base64 = btoa(chunks.join(''));
                const contentType = res.headers.get('content-type') || 'image/png';
                dataUrl = `data:${contentType};base64,${base64}`;
              }
            } catch (fetchErr) {
              console.warn('Background image fetch failed for OCR:', fetchErr);
            }
          }

          if (!dataUrl) {
            sendResponse({ success: false, imageId: msg.imageId, error: 'No image data available' });
            return;
          }

          chrome.runtime.sendMessage({
            target: 'offscreen',
            action: 'OCR_RECOGNIZE',
            imageId: msg.imageId,
            dataUrl: dataUrl
          }, (ocrRes) => {
            refreshOffscreenIdleTimer();
            if (chrome.runtime.lastError) {
              sendResponse({ success: false, imageId: msg.imageId, error: chrome.runtime.lastError.message });
            } else {
              sendResponse(ocrRes || { success: false, imageId: msg.imageId, error: 'No OCR response' });
            }
          });
        } catch (err) {
          refreshOffscreenIdleTimer();
          sendResponse({ success: false, imageId: msg.imageId, error: err?.message || String(err) });
        }
      })();
      return true;
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
    case 'refresh_weather':
      syncWeather(false).then(weather => {
        try {
          sendResponse({ success: Boolean(weather), weather });
        } catch {}
      }).catch(() => {
        try {
          sendResponse({ success: false });
        } catch {}
      });
      return true;
  }
});

const GATEWAY_PARAM_NAMES = ['q', 'url', 'dest', 'destination', 'target', 'u', 'redirect_uri', 'r', 'z', 'link'];

function unwrapGatewayUrl(rawUrl) {
  if (!rawUrl || typeof rawUrl !== 'string') return null;
  if (!rawUrl.includes('?') && !rawUrl.includes('&')) return null;
  if (!rawUrl.includes('http')) return null;
  try {
    const parsed = new URL(rawUrl);
    for (let i = 0; i < GATEWAY_PARAM_NAMES.length; i++) {
      const val = parsed.searchParams.get(GATEWAY_PARAM_NAMES[i]);
      if (val && /^https?:\/\//i.test(val)) {
        return val;
      }
    }
  } catch {}
  return null;
}

const forbiddenFetchHosts = new Set([
  'chromewebstore.google.com',
  'chrome.google.com',
  'clients2.google.com',
  'microsoftedge.microsoft.com',
  'accounts.google.com',
  'myaccount.google.com',
  'support.google.com',
  'mail.google.com',
  'login.microsoftonline.com',
  'account.microsoft.com',
  'appleid.apple.com'
]);

const KNOWN_SHORTENERS = new Set([
  'bit.ly', 't.co', 'tinyurl.com', 'is.gd', 'v.gd', 'amzn.to', 'buff.ly', 'ow.ly',
  'goo.gl', 'qr.ae', 'cutt.ly', 'rb.gy', 'shorturl.at', 'ift.tt', 'trib.al',
  'rebrand.ly', 'lnkd.in', 'linktr.ee', 'rotf.lol', 'tiny.cc', 'lmg.gg', 'redd.it',
  'spoti.fi', 'apple.co', 'w.wiki', 'wapo.st', 'nyti.ms', 'bit.do', 'shorte.st',
  'geni.us', 'a.co', 'snip.ly', 'snip.li', 't.ly', 'dub.sh', 'snip.to', 's.id'
]);

const SHORT_TLDS_REGEX = /\.(gg|ly|to|co|is|gd|cc|link|me|click|fi|ms|it|st|app|bio|us|sh|io|so|at|am|ws|nu|ee|ai|xyz|site)$/i;
const SHORT_SLUG_REGEX = /^\/[a-zA-Z0-9_\-\.]{1,25}\/?$/;

function isShortenerUrl(urlStr) {
  try {
    const url = new URL(urlStr);
    const host = url.hostname.toLowerCase().replace(/^www\./, '');
    const pathname = url.pathname;

    // Never fetch forbidden / internal / store / auth domains
    if (forbiddenFetchHosts.has(host)) return false;
    if (host.endsWith('.google.com') && host !== 'goo.gl') return false;
    if (host.endsWith('.microsoft.com') && host !== 'msft.it') return false;
    if (host.endsWith('.apple.com') && host !== 'apple.co') return false;

    if (shortenersSet.has(host)) return true;
    if (KNOWN_SHORTENERS.has(host)) return true;

    if (host.length <= 14 && SHORT_TLDS_REGEX.test(host) && SHORT_SLUG_REGEX.test(pathname)) {
      return true;
    }
  } catch {}
  return false;
}

async function resolveAndCleanShortUrl(rawUrl) {
  if (!rawUrl || !/^https?:\/\//i.test(rawUrl)) return null;
  await ensureUnshortenCacheInitialized();
  if (unshortenCache.has(rawUrl)) {
    const cachedClean = unshortenCache.get(rawUrl);
    unshortenCache.delete(rawUrl);
    unshortenCache.set(rawUrl, cachedClean);
    if (reverseUnshortenCache.has(cachedClean)) {
      reverseUnshortenCache.delete(cachedClean);
      reverseUnshortenCache.set(cachedClean, rawUrl);
    }
    return cachedClean;
  }

  try {
    let currentUrl = rawUrl;
    
    // Step 1: Unwrap outer platform gateway (YouTube, Google, Reddit, etc.)
    const unwrapped = unwrapGatewayUrl(currentUrl);
    if (unwrapped) currentUrl = unwrapped;

    let finalUrl = currentUrl;

    // Step 2: Only perform network resolution if the URL is an actual shortener (skips standard URLs, Web Store, etc.)
    if (isShortenerUrl(currentUrl)) {
      const requestHeaders = {
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
        'Sec-Fetch-Dest': 'document',
        'Sec-Fetch-Mode': 'navigate',
        'Sec-Fetch-Site': 'cross-site'
      };

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
          try { if (res.body?.cancel) res.body.cancel(); } catch {}
        } else {
          finalUrl = res.url || currentUrl;
        }
      } catch {
        clearTimeout(headTimeoutId);
        finalUrl = currentUrl;
      }

      // Check for nested inner gateway
      const secondUnwrap = unwrapGatewayUrl(finalUrl);
      if (secondUnwrap) finalUrl = secondUnwrap;
    }

    // Step 3: Sanitize through ClearURLs engine
    const cleanUrl = typeof cleanUrlWithClearUrls === 'function' ? cleanUrlWithClearUrls(finalUrl, clearUrlsData) : finalUrl;

    if (unshortenCache.size > 1000) {
      const oldestKey = unshortenCache.keys().next().value;
      const oldestVal = unshortenCache.get(oldestKey);
      unshortenCache.delete(oldestKey);
      if (oldestVal) reverseUnshortenCache.delete(oldestVal);
    }
    if (reverseUnshortenCache.size > 1000) {
      reverseUnshortenCache.delete(reverseUnshortenCache.keys().next().value);
    }
    unshortenCache.set(rawUrl, cleanUrl);
    reverseUnshortenCache.set(cleanUrl, rawUrl);
    persistUnshortenCache();

    return cleanUrl;
  } catch (e) {
    return rawUrl;
  }
}

const DARK_MODE_EXCLUDED_HOSTS = [
  'v3-hub.atk.store',
  'hub.atk.store',
  'atk.store',
  'www.mchose.com.cn',
  'mchose.com.cn'
];

function isDarkModeBlacklisted(urlOrHostname) {
  if (!urlOrHostname) return false;
  try {
    const raw = String(urlOrHostname).trim().toLowerCase();
    const hostname = raw.includes('://') ? new URL(raw).hostname.toLowerCase() : raw.split('/')[0].split(':')[0];
    return DARK_MODE_EXCLUDED_HOSTS.some(ex => hostname === ex || hostname.endsWith('.' + ex));
  } catch {
    return false;
  }
}

async function toggleDarkMode(tabId) {
  if (!tabId) return;

  let tab = null;
  try { tab = await chrome.tabs.get(tabId); } catch {}
  if (tab?.url && isDarkModeBlacklisted(tab.url)) {
    // Hardware web driver portals are strictly exempt from DarkReader injection
    try {
      await chrome.scripting.executeScript({
        target: { tabId },
        func: () => {
          if (typeof DarkReader !== 'undefined' && DarkReader.disable) {
            DarkReader.disable();
          }
          document.documentElement.classList.add('darkreader--disabled');
          document.documentElement.classList.remove('darkreader-ready');
          window.__DARK_MODE_IS_ACTIVE__ = false;
        }
      });
    } catch {}
    updateDomainMemory(tabId, false);
    return;
  }

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

async function injectDarkMode(tabId) {
  try {
    const tab = await chrome.tabs.get(tabId);
    if (tab?.url && isDarkModeBlacklisted(tab.url)) return;
  } catch {}
  chrome.scripting.insertCSS({ target: { tabId }, files: ['fast-inject.css'] });
  chrome.scripting.executeScript({ target: { tabId }, files: ['darkreader.js', 'autodark-init.js'] });
}

async function updateDomainMemory(tabId, isEnabled) {
  try {
    const tab = await chrome.tabs.get(tabId);
    if (!tab?.url || tab.url.startsWith('chrome://') || tab.url.startsWith('https://chrome.google.com/webstore')) return;
    const hostname = new URL(tab.url).hostname.toLowerCase();
    if (!hostname) return;

    if (isDarkModeBlacklisted(hostname)) {
      // Purge any accidental blacklisted entries or parent domains
      const { darkmode_domains = [] } = await chrome.storage.local.get('darkmode_domains');
      const filtered = darkmode_domains.filter(d => !isDarkModeBlacklisted(d));
      if (filtered.length !== darkmode_domains.length) {
        await chrome.storage.local.set({ darkmode_domains: filtered });
        updateRegisteredDarkModeScript(filtered);
      }
      return;
    }

    let { darkmode_domains = [] } = await chrome.storage.local.get('darkmode_domains');
    let changed = false;

    if (isEnabled) {
      if (!darkmode_domains.includes(hostname)) {
        darkmode_domains.push(hostname);
        changed = true;
      }
    } else {
      // When disabling dark mode on a domain/subdomain, remove exact match AND any matching parent domain
      const beforeLen = darkmode_domains.length;
      darkmode_domains = darkmode_domains.filter(d => {
        const lowerD = d.toLowerCase();
        return lowerD !== hostname && !hostname.endsWith('.' + lowerD) && !lowerD.endsWith('.' + hostname);
      });
      if (darkmode_domains.length !== beforeLen) {
        changed = true;
      }
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

    const validDomains = (domains || []).filter(d => !isDarkModeBlacklisted(d));
    if (validDomains.length) {
      const matches = validDomains.flatMap(d => {
        const base = d.replace(/^www\./, '');
        return [`*://${base}/*`, `*://*.${base}/*`];
      });

      const excludeMatches = [
        '*://v3-hub.atk.store/*',
        '*://*.atk.store/*',
        '*://atk.store/*',
        '*://www.mchose.com.cn/*',
        '*://*.mchose.com.cn/*',
        '*://mchose.com.cn/*'
      ];

      try {
        await chrome.scripting.registerContentScripts([
          {
            id: 'dynamic-dark-mode-css',
            matches,
            excludeMatches,
            css: ['fast-inject.css'],
            runAt: 'document_start'
          },
          {
            id: 'dynamic-dark-mode-js',
            matches,
            excludeMatches,
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

// ============================================================================
// Hardware Telemetry Native Host Multiplexer (Singleton)
// ============================================================================
let nativeTelemetryPort = null;
const telemetryClients = new Set();
let lastTelemetryData = null;
let hostTeardownTimer = null;
let lastTelemetrySessionWriteTime = 0;
let lastMonitorConfigSig = null;
let telemetrySessionTimer = null;

function cancelHostTeardown() {
  if (hostTeardownTimer) {
    clearTimeout(hostTeardownTimer);
    hostTeardownTimer = null;
  }
  try {
    chrome.alarms.clear('host_idle_teardown_alarm');
  } catch {}
}

function scheduleHostTeardown() {
  if (hostTeardownTimer) return;
  hostTeardownTimer = setTimeout(() => {
    if (telemetryClients.size === 0) {
      stopNativeTelemetry();
    }
    hostTeardownTimer = null;
  }, 10000);

  try {
    chrome.alarms.create('host_idle_teardown_alarm', {
      when: Date.now() + 10000
    });
  } catch {}
}

// Ephemeral telemetry: ensure any legacy persistent cache is purged
try {
  chrome.storage?.local?.remove(['cached_empirical_monitors', 'cached_monitors']);
} catch (e) {}

const internalDisplaySettings = {
  contrast: 50,
  gainR: 50,
  gainG: 50,
  gainB: 50
};
let isInternalStorageHydrated = false;

try {
  chrome.storage.local.get({
    internalContrast: 50,
    internalGainR: 50,
    internalGainG: 50,
    internalGainB: 50
  }, (res) => {
    if (chrome.runtime.lastError) return;
    if (typeof res?.internalContrast === 'number') internalDisplaySettings.contrast = res.internalContrast;
    if (typeof res?.internalGainR === 'number') internalDisplaySettings.gainR = res.internalGainR;
    if (typeof res?.internalGainG === 'number') internalDisplaySettings.gainG = res.internalGainG;
    if (typeof res?.internalGainB === 'number') internalDisplaySettings.gainB = res.internalGainB;
    isInternalStorageHydrated = true;
    if (nativeTelemetryPort) {
      try {
        nativeTelemetryPort.postMessage({
          action: 'init_internal_display',
          contrast: internalDisplaySettings.contrast,
          gainR: internalDisplaySettings.gainR,
          gainG: internalDisplaySettings.gainG,
          gainB: internalDisplaySettings.gainB
        });
      } catch (e) {}
    }
  });
} catch (e) {}

function recordInternalDisplaySetting(msg) {
  if (!msg || msg.action !== 'set_panel_control') return;
  const ctrl = String(msg.control || '').toLowerCase().replace(/_/g, '');
  const val = Number(msg.value);
  if (isNaN(val)) return;

  if (lastTelemetryData?.monitors) {
    const target = lastTelemetryData.monitors.find(m => m.id === msg.monitorId || m.pnpId === msg.monitorId || (msg.pnpId && m.pnpId === msg.pnpId));
    if (target && msg.control) {
      target[msg.control] = val;
    }
  }

  const isInternal = Boolean(
    msg.isInternal ||
    (lastTelemetryData?.monitors?.find(m => m.id === msg.monitorId || m.pnpId === msg.monitorId || (msg.pnpId && m.pnpId === msg.pnpId))?.isInternal) ||
    (typeof msg.monitorId === 'string' && msg.monitorId.toLowerCase().includes('internal')) ||
    (typeof msg.gdiDevice === 'string' && msg.gdiDevice.includes('DISPLAY1'))
  );

  if (!isInternal) return;

  const clamped = Math.max(0, Math.min(100, val));
  if (ctrl === 'contrast') {
    internalDisplaySettings.contrast = clamped;
    chrome.storage.local.set({ internalContrast: clamped });
  } else if (ctrl === 'gainr') {
    internalDisplaySettings.gainR = clamped;
    chrome.storage.local.set({ internalGainR: clamped });
  } else if (ctrl === 'gaing') {
    internalDisplaySettings.gainG = clamped;
    chrome.storage.local.set({ internalGainG: clamped });
  } else if (ctrl === 'gainb') {
    internalDisplaySettings.gainB = clamped;
    chrome.storage.local.set({ internalGainB: clamped });
  }
}

chrome.runtime.onConnect.addListener((clientPort) => {
  if (clientPort.name !== 'telemetry') return;

  cancelHostTeardown();
  telemetryClients.add(clientPort);

  // Send latest live empirical telemetry frame immediately if available and native host active
  if (nativeTelemetryPort && lastTelemetryData && lastTelemetryData.monitors && lastTelemetryData.cpuLoad !== undefined) {
    try {
      clientPort.postMessage(lastTelemetryData);
    } catch (e) {}
  }

  // Start single native host instance if not already running
  if (!nativeTelemetryPort) {
    startNativeTelemetry();
  }

  clientPort.onMessage.addListener((msg) => {
    cancelHostTeardown();
    if (msg) {
      recordInternalDisplaySetting(msg);
      if (msg.action === 'probe_monitors' || msg.action === 'refresh_monitors') {
        if (typeof msg.contrast !== 'number') msg.contrast = internalDisplaySettings.contrast;
        if (typeof msg.gainR !== 'number') msg.gainR = internalDisplaySettings.gainR;
        if (typeof msg.gainG !== 'number') msg.gainG = internalDisplaySettings.gainG;
        if (typeof msg.gainB !== 'number') msg.gainB = internalDisplaySettings.gainB;
      }
      dispatchNativeHostMessage(msg);
    }
  });

  clientPort.onDisconnect.addListener(() => {
    telemetryClients.delete(clientPort);
    if (telemetryClients.size === 0) {
      const isDataReady = Boolean(
        lastTelemetryData &&
        lastTelemetryData.hasProbed &&
        Array.isArray(lastTelemetryData.monitors) &&
        lastTelemetryData.cpuLoad !== undefined
      );
      if (!isDataReady) {
        stopNativeTelemetry();
      } else {
        scheduleHostTeardown();
      }
    }
  });
});

function startNativeTelemetry() {
  if (nativeTelemetryPort) return;

  try {
    nativeTelemetryPort = chrome.runtime.connectNative('com.gpu.telemetry');

    if (isInternalStorageHydrated) {
      try {
        nativeTelemetryPort.postMessage({
          action: 'init_internal_display',
          contrast: internalDisplaySettings.contrast,
          gainR: internalDisplaySettings.gainR,
          gainG: internalDisplaySettings.gainG,
          gainB: internalDisplaySettings.gainB
        });
      } catch (e) {}
    }

    nativeTelemetryPort.onMessage.addListener((data) => {
      if (data && !data.error) {
        if (data.monitors && data.hasProbed) {
          lastTelemetryData = data;
        } else if (lastTelemetryData) {
          lastTelemetryData = {
            ...data,
            hasProbed: lastTelemetryData.hasProbed,
            monitors: lastTelemetryData.monitors
          };
        } else {
          lastTelemetryData = data;
        }
      }

      // Live dispatches remain immediate at 0ms latency
      const frameToSend = (lastTelemetryData && lastTelemetryData.monitors) ? lastTelemetryData : data;
      for (const client of telemetryClients) {
        try {
          client.postMessage(frameToSend);
        } catch (e) {
          telemetryClients.delete(client);
        }
      }

      if (frameToSend && frameToSend.monitors && Array.isArray(frameToSend.monitors)) {
        const currentSig = frameToSend.monitors.map(m => `${m.id || ''}:${m.windowsDisplayNumber || ''}:${m.width}x${m.height}`).join('|');
        const sigChanged = (lastMonitorConfigSig === null || currentSig !== lastMonitorConfigSig);
        const now = Date.now();
        const elapsed = now - lastTelemetrySessionWriteTime;

        if (sigChanged || elapsed >= 2000) {
          if (telemetrySessionTimer) {
            clearTimeout(telemetrySessionTimer);
            telemetrySessionTimer = null;
          }
          lastTelemetrySessionWriteTime = now;
          lastMonitorConfigSig = currentSig;
          try {
            chrome.storage?.session?.set({ latest_telemetry: frameToSend }).catch(() => {});
          } catch (e) {}
        } else if (!telemetrySessionTimer) {
          telemetrySessionTimer = setTimeout(() => {
            telemetrySessionTimer = null;
            if (lastTelemetryData && chrome.storage?.session) {
              try {
                chrome.storage.session.set({ latest_telemetry: lastTelemetryData }).catch(() => {});
                lastTelemetrySessionWriteTime = Date.now();
                if (lastTelemetryData.monitors) {
                  lastMonitorConfigSig = lastTelemetryData.monitors.map(m => `${m.id || ''}:${m.windowsDisplayNumber || ''}:${m.width}x${m.height}`).join('|');
                }
              } catch (e) {}
            }
          }, 2000 - elapsed);
        }
      }

      if (telemetryClients.size === 0) {
        const isDataReady = Boolean(
          lastTelemetryData &&
          lastTelemetryData.hasProbed &&
          Array.isArray(lastTelemetryData.monitors) &&
          lastTelemetryData.cpuLoad !== undefined
        );
        if (!isDataReady) {
          stopNativeTelemetry();
        } else {
          scheduleHostTeardown();
        }
      }
    });

    nativeTelemetryPort.onDisconnect.addListener(() => {
      const err = chrome.runtime.lastError ? chrome.runtime.lastError.message : 'Host Disconnected';
      nativeTelemetryPort = null;
      lastTelemetryData = null;
      if (telemetrySessionTimer) {
        clearTimeout(telemetrySessionTimer);
        telemetrySessionTimer = null;
      }
      for (const client of telemetryClients) {
        try {
          client.postMessage({ error: true, message: err });
        } catch (e) {
          telemetryClients.delete(client);
        }
      }
    });

    if (telemetryClients.size === 0) {
      scheduleHostTeardown();
    }
  } catch (e) {
    nativeTelemetryPort = null;
    lastTelemetryData = null;
    if (telemetrySessionTimer) {
      clearTimeout(telemetrySessionTimer);
      telemetrySessionTimer = null;
    }
    for (const client of telemetryClients) {
      try {
        client.postMessage({ error: true, message: e.message || 'Host Launch Failed' });
      } catch (err) {}
    }
  }
}

function stopNativeTelemetry() {
  cancelHostTeardown();
  if (telemetrySessionTimer) {
    clearTimeout(telemetrySessionTimer);
    telemetrySessionTimer = null;
  }
  if (nativeTelemetryPort) {
    try {
      nativeTelemetryPort.disconnect();
    } catch (e) {}
    nativeTelemetryPort = null;
  }
  lastTelemetryData = null;
}

// Ensure latest_telemetry is hydrated on service worker startup
(async () => {
  try {
    const sessionData = await chrome.storage?.session?.get('latest_telemetry').catch(() => ({}));
    if (!sessionData?.latest_telemetry?.monitors && !nativeTelemetryPort) {
      startNativeTelemetry();
    }
  } catch {}
})();
