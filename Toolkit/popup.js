(() => {
  document.addEventListener('DOMContentLoaded', async () => {
    const slider = document.getElementById('volumeSlider');
    const display = document.getElementById('volumeValue');
    const darkModeToggle = document.getElementById('toggleDarkMode');
    const btnEditShortcuts = document.getElementById('btnEditShortcuts');
    const inputSeekSeconds = document.getElementById('inputSeekSeconds');
    const toggleCustomSeek = document.getElementById('toggleCustomSeek');
    const toggleDefaultZoom = document.getElementById('toggleDefaultZoom');
    const displaysContainer = document.getElementById('displaysContainer');

    const storageDefaults = {
      featureAutoCopy: true,
      featureYtFloatSearch: true,
      featureYtMusic: true,
      featureNewTabPage: true,
      featureWhatsapp: true,
      featurePasteGo: true,
      featureDefaultZoom: true,
      cachedDisplays: [],
      displaysZoomConfig: {}
    };

    // Parallelize tab resolution, local storage rehydration, and session telemetry
    const [tabQueryRes, storageRes, sessionRes] = await Promise.all([
      chrome.tabs.query({ active: true, currentWindow: true }),
      chrome.storage.local.get(storageDefaults),
      chrome.storage?.session ? chrome.storage.session.get('latest_telemetry').catch(() => ({})) : Promise.resolve({})
    ]);

    const tab = tabQueryRes?.[0];
    const isInjectable = tab?.url && !/^(chrome|edge|devtools|about):|(chromewebstore\.google\.com|chrome\.google\.com\/webstore)/.test(tab.url);

    // 1. Parallelize tab inspections (Volume, Dark Mode, and Custom Seek)
    if (isInjectable && tab?.id) {
      const initVolume = (async () => {
        try {
          // Fast-path: check if volume-controller is already active in the tab
          let res = await chrome.tabs.sendMessage(tab.id, { action: 'getVolume' }).catch(() => null);
          if (!res) {
            await chrome.scripting.executeScript({
              target: { tabId: tab.id },
              files: ['volume-controller.js']
            });
            res = await chrome.tabs.sendMessage(tab.id, { action: 'getVolume' }).catch(() => null);
          }
          if (res?.volume !== undefined) {
            slider.value = Math.round(res.volume * 100);
            display.textContent = `${slider.value}%`;
          }
        } catch {}
      })();

      const initDarkMode = (async () => {
        try {
          const lowerUrl = (tab?.url || '').toLowerCase();
          const isExempt = lowerUrl.includes('v3-hub.atk.store') || lowerUrl.includes('atk.store') || lowerUrl.includes('mchose.com.cn');
          if (isExempt) {
            darkModeToggle.checked = false;
            darkModeToggle.disabled = true;
            darkModeToggle.closest('.toggle-row')?.classList.add('disabled');
            darkModeToggle.closest('.toggle-row')?.setAttribute('title', 'Dark mode is disabled for web driver portals');
            return;
          }
          const results = await chrome.scripting.executeScript({
            target: { tabId: tab.id },
            func: () => !!(window.__DARK_MODE_INJECTED__ && window.__DARK_MODE_IS_ACTIVE__)
          });
          if (results?.[0]?.result !== undefined) {
            darkModeToggle.checked = results[0].result;
          }
        } catch {}
      })();

      const initSeek = (async () => {
        if (inputSeekSeconds && toggleCustomSeek) {
          inputSeekSeconds.value = 1;
          toggleCustomSeek.checked = false;
          try {
            const res = await chrome.tabs.sendMessage(tab.id, { action: 'getSeekStatus' }).catch(() => null);
            if (res) {
              toggleCustomSeek.checked = Boolean(res.enabled);
              inputSeekSeconds.value = res.duration || 1;
            }
          } catch {}
        }
      })();

      Promise.all([initVolume, initDarkMode, initSeek]);
    } else {
      darkModeToggle?.closest('.toggle-row')?.classList.add('disabled');
      if (toggleCustomSeek) {
        toggleCustomSeek.closest('.toggle-row')?.classList.add('disabled');
      }
    }

    slider?.addEventListener('input', (e) => {
      const volumeValue = e.target.value;
      display.textContent = `${volumeValue}%`;
      if (tab?.id && isInjectable) {
        chrome.tabs.sendMessage(tab.id, { action: 'setVolume', volume: volumeValue / 100 }).catch(() => {});
      }
    });

    darkModeToggle?.addEventListener('change', () => {
      if (isInjectable && tab?.id) {
        chrome.runtime.sendMessage({ action: 'toggleDarkMode', tabId: tab.id });
      }
    });

    // Stateless Custom Seek Duration
    if (inputSeekSeconds && toggleCustomSeek) {
      const updateTabSeek = async () => {
        if (!isInjectable || !tab?.id) return;
        const enabled = toggleCustomSeek.checked;
        const duration = Math.max(1, Math.min(300, parseInt(inputSeekSeconds.value, 10) || 1));
        inputSeekSeconds.value = duration;

        try {
          let res = await chrome.tabs.sendMessage(tab.id, { action: 'setSeekStatus', enabled, duration }).catch(() => null);
          if (!res) {
            await chrome.scripting.executeScript({
              target: { tabId: tab.id },
              files: ['custom-seek.js']
            });
            await chrome.tabs.sendMessage(tab.id, { action: 'setSeekStatus', enabled, duration });
          }
        } catch (err) {
          console.error('Failed to set seek status:', err);
        }
      };

      toggleCustomSeek.addEventListener('change', updateTabSeek);
      inputSeekSeconds.addEventListener('change', updateTabSeek);
      inputSeekSeconds.addEventListener('click', (e) => e.stopPropagation());
    }

    // Resolution-Agnostic Multi-Monitor Auto-Detection & Zoom UI
    const annotateDisplays = (displays, telemetryMonitors) => {
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

        // 1C. Match against existing isInternal if resolution is consistent
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

        // Strip bogus isInternal flags from other displays
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
        const match = telemetryMonitors.find(mon => {
          if (usedMonitors.has(mon)) return false;
          if (mon.isInternal) return false;
          if (mon.pnpId && d.id && (d.id.includes(mon.pnpId) || d.id === mon.pnpId)) return true;
          if (mon.gdiDevice && d.id && d.id.includes(mon.gdiDevice)) return true;
          if (mon.width && mon.height && d.bounds) {
            const matchExact = (d.bounds.width === mon.width && d.bounds.height === mon.height);
            const matchRotated = (d.bounds.width === mon.height && d.bounds.height === mon.width);
            if (matchExact || matchRotated) return true;
          }
          if (mon.name && d.name && d.name !== 'Generic PnP Monitor' && d.name !== 'Internal Display' &&
              (d.name.toLowerCase() === mon.name.toLowerCase() ||
               d.name.toLowerCase().includes(mon.name.toLowerCase()) ||
               mon.name.toLowerCase().includes(d.name.toLowerCase()))) {
            return true;
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

      return displays;
    };

    if (displaysContainer) {
      const handleZoomInputChange = (input) => {
        if (!input) return;
        const row = input.closest('.display-row');
        const box = input.closest('.display-zoom-box');
        const raw = input.value.trim();

        let storedVal = 'default';
        let newIsDefault = true;

        if (raw !== '' && raw !== 'default') {
          let num = parseInt(raw, 10);
          if (!isNaN(num)) {
            // Support negative zoom offset (e.g. -20 -> 80%, -50 -> 50%)
            if (num < 0 && num >= -75) {
              num = 100 + num;
            }
            // Clamp to Chromium supported zoom range: 25% to 500%
            if (num >= 25 && num <= 500) {
              storedVal = num;
              newIsDefault = false;
              input.value = num;
            } else if (num < 25) {
              storedVal = 25;
              newIsDefault = false;
              input.value = 25;
            } else if (num > 500) {
              storedVal = 500;
              newIsDefault = false;
              input.value = 500;
            }
          }
        }

        if (newIsDefault) {
          input.value = '';
        }

        if (row) {
          row.classList.toggle('is-default', newIsDefault);
        }
        if (box) {
          box.classList.toggle('is-default', newIsDefault);
        }

        const displayId = input.getAttribute('data-id');
        const displayNum = input.getAttribute('data-display-num');

        chrome.storage.local.get({ displaysZoomConfig: {} }, (res) => {
          const cfg = res.displaysZoomConfig || {};
          if (displayId) cfg[displayId] = storedVal;
          if (displayNum) {
            cfg[`#${displayNum}`] = storedVal;
            cfg[displayNum] = storedVal;
          }
          chrome.storage.local.set({ displaysZoomConfig: cfg }, () => {
            chrome.runtime.sendMessage({ action: 'syncDisplayZoom' }, () => {
              if (chrome.runtime.lastError) return;
            });
          });
        });
      };

      displaysContainer.addEventListener('change', (e) => {
        const input = e.target.closest('.display-zoom-input');
        if (input) {
          handleZoomInputChange(input);
        }
      });

      displaysContainer.addEventListener('keydown', (e) => {
        const input = e.target.closest('.display-zoom-input');
        if (!input) return;
        if (e.key === 'Enter') {
          input.blur();
        } else if (e.key === 'ArrowUp' && input.value === '') {
          e.preventDefault();
          input.value = 105;
          handleZoomInputChange(input);
        } else if (e.key === 'ArrowDown' && input.value === '') {
          e.preventDefault();
          input.value = 95;
          handleZoomInputChange(input);
        }
      });

      displaysContainer.addEventListener('wheel', (e) => {
        const input = e.target.closest('.display-zoom-input');
        if (!input || input.disabled) return;
        e.preventDefault();
        let cur = parseInt(input.value, 10);
        if (isNaN(cur)) cur = 100;
        const delta = e.deltaY < 0 ? 5 : -5;
        let next = cur + delta;
        if (next < 25) next = 25;
        if (next > 500) next = 500;
        input.value = next;
        handleZoomInputChange(input);
      }, { passive: false });

      displaysContainer.addEventListener('click', (e) => {
        const box = e.target.closest('.display-zoom-box');
        if (box) {
          e.stopPropagation();
          const input = box.querySelector('.display-zoom-input');
          if (input && document.activeElement !== input) {
            input.focus();
          }
        }
      });
    }

    const renderDisplays = (displays, displaysZoomConfig, isEnabled) => {
      if (!displaysContainer) return;
      if (!Array.isArray(displays) || displays.length === 0) {
        displaysContainer.innerHTML = '<div style="font-size: 11.5px; color: var(--text-secondary);">No displays detected</div>';
        return;
      }

      displaysContainer.innerHTML = '';
      const sortedDisplays = [...displays].sort((a, b) => {
        const numA = (typeof a.windowsDisplayNumber === 'number' && a.windowsDisplayNumber > 0) ? a.windowsDisplayNumber : (a.isInternal ? 1 : 999);
        const numB = (typeof b.windowsDisplayNumber === 'number' && b.windowsDisplayNumber > 0) ? b.windowsDisplayNumber : (b.isInternal ? 1 : 999);
        if (numA !== numB) return numA - numB;
        return (a.bounds?.left || 0) - (b.bounds?.left || 0);
      });

      const seenNums = new Set();
      sortedDisplays.forEach((d, idx) => {
        const row = document.createElement('div');
        row.className = 'display-row';

        let displayNum = (typeof d.windowsDisplayNumber === 'number' && d.windowsDisplayNumber > 0) ? d.windowsDisplayNumber : (idx + 1);
        if (seenNums.has(displayNum)) {
          displayNum = idx + 1;
          while (seenNums.has(displayNum)) {
            displayNum++;
          }
        }
        seenNums.add(displayNum);
        d.windowsDisplayNumber = displayNum;
        const displayName = `#${displayNum}`;
        const hoverTitle = (d.name && !d.name.toLowerCase().includes('internal') && !d.name.toLowerCase().includes('primary') && d.name !== 'Generic PnP Monitor') ? `#${displayNum} (${d.name})` : `#${displayNum}`;
        const resolution = `${d.bounds.width}\u00D7${d.bounds.height}`;

        let zoomVal = 'default';
        if (displaysZoomConfig && typeof displaysZoomConfig === 'object') {
          const keys = [
            displayNum ? `#${displayNum}` : null,
            displayNum !== undefined ? displayNum : null,
            displayNum !== undefined ? String(displayNum) : null,
            d.id,
            d.name
          ];
          for (const k of keys) {
            if (k !== null && k !== undefined && displaysZoomConfig[k] !== undefined) {
              zoomVal = displaysZoomConfig[k];
              break;
            }
          }
        }

        if (zoomVal !== 'default' && zoomVal !== null && zoomVal !== undefined && zoomVal !== '') {
          let parsed = Number(zoomVal);
          if (!isNaN(parsed)) {
            if (parsed >= 0.25 && parsed <= 5.0 && String(zoomVal).includes('.')) {
              parsed = Math.round(parsed * 100);
            } else if (parsed < 0 && parsed >= -75) {
              parsed = 100 + parsed;
            }
            if (parsed >= 25 && parsed <= 500) {
              zoomVal = String(parsed);
            } else {
              zoomVal = 'default';
            }
          } else {
            zoomVal = 'default';
          }
        } else {
          zoomVal = 'default';
        }

        const isDefault = (zoomVal === 'default');
        if (isDefault) {
          row.classList.add('is-default');
        }

        const badgesHtml = `<span class="display-badge">${resolution}</span>`;

        row.innerHTML = `
          <div class="display-info">
            <div class="display-name" title="${hoverTitle}">${displayName}</div>
            <div class="display-badges">${badgesHtml}</div>
          </div>
          <div class="display-zoom-box ${isDefault ? 'is-default' : ''}" title="Monitor zoom override (25% - 500%)">
            <input type="number" class="display-zoom-input" data-id="${d.id}" data-display-num="${displayNum || ''}" placeholder="100" value="${isDefault ? '' : zoomVal}" min="-75" max="500" step="5" ${isEnabled ? '' : 'disabled'}>
            <span class="zoom-unit">%</span>
          </div>
        `;

        displaysContainer.appendChild(row);
      });

      displaysContainer.style.opacity = isEnabled ? '1' : '0.4';
    };

    // Instant initial render from cached storage
    let currentDisplays = Array.isArray(storageRes.cachedDisplays) && storageRes.cachedDisplays.length > 0 ? storageRes.cachedDisplays : [];
    let currentZoomConfig = storageRes.displaysZoomConfig || {};
    const isZoomEnabled = Boolean(storageRes.featureDefaultZoom);

    // Sanitize cachedDisplays on rehydration to eliminate any legacy duplicates
    if (currentDisplays.length > 0) {
      const seenCachedNums = new Set();
      let hasDupes = false;
      for (const d of currentDisplays) {
        if (d.windowsDisplayNumber && seenCachedNums.has(d.windowsDisplayNumber)) {
          hasDupes = true;
          delete d.windowsDisplayNumber;
        } else if (d.windowsDisplayNumber) {
          seenCachedNums.add(d.windowsDisplayNumber);
        }
      }
      if (hasDupes) {
        currentDisplays.forEach((d, idx) => {
          if (!d.windowsDisplayNumber) d.windowsDisplayNumber = idx + 1;
        });
        chrome.storage.local.set({ cachedDisplays: currentDisplays });
      }
    }

    const initialTelemetryMonitors = sessionRes?.latest_telemetry?.monitors;
    if (initialTelemetryMonitors && currentDisplays.length > 0) {
      annotateDisplays(currentDisplays, initialTelemetryMonitors);
    }
    renderDisplays(currentDisplays, currentZoomConfig, isZoomEnabled);

    // Asynchronous background layout refresh
    const refreshDisplaysAsync = async () => {
      try {
        const liveDisplays = await chrome.system.display.getInfo();
        if (Array.isArray(liveDisplays) && liveDisplays.length > 0) {
          const annotated = liveDisplays.map(d => {
            const prev = currentDisplays.find(p => p.id === d.id);
            if (prev) {
              if (prev.windowsDisplayNumber) d.windowsDisplayNumber = prev.windowsDisplayNumber;
              if (prev.isInternal) d.isInternal = true;
            }
            return d;
          });

          const activeMonitors = sessionRes?.latest_telemetry?.monitors;
          if (activeMonitors) {
            annotateDisplays(annotated, activeMonitors);
          } else {
            try {
              const sessionData = chrome.storage?.session ? await chrome.storage.session.get('latest_telemetry').catch(() => ({})) : {};
              const latest_telemetry = sessionData?.latest_telemetry;
              if (latest_telemetry?.monitors) {
                annotateDisplays(annotated, latest_telemetry.monitors);
              }
            } catch {}
          }

          currentDisplays = annotated;
          chrome.storage.local.set({ cachedDisplays: annotated });
          if (!displaysContainer.contains(document.activeElement)) {
            renderDisplays(currentDisplays, currentZoomConfig, toggleDefaultZoom ? toggleDefaultZoom.checked : isZoomEnabled);
          }
        }
      } catch {}
    };
    refreshDisplaysAsync();

    // Context-Aware UI: Grey out irrelevant toggles
    const url = tab?.url || '';
    if (!url.includes('youtube.com') || url.includes('music.youtube.com')) {
      document.getElementById('toggleYtFloatSearch')?.closest('.toggle-row')?.classList.add('disabled');
    }
    if (!url.includes('music.youtube.com')) {
      document.getElementById('toggleYtMusic')?.closest('.toggle-row')?.classList.add('disabled');
    }
    if (!url.includes('web.whatsapp.com')) {
      document.getElementById('toggleWhatsapp')?.closest('.toggle-row')?.classList.add('disabled');
    }

    // Global persistent toggles
    const toggles = {
      toggleAutoCopy: 'featureAutoCopy',
      toggleYtFloatSearch: 'featureYtFloatSearch',
      toggleYtMusic: 'featureYtMusic',
      toggleNewTabPage: 'featureNewTabPage',
      toggleWhatsapp: 'featureWhatsapp',
      togglePasteGo: 'featurePasteGo'
    };

    const scriptActionMap = {
      featureYtMusic: 'updateYtMusicScript',
      featureYtFloatSearch: 'updateYtFloatSearchScript',
      featureWhatsapp: 'updateWhatsappScript'
    };

    for (const [id, key] of Object.entries(toggles)) {
      const el = document.getElementById(id);
      if (!el) continue;
      el.checked = Boolean(storageRes[key]);
      el.addEventListener('change', (e) => {
        const enabled = e.target.checked;
        chrome.storage.local.set({ [key]: enabled });
        if (scriptActionMap[key]) {
          chrome.runtime.sendMessage({ action: scriptActionMap[key], enabled });
        }
      });
    }

    if (toggleDefaultZoom) {
      toggleDefaultZoom.checked = isZoomEnabled;
      toggleDefaultZoom.addEventListener('change', (e) => {
        const enabled = e.target.checked;
        chrome.storage.local.set({ featureDefaultZoom: enabled }, () => {
          chrome.runtime.sendMessage({ action: 'syncDisplayZoom' }, () => {
            if (chrome.runtime.lastError) return;
          });
        });
        if (displaysContainer) {
          displaysContainer.style.opacity = enabled ? '1' : '0.4';
          const inputs = displaysContainer.querySelectorAll('.display-zoom-input');
          inputs.forEach(inp => inp.disabled = !enabled);
          const boxes = displaysContainer.querySelectorAll('.display-zoom-box');
          boxes.forEach(box => box.classList.toggle('disabled', !enabled));
        }
      });
    }

    btnEditShortcuts?.addEventListener('click', () => {
      chrome.tabs.create({ url: 'chrome://extensions/shortcuts' });
    });
  });
})();
