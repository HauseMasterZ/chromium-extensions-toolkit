// --- CToolkit: Resolution-Agnostic Multi-Monitor Ephemeral Display Auto-Zoom ---

(() => {
  let allDisplays = [];
  let isDefaultZoomEnabled = true;
  let displaysZoomConfig = {};

  let isInitialized = false;
  let initPromise = null;
  let displayLayoutPromise = null;
  let displayChangeDebounceTimer = null;
  let lastMonitorsSignature = '';

  // Window and tab tracking structures
  const windowCurrentDisplay = new Map();  // windowId -> displayId
  const windowBoundsTimers = new Map();     // windowId -> debounce timer
  const tabInFlight = new Map();            // tabId -> Promise
  const appliedTabZoomCache = new Map();    // tabId -> zoomFactor
  const tabNavigatingUntil = new Map();     // tabId -> timestamp
  const tabUserManualZoom = new Map();      // tabId -> userZoomFactor
  const tabLastUrl = new Map();             // tabId -> normalized base URL without hash

  const pendingPurgedTabs = new Set();
  const pendingPurgedWindows = new Set();

  const programmaticZoomActive = new Set();
  const programmaticZoomUntil = new Map();

  function markProgrammaticZoomStart(tabId) {
    if (!tabId) return;
    programmaticZoomActive.add(tabId);
    programmaticZoomUntil.set(tabId, Date.now() + 500);
  }

  function markProgrammaticZoomEnd(tabId) {
    if (!tabId) return;
    programmaticZoomActive.delete(tabId);
    const now = Date.now();
    programmaticZoomUntil.set(tabId, now + 200);
    if (programmaticZoomUntil.size > 50) {
      for (const [id, exp] of programmaticZoomUntil) {
        if (exp <= now) programmaticZoomUntil.delete(id);
      }
    }
  }

  function isProgrammaticZoom(tabId) {
    if (!tabId) return false;
    if (programmaticZoomActive.has(tabId)) return true;
    const until = programmaticZoomUntil.get(tabId);
    if (until) {
      if (Date.now() < until) return true;
      programmaticZoomUntil.delete(tabId);
    }
    return false;
  }

  let persistTabZoomPending = false;
  function persistTabUserManualZoom() {
    if (persistTabZoomPending) return;
    persistTabZoomPending = true;
    queueMicrotask(async () => {
      try {
        await ensureInitialized();
        if (chrome.storage?.session) {
          const obj = {};
          for (const [k, v] of tabUserManualZoom.entries()) {
            obj[k] = v;
          }
          await chrome.storage.session.set({ zoom_tab_user_manual: obj });
        }
      } catch {} finally {
        persistTabZoomPending = false;
      }
    });
  }

  let persistWindowDisplayPending = false;
  function persistWindowCurrentDisplay() {
    if (persistWindowDisplayPending) return;
    persistWindowDisplayPending = true;
    queueMicrotask(async () => {
      try {
        await ensureInitialized();
        if (chrome.storage?.session) {
          const obj = {};
          for (const [k, v] of windowCurrentDisplay.entries()) {
            obj[k] = v;
          }
          await chrome.storage.session.set({ zoom_window_current_display: obj });
        }
      } catch {} finally {
        persistWindowDisplayPending = false;
      }
    });
  }

  function getUrlWithoutHash(url) {
    if (!url || typeof url !== 'string') return '';
    const hashIdx = url.indexOf('#');
    return hashIdx !== -1 ? url.slice(0, hashIdx) : url;
  }

  function markTabNavigating(tabId) {
    if (tabId) {
      tabNavigatingUntil.set(tabId, Date.now() + 600);
    }
  }

  // 1. Resolution-agnostic telemetry monitor correlator
  function annotateDisplaysWithTelemetry(displays, telemetryMonitors) {
    if (!Array.isArray(displays) || displays.length === 0) return displays;
    if (!Array.isArray(telemetryMonitors) || telemetryMonitors.length === 0) return displays;

    const usedMonitors = new Set();
    const usedNumbers = new Set();

    // Pass 1: Explicit internal monitor matching
    const internalMon = telemetryMonitors.find(mon => mon.isInternal);
    let internalDisplay = null;

    if (internalMon) {
      // 1A. High-confidence physical resolution match (exact or rotated)
      if (internalMon.width && internalMon.height) {
        internalDisplay = displays.find(d => d.bounds && (
          (d.bounds.width === internalMon.width && d.bounds.height === internalMon.height) ||
          (d.bounds.width === internalMon.height && d.bounds.height === internalMon.width)
        ));
      }

      // 1B. PnP ID or GDI device match
      if (!internalDisplay && internalMon.pnpId) {
        internalDisplay = displays.find(d => d.id && (d.id.includes(internalMon.pnpId) || d.id === internalMon.pnpId));
      }
      if (!internalDisplay && internalMon.gdiDevice) {
        internalDisplay = displays.find(d => d.id && d.id.includes(internalMon.gdiDevice));
      }

      // 1C. Match against last known internal display ID if resolution is consistent
      if (!internalDisplay) {
        internalDisplay = displays.find(d => d.isInternal && d.bounds && (
          !internalMon.width || !internalMon.height ||
          (d.bounds.width === internalMon.width && d.bounds.height === internalMon.height) ||
          (d.bounds.width === internalMon.height && d.bounds.height === internalMon.width)
        ));
      }

      // 1D. Single display system fallback
      if (!internalDisplay && displays.length === 1) {
        internalDisplay = displays[0];
      }

      // Strip any bogus isInternal flags from other displays
      displays.forEach(d => {
        if (d !== internalDisplay) d.isInternal = false;
      });

      if (internalDisplay) {
        internalDisplay.isInternal = true;
        internalDisplay.windowsDisplayNumber = internalMon.windowsDisplayNumber || 1;
        usedMonitors.add(internalMon);
        usedNumbers.add(internalDisplay.windowsDisplayNumber);
      }
    }

    // Pass 2: High-confidence matching for remaining displays (resolution bounds, PNP ID, GDI device, or model name)
    for (const d of displays) {
      if (d === internalDisplay) continue;
      const dId = d.id || '';
      const dName = (d.name || '').toLowerCase();
      const match = telemetryMonitors.find(mon => {
        if (usedMonitors.has(mon)) return false;
        if (mon.isInternal) return false;
        if (mon.pnpId && (dId.includes(mon.pnpId) || dId === mon.pnpId)) return true;
        if (mon.gdiDevice && dId.includes(mon.gdiDevice)) return true;
        if (mon.width && mon.height && d.bounds) {
          const matchExact = (d.bounds.width === mon.width && d.bounds.height === mon.height);
          const matchRotated = (d.bounds.width === mon.height && d.bounds.height === mon.width);
          if (matchExact || matchRotated) return true;
        }
        if (mon.name && d.name && d.name !== 'Generic PnP Monitor' && d.name !== 'Internal Display') {
          const monName = mon.name.toLowerCase();
          if (dName === monName || dName.includes(monName) || monName.includes(dName)) {
            return true;
          }
        }
        return false;
      });

      if (match) {
        usedMonitors.add(match);
        d.windowsDisplayNumber = match.windowsDisplayNumber;
        usedNumbers.add(d.windowsDisplayNumber);
        d.isInternal = Boolean(match.isInternal);
      } else {
        delete d.windowsDisplayNumber;
      }
    }

    // Pass 3: Align remaining displays with remaining telemetry monitors by spatial order
    const remainingMonitors = telemetryMonitors
      .filter(m => !usedMonitors.has(m) && !m.isInternal)
      .sort((a, b) => (a.windowsDisplayNumber || 0) - (b.windowsDisplayNumber || 0));
    const remainingDisplays = displays
      .filter(d => d !== internalDisplay && (!d.windowsDisplayNumber || (usedNumbers.has(d.windowsDisplayNumber) && displays.filter(x => x.windowsDisplayNumber === d.windowsDisplayNumber).length > 1)))
      .sort((a, b) => (a.bounds?.left || 0) - (b.bounds?.left || 0) || (a.bounds?.top || 0) - (b.bounds?.top || 0));

    for (let i = 0; i < Math.min(remainingMonitors.length, remainingDisplays.length); i++) {
      remainingDisplays[i].windowsDisplayNumber = remainingMonitors[i].windowsDisplayNumber;
      usedMonitors.add(remainingMonitors[i]);
      usedNumbers.add(remainingMonitors[i].windowsDisplayNumber);
    }

    // Pass 4: Final Deduplication & Monotonic Guarantee
    const assignedNumbers = new Set();
    const sorted = [...displays].sort((a, b) => {
      const numA = (typeof a.windowsDisplayNumber === 'number' && a.windowsDisplayNumber > 0) ? a.windowsDisplayNumber : (a.isInternal ? 1 : 999);
      const numB = (typeof b.windowsDisplayNumber === 'number' && b.windowsDisplayNumber > 0) ? b.windowsDisplayNumber : (b.isInternal ? 1 : 999);
      if (numA !== numB) return numA - numB;
      return (a.bounds?.left || 0) - (b.bounds?.left || 0);
    });

    let nextFallbackNum = 1;
    for (const d of sorted) {
      if (!d.windowsDisplayNumber || assignedNumbers.has(d.windowsDisplayNumber)) {
        while (assignedNumbers.has(nextFallbackNum)) {
          nextFallbackNum++;
        }
        d.windowsDisplayNumber = nextFallbackNum;
      }
      assignedNumbers.add(d.windowsDisplayNumber);
    }

    // Persist known internal display ID to preserve across host reconnects
    const foundInternal = displays.find(d => d.isInternal);
    if (foundInternal?.id) {
      try {
        chrome.storage.local.set({ lastKnownInternalDisplayId: foundInternal.id });
      } catch {}
    }

    return displays;
  }

  // 2. Ensure storage and display layout are pre-hydrated across service worker wakeups
  async function ensureInitialized() {
    if (isInitialized) return;
    if (initPromise) return initPromise;

    initPromise = (async () => {
      try {
        const res = await chrome.storage.local.get([
          'cachedDisplays',
          'featureDefaultZoom',
          'displaysZoomConfig',
          'lastKnownInternalDisplayId'
        ]);
        if (Array.isArray(res?.cachedDisplays) && res.cachedDisplays.length > 0) {
          allDisplays = res.cachedDisplays;
          const seenCachedNums = new Set();
          let hasDupes = false;
          for (const d of allDisplays) {
            if (d.windowsDisplayNumber && seenCachedNums.has(d.windowsDisplayNumber)) {
              hasDupes = true;
              delete d.windowsDisplayNumber;
            } else if (d.windowsDisplayNumber) {
              seenCachedNums.add(d.windowsDisplayNumber);
            }
          }
          if (hasDupes) {
            allDisplays.forEach((d, idx) => {
              if (!d.windowsDisplayNumber) d.windowsDisplayNumber = idx + 1;
            });
            chrome.storage.local.set({ cachedDisplays: allDisplays }).catch(() => {});
          }
        }
        if (res?.featureDefaultZoom !== undefined) {
          isDefaultZoomEnabled = Boolean(res.featureDefaultZoom);
        }
        if (res?.displaysZoomConfig && typeof res.displaysZoomConfig === 'object') {
          displaysZoomConfig = res.displaysZoomConfig;
        }
        if (res?.lastKnownInternalDisplayId && allDisplays.length > 0 && !allDisplays.some(d => d.isInternal)) {
          const matched = allDisplays.find(d => d.id === res.lastKnownInternalDisplayId);
          if (matched) matched.isInternal = true;
        }

        try {
          const sessionData = chrome.storage?.session ? await chrome.storage.session.get('latest_telemetry').catch(() => ({})) : {};
          const latest_telemetry = sessionData?.latest_telemetry;
          if (latest_telemetry?.monitors && allDisplays.length > 0) {
            annotateDisplaysWithTelemetry(allDisplays, latest_telemetry.monitors);
          }
        } catch {}
      } catch {}

      try {
        if (chrome.storage?.session) {
          const sessionRes = await chrome.storage.session.get([
            'zoom_tab_user_manual',
            'zoom_window_current_display'
          ]);

          if (sessionRes?.zoom_tab_user_manual && typeof sessionRes.zoom_tab_user_manual === 'object') {
            let openTabIds = null;
            try {
              const openTabs = await chrome.tabs.query({});
              openTabIds = new Set(openTabs.map(t => t.id).filter(Boolean));
              for (const t of openTabs) {
                if (t.id && (t.url || t.pendingUrl)) {
                  tabLastUrl.set(t.id, getUrlWithoutHash(t.url || t.pendingUrl));
                }
              }
            } catch {}

            for (const [tabIdStr, zoomVal] of Object.entries(sessionRes.zoom_tab_user_manual)) {
              const tId = Number(tabIdStr);
              if (!isNaN(tId) && typeof zoomVal === 'number' && (!openTabIds || openTabIds.has(tId)) && !pendingPurgedTabs.has(tId) && !tabUserManualZoom.has(tId)) {
                tabUserManualZoom.set(tId, zoomVal);
              }
            }
            pendingPurgedTabs.clear();
          }

          if (sessionRes?.zoom_window_current_display && typeof sessionRes.zoom_window_current_display === 'object') {
            let openWinIds = null;
            try {
              const openWindows = await chrome.windows.getAll();
              openWinIds = new Set(openWindows.map(w => w.id).filter(Boolean));
            } catch {}

            for (const [winIdStr, dispId] of Object.entries(sessionRes.zoom_window_current_display)) {
              const wId = Number(winIdStr);
              if (!isNaN(wId) && typeof dispId === 'string' && (!openWinIds || openWinIds.has(wId)) && !pendingPurgedWindows.has(wId) && !windowCurrentDisplay.has(wId)) {
                windowCurrentDisplay.set(wId, dispId);
              }
            }
          }

          persistTabUserManualZoom();
          persistWindowCurrentDisplay();
        }
      } catch {} finally {
        pendingPurgedTabs.clear();
        pendingPurgedWindows.clear();
      }

      if (!allDisplays || allDisplays.length === 0) {
        await updateDisplayLayout();
      }
      isInitialized = true;
    })();

    return initPromise;
  }

  // 3. Dynamic display layout enumeration with telemetry correlation
  async function updateDisplayLayout() {
    if (displayLayoutPromise) return displayLayoutPromise;

    displayLayoutPromise = (async () => {
      try {
        const liveDisplays = await chrome.system.display.getInfo();
        if (Array.isArray(liveDisplays) && liveDisplays.length > 0) {
          // Carry over previous annotations so telemetry is never wiped out
          const displays = liveDisplays.map(d => {
            const prev = allDisplays.find(p => p.id === d.id);
            if (prev) {
              if (prev.windowsDisplayNumber) d.windowsDisplayNumber = prev.windowsDisplayNumber;
              if (prev.isInternal) d.isInternal = true;
            }
            return d;
          });

          try {
            const sessionData = chrome.storage?.session ? await chrome.storage.session.get('latest_telemetry').catch(() => ({})) : {};
            const latest_telemetry = sessionData?.latest_telemetry;
            if (latest_telemetry?.monitors) {
              annotateDisplaysWithTelemetry(displays, latest_telemetry.monitors);
            } else {
              const { lastKnownInternalDisplayId } = await chrome.storage.local.get('lastKnownInternalDisplayId');
              if (lastKnownInternalDisplayId && !displays.some(d => d.isInternal)) {
                const matched = displays.find(d => d.id === lastKnownInternalDisplayId);
                if (matched) matched.isInternal = true;
              }
            }
          } catch {}

          if (!displays.some(d => typeof d.windowsDisplayNumber === 'number' && d.windowsDisplayNumber > 0)) {
            const sortedByPos = [...displays].sort((a, b) => {
              if (a.isInternal && !b.isInternal) return -1;
              if (b.isInternal && !a.isInternal) return 1;
              return (a.bounds?.left || 0) - (b.bounds?.left || 0);
            });
            sortedByPos.forEach((d, idx) => {
              d.windowsDisplayNumber = idx + 1;
            });
          }

          allDisplays = displays;
          try {
            await chrome.storage.local.set({ cachedDisplays: displays });
          } catch {}
        }
      } catch (err) {
        console.error('[CToolkit] Display detection error:', err);
      } finally {
        displayLayoutPromise = null;
      }
    })();

    return displayLayoutPromise;
  }

  // 4. Resolve target display for a window using robust bounding box overlap area
  function getDisplayForWindow(win) {
    if (!allDisplays || allDisplays.length === 0) return null;
    if (!win) {
      return allDisplays.find(d => d.isPrimary) || allDisplays[0];
    }

    // Minimized windows on Windows report coordinates at -32000, -32000
    if (win.state === 'minimized' || (typeof win.left === 'number' && win.left < -10000)) {
      const cachedDisplayId = win.id ? windowCurrentDisplay.get(win.id) : null;
      return allDisplays.find(d => d.id === cachedDisplayId) || allDisplays.find(d => d.isPrimary) || allDisplays[0];
    }

    if (win.left === undefined || win.top === undefined) {
      return allDisplays.find(d => d.isPrimary) || allDisplays[0];
    }

    let winLeft = win.left;
    let winTop = win.top;
    let winWidth = win.width || 0;
    let winHeight = win.height || 0;

    // Compensate for Windows 8px invisible border padding on maximized windows
    if (win.state === 'maximized') {
      winLeft += 8;
      winTop += 8;
      winWidth = Math.max(0, winWidth - 16);
      winHeight = Math.max(0, winHeight - 16);
    }

    // A. Highest intersection (overlap) area with display bounds
    if (winWidth > 0 && winHeight > 0) {
      let bestDisplay = null;
      let maxArea = 0;

      for (const d of allDisplays) {
        if (!d.bounds) continue;
        const overlapLeft = Math.max(winLeft, d.bounds.left);
        const overlapRight = Math.min(winLeft + winWidth, d.bounds.left + d.bounds.width);
        const overlapTop = Math.max(winTop, d.bounds.top);
        const overlapBottom = Math.min(winTop + winHeight, d.bounds.top + d.bounds.height);

        const w = Math.max(0, overlapRight - overlapLeft);
        const h = Math.max(0, overlapBottom - overlapTop);
        const area = w * h;

        if (area > maxArea) {
          maxArea = area;
          bestDisplay = d;
        }
      }

      if (bestDisplay && maxArea > 0) {
        return bestDisplay;
      }
    }

    // B. Midpoint containment fallback
    const midX = winLeft + (winWidth / 2);
    const midY = winTop + (winHeight / 2);

    const matchedMid = allDisplays.find(d =>
      d.bounds &&
      midX >= d.bounds.left &&
      midX < (d.bounds.left + d.bounds.width) &&
      midY >= d.bounds.top &&
      midY < (d.bounds.top + d.bounds.height)
    );
    if (matchedMid) return matchedMid;

    // C. Closest display center by Euclidean distance (for off-screen / border margin padding)
    let closestDisplay = null;
    let minDistanceSq = Infinity;
    for (const d of allDisplays) {
      if (!d.bounds) continue;
      const dispCenterX = d.bounds.left + (d.bounds.width / 2);
      const dispCenterY = d.bounds.top + (d.bounds.height / 2);
      const distSq = ((midX - dispCenterX) ** 2) + ((midY - dispCenterY) ** 2);
      if (distSq < minDistanceSq) {
        minDistanceSq = distSq;
        closestDisplay = d;
      }
    }

    return closestDisplay || allDisplays.find(d => d.isPrimary) || allDisplays[0];
  }

  // 5. Resolve target zoom factor for a display
  function getTargetZoomForDisplay(display) {
    if (!isDefaultZoomEnabled || !display) return null;
    return getZoomValFromConfig(displaysZoomConfig, display);
  }

  function getZoomValFromConfig(cfg, display) {
    if (!cfg || typeof cfg !== 'object' || !display) return null;
    const keys = [
      (typeof display.windowsDisplayNumber === 'number' && display.windowsDisplayNumber > 0) ? `#${display.windowsDisplayNumber}` : null,
      (typeof display.windowsDisplayNumber === 'number' && display.windowsDisplayNumber > 0) ? String(display.windowsDisplayNumber) : null,
      display.windowsDisplayNumber,
      display.id,
      display.name
    ];
    for (const key of keys) {
      if (key !== null && key !== undefined && cfg[key] !== undefined) {
        const val = cfg[key];
        if (val === 'default' || val === '' || val === false || val === null) return null;
        const num = Number(val);
        if (!isNaN(num) && num >= 100 && num <= 200) return num / 100;
      }
    }
    return null;
  }

  async function resetTabsOnDisplayToNative(display) {
    if (!display) return;
    try {
      const windows = await chrome.windows.getAll();
      const matchWins = windows.filter(win => {
        if (win.state === 'minimized' || (typeof win.left === 'number' && win.left < -10000)) return false;
        const d = getDisplayForWindow(win);
        return d && (d.id === display.id || (d.windowsDisplayNumber && d.windowsDisplayNumber === display.windowsDisplayNumber));
      });
      await Promise.all(matchWins.map(async (win) => {
        const tabs = await chrome.tabs.query({ windowId: win.id });
        await Promise.all(tabs.map(async (t) => {
          if (t.id && !isRestrictedUrl(t.url)) {
            tabUserManualZoom.delete(t.id);
            appliedTabZoomCache.delete(t.id);
            markProgrammaticZoomStart(t.id);
            try {
              await chrome.tabs.setZoom(t.id, 0);
              await chrome.tabs.setZoomSettings(t.id, { mode: 'automatic', scope: 'per-origin' });
            } catch {} finally {
              markProgrammaticZoomEnd(t.id);
            }
          }
        }));
      }));
      persistTabUserManualZoom();
    } catch {}
  }

  async function resetAllTabsToNative() {
    try {
      appliedTabZoomCache.clear();
      const tabs = await chrome.tabs.query({});
      await Promise.all(tabs.map(async (t) => {
        if (t.id && !isRestrictedUrl(t.url)) {
          tabUserManualZoom.delete(t.id);
          markProgrammaticZoomStart(t.id);
          try {
            await chrome.tabs.setZoom(t.id, 0);
            await chrome.tabs.setZoomSettings(t.id, { mode: 'automatic', scope: 'per-origin' });
          } catch {} finally {
            markProgrammaticZoomEnd(t.id);
          }
        }
      }));
      persistTabUserManualZoom();
    } catch {}
  }

  // 6. Inspect tab URL eligibility for zoom control
  function isRestrictedUrl(url) {
    if (!url) return false;
    return /^(chrome|chrome-search|devtools|edge|view-source):/i.test(url) ||
           url.includes('chromewebstore.google.com') ||
           url.includes('chrome.google.com/webstore');
  }

  // 7. Serialized per-tab zoom enforcement avoiding concurrency races
  function applyDisplayZoom(tabId, windowId, tabUrl, options = {}) {
    if (!tabId) return;

    const currentInFlight = tabInFlight.get(tabId) || Promise.resolve();
    const nextOp = currentInFlight
      .catch(() => {})
      .then(async () => {
        await applyDisplayZoomCore(tabId, windowId, tabUrl, options);
      })
      .catch(() => {})
      .finally(() => {
        if (tabInFlight.get(tabId) === nextOp) {
          tabInFlight.delete(tabId);
        }
      });

    tabInFlight.set(tabId, nextOp);
  }

  // 8. Core zoom application with ground-truth caching and zero IPC hammer
  async function applyDisplayZoomCore(tabId, windowId, tabUrl, options = {}) {
    if (tabUserManualZoom.has(tabId)) {
      return;
    }

    await ensureInitialized();

    let tab = null;
    try {
      tab = await chrome.tabs.get(tabId);
    } catch {
      return; // Tab closed or unavailable
    }
    if (!tab) return;

    const resolvedWindowId = tab.windowId || windowId;
    const effectiveUrl = tab.pendingUrl || tab.url || tabUrl;

    if (effectiveUrl) {
      tabLastUrl.set(tabId, getUrlWithoutHash(effectiveUrl));
    }

    if (isRestrictedUrl(effectiveUrl)) return;

    if (!allDisplays || allDisplays.length === 0) {
      await updateDisplayLayout();
    }

    let display = null;
    if (resolvedWindowId) {
      if (!options.force) {
        const cachedDisplayId = windowCurrentDisplay.get(resolvedWindowId);
        if (cachedDisplayId) {
          display = allDisplays.find(d => d.id === cachedDisplayId);
        }
      }
      if (!display) {
        try {
          const win = await chrome.windows.get(resolvedWindowId);
          if (win && win.state !== 'minimized' && (typeof win.left !== 'number' || win.left >= -10000)) {
            display = getDisplayForWindow(win);
            if (display?.id) {
              windowCurrentDisplay.set(resolvedWindowId, display.id);
              persistWindowCurrentDisplay();
            }
          }
        } catch {}
      }
    }

    if (!display) {
      const cachedDisplayId = resolvedWindowId ? windowCurrentDisplay.get(resolvedWindowId) : null;
      display = allDisplays.find(d => d.id === cachedDisplayId) || allDisplays.find(d => d.isPrimary) || allDisplays[0];
    }

    const targetZoom = getTargetZoomForDisplay(display);

    // If monitor has no zoom override configured, do not enforce zoom
    if (targetZoom === null) {
      appliedTabZoomCache.delete(tabId);
      if (!tabUserManualZoom.has(tabId)) {
        try {
          const currentSettings = await chrome.tabs.getZoomSettings(tabId);
          if (currentSettings.scope === 'per-tab') {
            markProgrammaticZoomStart(tabId);
            try {
              await chrome.tabs.setZoom(tabId, 0);
              await chrome.tabs.setZoomSettings(tabId, { mode: 'automatic', scope: 'per-origin' });
            } catch {} finally {
              markProgrammaticZoomEnd(tabId);
            }
          }
        } catch {}
      }
      return;
    }

    // Fast-path: check in-memory cache to prevent redundant setZoom IPC calls
    if (!options.force && appliedTabZoomCache.get(tabId) === targetZoom) {
      return;
    }

    try {
      const [currentZoom, currentSettings] = await Promise.all([
        chrome.tabs.getZoom(tabId),
        chrome.tabs.getZoomSettings(tabId)
      ]);

      const zoomDiff = Math.abs(currentZoom - targetZoom);
      const scopeMismatch = currentSettings.scope !== 'per-tab';
      const shouldApply = options.force || zoomDiff > 0.005 || scopeMismatch;

      if (shouldApply) {
        markProgrammaticZoomStart(tabId);
        try {
          await chrome.tabs.setZoomSettings(tabId, {
            mode: 'automatic',
            scope: 'per-tab'
          });
          await chrome.tabs.setZoom(tabId, targetZoom);
        } finally {
          markProgrammaticZoomEnd(tabId);
        }
      }
      appliedTabZoomCache.set(tabId, targetZoom);
    } catch {}
  }

  // 11. Sync active tab for a specific window
  async function syncWindowActiveTab(windowId) {
    if (!windowId) return;
    try {
      const tabs = await chrome.tabs.query({ windowId, active: true });
      if (tabs?.[0]?.id) {
        if (!tabUserManualZoom.has(tabs[0].id)) {
          applyDisplayZoom(tabs[0].id, windowId, tabs[0].pendingUrl || tabs[0].url, { force: true });
        }
      }
    } catch {}
  }

  // 12. Sync all tabs inside a specific window (used when window crosses display boundaries)
  async function syncWindowAllTabs(windowId) {
    if (!windowId) return;
    try {
      const tabs = await chrome.tabs.query({ windowId });
      for (const tab of tabs) {
        if (tab.id && !tab.active && !tabUserManualZoom.has(tab.id)) {
          applyDisplayZoom(tab.id, windowId, tab.pendingUrl || tab.url, { force: true });
        }
      }
    } catch {}
  }

  // 13. Sync active tabs across all open windows
  async function syncAllActiveTabs() {
    try {
      const windows = await chrome.windows.getAll();
      await Promise.all(windows.map(async (win) => {
        if (win.state === 'minimized' || (typeof win.left === 'number' && win.left < -10000)) return;
        const display = getDisplayForWindow(win);
        if (display?.id) {
          windowCurrentDisplay.set(win.id, display.id);
        }
        await syncWindowActiveTab(win.id);
      }));
      persistWindowCurrentDisplay();
    } catch {}
  }

  // --- Resilient Lifecycle Hooks ---

  // Initial setup: ensure layout and sync existing tabs
  ensureInitialized().then(async () => {
    await syncAllActiveTabs();
  });

  // Display topology changes (docking, HDMI plug/unplug, resolution change): debounced 200ms
  chrome.system.display.onDisplayChanged.addListener(() => {
    if (displayChangeDebounceTimer) clearTimeout(displayChangeDebounceTimer);
    displayChangeDebounceTimer = setTimeout(async () => {
      await updateDisplayLayout();
      windowCurrentDisplay.clear();
      persistWindowCurrentDisplay();
      await syncAllActiveTabs();
    }, 200);
  });

  // Window moved across screens: debounced per-window 80ms
  chrome.windows.onBoundsChanged.addListener((win) => {
    if (win.state === 'minimized' || (typeof win.left === 'number' && win.left < -10000)) return;

    let timer = windowBoundsTimers.get(win.id);
    if (timer) clearTimeout(timer);

    timer = setTimeout(async () => {
      windowBoundsTimers.delete(win.id);
      try {
        await ensureInitialized();
        const freshWin = await chrome.windows.get(win.id);
        if (!freshWin || freshWin.state === 'minimized' || (typeof freshWin.left === 'number' && freshWin.left < -10000)) return;

        if (!allDisplays.length) await updateDisplayLayout();

        const newDisplay = getDisplayForWindow(freshWin);
        if (!newDisplay?.id) return;

        const prevDisplayId = windowCurrentDisplay.get(freshWin.id);
        if (prevDisplayId !== newDisplay.id) {
          windowCurrentDisplay.set(freshWin.id, newDisplay.id);
          persistWindowCurrentDisplay();
          await syncWindowActiveTab(freshWin.id);
          await syncWindowAllTabs(freshWin.id);
        }
      } catch {}
    }, 80);

    windowBoundsTimers.set(win.id, timer);
  });

  // Window opened: cache position immediately
  chrome.windows.onCreated.addListener((win) => {
    if (win?.id && win.state !== 'minimized' && (typeof win.left !== 'number' || win.left >= -10000)) {
      const display = getDisplayForWindow(win);
      if (display?.id) {
        windowCurrentDisplay.set(win.id, display.id);
        persistWindowCurrentDisplay();
      }
    }
  });

  // Window focused: sync active tab to heal across external app switching or monitor wake
  chrome.windows.onFocusChanged.addListener(async (windowId) => {
    if (windowId === chrome.windows.WINDOW_ID_NONE) return;
    try {
      await ensureInitialized();
      const win = await chrome.windows.get(windowId);
      if (win && win.state !== 'minimized' && (typeof win.left !== 'number' || win.left >= -10000)) {
        const display = getDisplayForWindow(win);
        if (display?.id) {
          windowCurrentDisplay.set(win.id, display.id);
          persistWindowCurrentDisplay();
        }
        await syncWindowActiveTab(windowId);
      }
    } catch {}
  });

  // Window closed: evict from memory
  chrome.windows.onRemoved.addListener((windowId) => {
    windowCurrentDisplay.delete(windowId);
    if (!isInitialized) pendingPurgedWindows.add(windowId);
    persistWindowCurrentDisplay();
    const timer = windowBoundsTimers.get(windowId);
    if (timer) {
      clearTimeout(timer);
      windowBoundsTimers.delete(windowId);
    }
  });

  // Native zoom change reconciliation: catch Chromium document commit reset or detect user manual zoom
  chrome.tabs.onZoomChange.addListener(async (zoomChangeInfo) => {
    if (!isDefaultZoomEnabled) return;
    const { tabId, newZoomFactor, zoomSettings } = zoomChangeInfo;
    if (!tabId || isProgrammaticZoom(tabId)) return;

    try {
      await ensureInitialized();
      const tab = await chrome.tabs.get(tabId);
      if (!tab) return;
      const effectiveUrl = tab.pendingUrl || tab.url;
      if (isRestrictedUrl(effectiveUrl)) return;

      let display = null;
      if (tab.windowId) {
        const cachedDisplayId = windowCurrentDisplay.get(tab.windowId);
        display = allDisplays.find(d => d.id === cachedDisplayId);
        if (!display) {
          const win = await chrome.windows.get(tab.windowId);
          if (win && win.state !== 'minimized' && (typeof win.left !== 'number' || win.left >= -10000)) {
            display = getDisplayForWindow(win);
            if (display?.id) {
              windowCurrentDisplay.set(tab.windowId, display.id);
              persistWindowCurrentDisplay();
            }
          }
        }
      }
      if (!display) {
        display = allDisplays.find(d => d.isPrimary) || allDisplays[0];
      }

      const targetZoom = getTargetZoomForDisplay(display);
      if (targetZoom === null) {
        // Monitor has no zoom override configured.
        // If tab already has an active manual zoom session, update to preserve latest user zoom.
        if (tabUserManualZoom.has(tabId)) {
          tabUserManualZoom.set(tabId, newZoomFactor);
          persistTabUserManualZoom();
        }
        return;
      }

      // If zoom factor matches the monitor's target zoom and per-tab scope is intact
      if (Math.abs(newZoomFactor - targetZoom) <= 0.005 && zoomSettings.scope === 'per-tab') {
        tabUserManualZoom.delete(tabId);
        persistTabUserManualZoom();
        return;
      }

      // If tab already has this exact manual zoom recorded
      if (tabUserManualZoom.has(tabId) && Math.abs(newZoomFactor - tabUserManualZoom.get(tabId)) <= 0.005 && zoomSettings.scope === 'per-tab') {
        return;
      }

      const isNavigating = (tabNavigatingUntil.get(tabId) || 0) > Date.now();
      const isLoading = tab.status === 'loading';
      const isBackgroundTab = !tab.active;

      // Automated reset detection: tab is loading, navigating, or in the background during origin zoom reset
      if (isLoading || isNavigating) {
        tabUserManualZoom.delete(tabId);
        if (!isInitialized) pendingPurgedTabs.add(tabId);
        persistTabUserManualZoom();
        applyDisplayZoom(tabId, tab.windowId, effectiveUrl, { force: true });
        return;
      }

      if (isBackgroundTab) {
        if (!tabUserManualZoom.has(tabId)) {
          applyDisplayZoom(tabId, tab.windowId, effectiveUrl, { force: true });
        }
        return;
      }

      // Manual user zoom on active completed tab:
      // Cancel pending automated retries and record user-selected zoom for this session
      appliedTabZoomCache.delete(tabId);
      pendingPurgedTabs.delete(tabId);
      tabUserManualZoom.set(tabId, newZoomFactor);
      persistTabUserManualZoom();
      if (effectiveUrl) {
        tabLastUrl.set(tabId, getUrlWithoutHash(effectiveUrl));
      }

      // Ensure per-tab scope so manual zoom does not leak across tabs of the same origin
      if (zoomSettings.scope !== 'per-tab') {
        markProgrammaticZoomStart(tabId);
        try {
          await chrome.tabs.setZoomSettings(tabId, {
            mode: 'automatic',
            scope: 'per-tab'
          });
        } catch {} finally {
          markProgrammaticZoomEnd(tabId);
        }
      }
    } catch {}
  });

  // Tab created: apply display zoom
  chrome.tabs.onCreated.addListener((tab) => {
    if (tab?.id) {
      tabUserManualZoom.delete(tab.id);
      if (!isInitialized) pendingPurgedTabs.add(tab.id);
      persistTabUserManualZoom();
      appliedTabZoomCache.delete(tab.id);
      if (tab.pendingUrl || tab.url) {
        tabLastUrl.set(tab.id, getUrlWithoutHash(tab.pendingUrl || tab.url));
      }
      markTabNavigating(tab.id);
      applyDisplayZoom(tab.id, tab.windowId, tab.pendingUrl || tab.url, { force: true });
    }
  });

  // Tab updated: handles loading, complete, discarded recovery, and SPA URL changes (e.g. YouTube Music, Discord, GitHub)
  chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
    const isStatusLoading = changeInfo.status === 'loading';
    const isStatusComplete = changeInfo.status === 'complete';
    const rawNewUrl = changeInfo.url || tab?.url || tab?.pendingUrl;
    const newBaseUrl = getUrlWithoutHash(rawNewUrl);
    const prevBaseUrl = tabLastUrl.get(tabId);

    // True navigation occurs if page reloads (status: loading) or base URL changes (not just hash fragment)
    const hasBaseUrlChange = Boolean(changeInfo.url && prevBaseUrl && prevBaseUrl !== newBaseUrl);
    const isNavigationOrReload = isStatusLoading || hasBaseUrlChange;
    const isRestored = changeInfo.discarded === false;

    if (newBaseUrl) {
      tabLastUrl.set(tabId, newBaseUrl);
    }

    if (isNavigationOrReload) {
      // Navigation or reload terminates manual zoom session; configured monitor zoom resumes
      tabUserManualZoom.delete(tabId);
      if (!isInitialized) pendingPurgedTabs.add(tabId);
      persistTabUserManualZoom();
      appliedTabZoomCache.delete(tabId);
      if (isStatusLoading) {
        markTabNavigating(tabId);
      } else {
        tabNavigatingUntil.delete(tabId);
      }
      applyDisplayZoom(tabId, tab?.windowId, rawNewUrl, { force: true });
    } else if (isStatusComplete) {
      tabNavigatingUntil.delete(tabId);
      if (!tabUserManualZoom.has(tabId)) {
        applyDisplayZoom(tabId, tab?.windowId, rawNewUrl, { force: false });
      }
    } else if (isRestored) {
      if (!tabUserManualZoom.has(tabId)) {
        appliedTabZoomCache.delete(tabId);
        applyDisplayZoom(tabId, tab?.windowId, rawNewUrl, { force: false });
      }
    }
  });

  // Tab activated: apply zoom to newly active tab
  chrome.tabs.onActivated.addListener(({ tabId, windowId }) => {
    if (tabId && windowId) {
      if (!tabUserManualZoom.has(tabId)) {
        applyDisplayZoom(tabId, windowId, null, { force: false });
      }
    }
  });

  // Tab moved between windows (e.g. dragged from internal to external monitor)
  chrome.tabs.onAttached.addListener((tabId, attachInfo) => {
    if (tabId && attachInfo?.newWindowId) {
      if (!tabUserManualZoom.has(tabId)) {
        appliedTabZoomCache.delete(tabId);
        applyDisplayZoom(tabId, attachInfo.newWindowId, null, { force: true });
      }
    }
  });

  // Tab closed: clean up in-flight queues, cached zoom, and navigation marks
  chrome.tabs.onRemoved.addListener((tabId) => {
    tabInFlight.delete(tabId);
    appliedTabZoomCache.delete(tabId);
    tabNavigatingUntil.delete(tabId);
    tabUserManualZoom.delete(tabId);
    if (!isInitialized) pendingPurgedTabs.add(tabId);
    programmaticZoomActive.delete(tabId);
    programmaticZoomUntil.delete(tabId);
    persistTabUserManualZoom();
    tabLastUrl.delete(tabId);
  });

  // Storage updates: react immediately to local and session storage changes
  chrome.storage.onChanged.addListener(async (changes, area) => {
    if (area === 'local') {
      let reapply = false;

      if ('featureDefaultZoom' in changes) {
        const wasEnabled = isDefaultZoomEnabled;
        isDefaultZoomEnabled = Boolean(changes.featureDefaultZoom.newValue);
        if (!isDefaultZoomEnabled && wasEnabled) {
          await resetAllTabsToNative();
        } else if (isDefaultZoomEnabled && !wasEnabled) {
          reapply = true;
        }
      }
      if ('displaysZoomConfig' in changes) {
        const oldCfg = displaysZoomConfig || {};
        displaysZoomConfig = changes.displaysZoomConfig.newValue || {};

        // If any display transitioned from an overridden zoom level to default, reset its tabs to native
        if (allDisplays && allDisplays.length > 0) {
          for (const d of allDisplays) {
            const oldVal = getZoomValFromConfig(oldCfg, d);
            const newVal = getZoomValFromConfig(displaysZoomConfig, d);
            if (oldVal !== newVal) {
              if (oldVal !== null && newVal === null) {
                await resetTabsOnDisplayToNative(d);
              } else {
                try {
                  const windows = await chrome.windows.getAll();
                  for (const win of windows) {
                    if (win.state === 'minimized' || (typeof win.left === 'number' && win.left < -10000)) continue;
                    const disp = getDisplayForWindow(win);
                    if (disp && (disp.id === d.id || (disp.windowsDisplayNumber && disp.windowsDisplayNumber === d.windowsDisplayNumber))) {
                      const tabs = await chrome.tabs.query({ windowId: win.id });
                      for (const t of tabs) {
                        tabUserManualZoom.delete(t.id);
                        appliedTabZoomCache.delete(t.id);
                      }
                      persistTabUserManualZoom();
                    }
                  }
                } catch {}
              }
            }
          }
        }
        reapply = true;
      }
      if ('cachedDisplays' in changes) {
        if (Array.isArray(changes.cachedDisplays.newValue) && changes.cachedDisplays.newValue.length > 0) {
          allDisplays = changes.cachedDisplays.newValue;
        }
      }

      if (reapply && isDefaultZoomEnabled) {
        await syncAllActiveTabs();
      }
    } else if (area === 'session') {
      if ('latest_telemetry' in changes && changes.latest_telemetry.newValue) {
        const monitors = changes.latest_telemetry.newValue.monitors;
        if (Array.isArray(monitors)) {
          const sig = monitors.map(m => `${m.id || ''}:${m.windowsDisplayNumber || ''}:${m.isInternal ? 1 : 0}`).join('|');
          if (sig === lastMonitorsSignature && allDisplays.length > 0) return;
          lastMonitorsSignature = sig;

          if (!allDisplays.length) {
            await updateDisplayLayout();
          } else {
            allDisplays = annotateDisplaysWithTelemetry(allDisplays, monitors);
            try {
              await chrome.storage.local.set({ cachedDisplays: allDisplays });
            } catch {}
            if (isDefaultZoomEnabled) {
              await syncAllActiveTabs();
            }
          }
        }
      }
    }
  });
})();
