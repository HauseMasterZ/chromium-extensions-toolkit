// --- CToolkit: Strictly Ephemeral Internal Display Auto-Zoom (120% on Laptop Screen ONLY) ---

let internalDisplayBounds = null;
const windowScreenState = new Map(); // windowId -> boolean (isOnInternal)

let isDefaultZoomEnabled = true;
let defaultZoomFactor = 1.20;

// Restore cached display geometry and zoom settings across service worker wakeups
try {
  chrome.storage.local.get(['internalDisplayBounds', 'featureDefaultZoom', 'defaultZoomLevel'], (res) => {
    if (res?.internalDisplayBounds) {
      internalDisplayBounds = res.internalDisplayBounds;
    }
    if (res?.featureDefaultZoom !== undefined) {
      isDefaultZoomEnabled = Boolean(res.featureDefaultZoom);
    }
    if (res?.defaultZoomLevel) {
      defaultZoomFactor = Math.max(1.0, Math.min(2.0, res.defaultZoomLevel / 100));
    }
  });
} catch {}

// React immediately to popup toggle and percentage changes
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

  if (reapply) {
    try {
      const windows = await chrome.windows.getAll();
      for (const win of windows) {
        await syncWindowTabsZoom(win.id);
      }
    } catch {}
  }
});

// 1. Cache the bounding box of the laptop's internal screen
async function updateDisplayLayout() {
  try {
    const displays = await chrome.system.display.getInfo();
    // Match either isInternal flag or fallback to Dell G16's native 2560x1600 panel dimensions
    const internal = displays.find(d => d.isInternal || (d.bounds.width === 2560 && d.bounds.height === 1600));
    if (internal) {
      internalDisplayBounds = internal.bounds;
      try {
        chrome.storage.local.set({ internalDisplayBounds: internal.bounds });
      } catch {}
    }
  } catch (err) {
    console.error('[CToolkit] Display detection error:', err);
  }
}

// 2. Check if a window is positioned on the laptop's internal display
function isWindowOnInternalDisplay(win) {
  if (!internalDisplayBounds || win.left === undefined || win.top === undefined) return false;
  const midX = win.left + (win.width / 2);
  const midY = win.top + (win.height / 2);

  return (
    midX >= internalDisplayBounds.left &&
    midX < (internalDisplayBounds.left + internalDisplayBounds.width) &&
    midY >= internalDisplayBounds.top &&
    midY < (internalDisplayBounds.top + internalDisplayBounds.height)
  );
}

// 3. Apply strictly ephemeral per-tab zoom with zero cross-monitor origin leakage
async function applyDisplayZoom(tabId, windowId, tabUrl) {
  if (!tabId || !windowId) return;

  // Skip browser-restricted URLs where zoom cannot be set
  if (tabUrl && (tabUrl.startsWith('chrome://') || tabUrl.startsWith('chrome-extension://') || tabUrl.startsWith('edge://') || tabUrl.startsWith('devtools://') || tabUrl.startsWith('about:'))) {
    return;
  }

  // 1. Get window position state synchronously from memory
  let onInternal = windowScreenState.get(windowId);
  if (onInternal === undefined) {
    try {
      if (!internalDisplayBounds) await updateDisplayLayout();
      const win = await chrome.windows.get(windowId);
      if (!win) return;
      onInternal = isWindowOnInternalDisplay(win);
      windowScreenState.set(windowId, onInternal);
    } catch {
      return;
    }
  }

  try {
    if (!isDefaultZoomEnabled) {
      // If feature is disabled and tab is on internal display with non-default zoom, restore 1.0 baseline
      if (onInternal) {
        const currentZoom = await chrome.tabs.getZoom(tabId);
        if (Math.abs(currentZoom - 1.0) > 0.01) {
          await chrome.tabs.setZoomSettings(tabId, {
            mode: 'automatic',
            scope: 'per-tab'
          });
          await chrome.tabs.setZoom(tabId, 1.0);
        }
      }
      return;
    }

    if (onInternal) {
      // --- INTERNAL MONITOR ONLY: Strictly isolated ephemeral configured zoom ---
      const currentZoom = await chrome.tabs.getZoom(tabId);
      const settings = await chrome.tabs.getZoomSettings(tabId);
      if (Math.abs(currentZoom - defaultZoomFactor) > 0.005 || settings.scope !== 'per-tab') {
        await chrome.tabs.setZoomSettings(tabId, {
          mode: 'automatic',
          scope: 'per-tab'
        });
        await chrome.tabs.setZoom(tabId, defaultZoomFactor);
      }
    } else {
      // --- EXTERNAL MONITORS: Strict 100% Baseline ---
      const currentZoom = await chrome.tabs.getZoom(tabId);
      if (Math.abs(currentZoom - 1.0) > 0.01) {
        // Clear any past origin-level pollution from disk if present
        await chrome.tabs.setZoomSettings(tabId, {
          mode: 'automatic',
          scope: 'per-origin'
        });
        await chrome.tabs.setZoom(tabId, 1.0);
        // Isolate tab in per-tab scope at 1.0
        await chrome.tabs.setZoomSettings(tabId, {
          mode: 'automatic',
          scope: 'per-tab'
        });
        await chrome.tabs.setZoom(tabId, 1.0);
      }
    }
  } catch {}
}

// 4. Sync all eligible tabs inside a specific window
async function syncWindowTabsZoom(windowId) {
  try {
    const tabs = await chrome.tabs.query({ windowId });
    for (const tab of tabs) {
      if (tab.id) {
        await applyDisplayZoom(tab.id, windowId, tab.url);
      }
    }
  } catch {}
}

// --- Event Triggers: Instantaneous Lifecycle Binding ---

// Initial setup: discover displays and sync existing windows immediately
updateDisplayLayout().then(async () => {
  try {
    const windows = await chrome.windows.getAll();
    for (const win of windows) {
      windowScreenState.set(win.id, isWindowOnInternalDisplay(win));
      await syncWindowTabsZoom(win.id);
    }
  } catch {}
});

// Screen topology changes (docking, HDMI disconnects, display resolution changes)
chrome.system.display.onDisplayChanged.addListener(async () => {
  await updateDisplayLayout();
  windowScreenState.clear();
  try {
    const windows = await chrome.windows.getAll();
    for (const win of windows) {
      windowScreenState.set(win.id, isWindowOnInternalDisplay(win));
      await syncWindowTabsZoom(win.id);
    }
  } catch {}
});

// Window moved across screens: triggers tab re-zoom the instant boundary is crossed
chrome.windows.onBoundsChanged.addListener(async (win) => {
  if (win.state === 'minimized') return;
  if (!internalDisplayBounds) {
    await updateDisplayLayout();
  }
  const onInternal = isWindowOnInternalDisplay(win);
  const previousState = windowScreenState.get(win.id);

  if (previousState !== onInternal) {
    windowScreenState.set(win.id, onInternal);
    await syncWindowTabsZoom(win.id);
  }
});

// New window opened: cache position state immediately
chrome.windows.onCreated.addListener(async (win) => {
  if (win.left !== undefined) {
    windowScreenState.set(win.id, isWindowOnInternalDisplay(win));
  } else {
    try {
      const fullWin = await chrome.windows.get(win.id);
      if (fullWin) windowScreenState.set(win.id, isWindowOnInternalDisplay(fullWin));
    } catch {}
  }
});

// Window closed: clean up state
chrome.windows.onRemoved.addListener((windowId) => {
  windowScreenState.delete(windowId);
});

// INSTANT HOOK 1: Tab created (fires before URL loads, before HTML parses)
chrome.tabs.onCreated.addListener((tab) => {
  if (tab.id && tab.windowId) {
    applyDisplayZoom(tab.id, tab.windowId, tab.url);
  }
});

// INSTANT HOOK 2: Navigation started / URL changed (re-asserts per-tab scope on every origin transition)
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if ((changeInfo.status === 'loading' || changeInfo.url) && tab.windowId) {
    applyDisplayZoom(tabId, tab.windowId, tab.url);
  }
});

// INSTANT HOOK 3: Tab activated / switched
chrome.tabs.onActivated.addListener(async ({ tabId, windowId }) => {
  if (tabId && windowId) {
    try {
      const tab = await chrome.tabs.get(tabId);
      applyDisplayZoom(tabId, windowId, tab?.url);
    } catch {
      applyDisplayZoom(tabId, windowId);
    }
  }
});

// Tab moved between windows (e.g. dragged from internal to external monitor)
chrome.tabs.onAttached.addListener(async (tabId, attachInfo) => {
  try {
    const tab = await chrome.tabs.get(tabId);
    applyDisplayZoom(tabId, attachInfo.newWindowId, tab?.url);
  } catch {
    applyDisplayZoom(tabId, attachInfo.newWindowId);
  }
});
