// --- CToolkit: Resolution-Agnostic Multi-Monitor Ephemeral Display Auto-Zoom ---

let allDisplays = [];
let isDefaultZoomEnabled = true;
let defaultZoomFactor = 1.20;
let displaysZoomConfig = {}; // displayId -> zoom percentage (e.g. 120)

// Memory caches to prevent IPC / setZoom hammering
const windowCurrentDisplay = new Map(); // windowId -> displayId
const appliedTabZoomCache = new Map();  // tabId -> zoomFactor

// Restore cached display geometry and zoom settings across service worker wakeups
try {
  chrome.storage.local.get(['cachedDisplays', 'featureDefaultZoom', 'defaultZoomLevel', 'displaysZoomConfig'], (res) => {
    if (Array.isArray(res?.cachedDisplays) && res.cachedDisplays.length > 0) {
      allDisplays = res.cachedDisplays;
    }
    if (res?.featureDefaultZoom !== undefined) {
      isDefaultZoomEnabled = Boolean(res.featureDefaultZoom);
    }
    if (res?.defaultZoomLevel) {
      defaultZoomFactor = Math.max(1.0, Math.min(2.0, res.defaultZoomLevel / 100));
    }
    if (res?.displaysZoomConfig && typeof res.displaysZoomConfig === 'object') {
      displaysZoomConfig = res.displaysZoomConfig;
    }
  });
} catch {}

// React immediately to popup toggle and per-display zoom percentage changes
chrome.storage.onChanged.addListener(async (changes, area) => {
  if (area !== 'local') return;
  let reapply = false;

  if ('featureDefaultZoom' in changes) {
    isDefaultZoomEnabled = Boolean(changes.featureDefaultZoom.newValue);
    reapply = true;
  }
  if ('defaultZoomLevel' in changes) {
    const lvl = changes.defaultZoomLevel.newValue;
    if (typeof lvl === 'number') {
      defaultZoomFactor = Math.max(1.0, Math.min(2.0, lvl / 100));
      reapply = true;
    }
  }
  if ('displaysZoomConfig' in changes) {
    displaysZoomConfig = changes.displaysZoomConfig.newValue || {};
    reapply = true;
  }

  if (reapply) {
    appliedTabZoomCache.clear();
    await syncAllActiveTabs();
  }
});

// 1. Resolution-agnostic auto-detection of all connected displays
async function updateDisplayLayout() {
  try {
    const displays = await chrome.system.display.getInfo();
    if (Array.isArray(displays) && displays.length > 0) {
      allDisplays = displays;
      try {
        await chrome.storage.local.set({ cachedDisplays: displays });
      } catch {}
    }
  } catch (err) {
    console.error('[CToolkit] Display detection error:', err);
  }
}

// 2. Identify target display for a window based on center coordinates
function getDisplayForWindow(win) {
  if (!allDisplays || allDisplays.length === 0 || win?.left === undefined || win?.top === undefined) {
    return allDisplays?.[0] || null;
  }
  const midX = win.left + (win.width / 2);
  const midY = win.top + (win.height / 2);

  const matched = allDisplays.find(d =>
    midX >= d.bounds.left &&
    midX < (d.bounds.left + d.bounds.width) &&
    midY >= d.bounds.top &&
    midY < (d.bounds.top + d.bounds.height)
  );

  return matched || allDisplays.find(d => d.isPrimary) || allDisplays[0];
}

// 3. Resolve the target zoom factor for a specific display
function getTargetZoomForDisplay(display) {
  if (!isDefaultZoomEnabled) return 1.0;
  if (!display) return 1.0;

  // 1. Check explicit per-display override configured via popup
  if (displaysZoomConfig && display.id && displaysZoomConfig[display.id] !== undefined) {
    const customVal = Number(displaysZoomConfig[display.id]);
    if (!isNaN(customVal) && customVal >= 100 && customVal <= 200) {
      return customVal / 100;
    }
  }

  // 2. If display is internal/laptop panel, default to configured default zoom
  if (display.isInternal) {
    return defaultZoomFactor;
  }

  // 3. External displays default to 100% baseline (1.0)
  return 1.0;
}

// 4. Apply strictly ephemeral per-tab zoom with in-memory caching to avoid redundant IPC
async function applyDisplayZoom(tabId, windowId, tabUrl) {
  if (!tabId || !windowId) return;

  // Skip browser-restricted URLs where zoom cannot be set
  if (tabUrl && (tabUrl.startsWith('chrome://') || tabUrl.startsWith('chrome-extension://') || tabUrl.startsWith('edge://') || tabUrl.startsWith('devtools://') || tabUrl.startsWith('about:'))) {
    return;
  }

  try {
    let currentDisplayId = windowCurrentDisplay.get(windowId);
    let display = allDisplays.find(d => d.id === currentDisplayId);

    if (!display) {
      if (!allDisplays.length) await updateDisplayLayout();
      const win = await chrome.windows.get(windowId);
      if (!win) return;
      display = getDisplayForWindow(win);
      if (display?.id) {
        windowCurrentDisplay.set(windowId, display.id);
      }
    }

    const targetZoom = getTargetZoomForDisplay(display);

    // Fast-path: check in-memory cache to prevent redundant setZoom IPC calls
    if (appliedTabZoomCache.get(tabId) === targetZoom) {
      return;
    }

    const currentZoom = await chrome.tabs.getZoom(tabId);
    const settings = await chrome.tabs.getZoomSettings(tabId);

    if (Math.abs(currentZoom - targetZoom) > 0.005 || settings.scope !== 'per-tab') {
      await chrome.tabs.setZoomSettings(tabId, {
        mode: 'automatic',
        scope: 'per-tab'
      });
      await chrome.tabs.setZoom(tabId, targetZoom);
    }

    appliedTabZoomCache.set(tabId, targetZoom);
  } catch {}
}

// 5. Sync active tab for a specific window
async function syncWindowActiveTab(windowId) {
  try {
    const tabs = await chrome.tabs.query({ windowId, active: true });
    if (tabs?.[0]?.id) {
      await applyDisplayZoom(tabs[0].id, windowId, tabs[0].url);
    }
  } catch {}
}

// 6. Sync active tabs across all open windows
async function syncAllActiveTabs() {
  try {
    const windows = await chrome.windows.getAll();
    for (const win of windows) {
      const display = getDisplayForWindow(win);
      if (display?.id) {
        windowCurrentDisplay.set(win.id, display.id);
      }
      await syncWindowActiveTab(win.id);
    }
  } catch {}
}

// --- Graceful & Debounced Lifecycle Hooks ---

let windowBoundsDebounceTimer = null;
let displayChangeDebounceTimer = null;

// Initial setup: discover displays and sync existing active tabs once
updateDisplayLayout().then(async () => {
  await syncAllActiveTabs();
});

// Display topology changes (docking, HDMI plug/unplug, resolution change): debounced 250ms
chrome.system.display.onDisplayChanged.addListener(() => {
  if (displayChangeDebounceTimer) clearTimeout(displayChangeDebounceTimer);
  displayChangeDebounceTimer = setTimeout(async () => {
    await updateDisplayLayout();
    windowCurrentDisplay.clear();
    appliedTabZoomCache.clear();
    await syncAllActiveTabs();
  }, 250);
});

// Window moved across screens: debounced 120ms to prevent hammering during drag
chrome.windows.onBoundsChanged.addListener((win) => {
  if (win.state === 'minimized') return;

  if (windowBoundsDebounceTimer) clearTimeout(windowBoundsDebounceTimer);
  windowBoundsDebounceTimer = setTimeout(async () => {
    if (!allDisplays.length) await updateDisplayLayout();

    const newDisplay = getDisplayForWindow(win);
    if (!newDisplay?.id) return;

    const prevDisplayId = windowCurrentDisplay.get(win.id);
    if (prevDisplayId !== newDisplay.id) {
      windowCurrentDisplay.set(win.id, newDisplay.id);
      await syncWindowActiveTab(win.id);
    }
  }, 120);
});

// Window opened: cache position immediately
chrome.windows.onCreated.addListener((win) => {
  if (win?.id) {
    const display = getDisplayForWindow(win);
    if (display?.id) {
      windowCurrentDisplay.set(win.id, display.id);
    }
  }
});

// Window closed: evict from memory
chrome.windows.onRemoved.addListener((windowId) => {
  windowCurrentDisplay.delete(windowId);
});

// Tab created: apply display zoom
chrome.tabs.onCreated.addListener((tab) => {
  if (tab?.id && tab?.windowId) {
    applyDisplayZoom(tab.id, tab.windowId, tab.url);
  }
});

// Navigation: only re-evaluate on loading status
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status === 'loading' && tab?.active && tab?.windowId) {
    applyDisplayZoom(tabId, tab.windowId, tab.url);
  }
});

// Tab activated: apply zoom lazily to the selected tab
chrome.tabs.onActivated.addListener(({ tabId, windowId }) => {
  if (tabId && windowId) {
    chrome.tabs.get(tabId).then(tab => {
      applyDisplayZoom(tabId, windowId, tab?.url);
    }).catch(() => {
      applyDisplayZoom(tabId, windowId);
    });
  }
});

// Tab moved between windows (e.g. dragged from internal to external monitor)
chrome.tabs.onAttached.addListener((tabId, attachInfo) => {
  if (tabId && attachInfo?.newWindowId) {
    chrome.tabs.get(tabId).then(tab => {
      applyDisplayZoom(tabId, attachInfo.newWindowId, tab?.url);
    }).catch(() => {
      applyDisplayZoom(tabId, attachInfo.newWindowId);
    });
  }
});

// Tab closed: evict from zoom cache
chrome.tabs.onRemoved.addListener((tabId) => {
  appliedTabZoomCache.delete(tabId);
});
