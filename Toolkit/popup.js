document.addEventListener('DOMContentLoaded', async () => {
    const slider = document.getElementById('volumeSlider');
    const display = document.getElementById('volumeValue');
    const darkModeToggle = document.getElementById('toggleDarkMode');
    const btnEditShortcuts = document.getElementById('btnEditShortcuts');
    const inputSeekSeconds = document.getElementById('inputSeekSeconds');
    const toggleCustomSeek = document.getElementById('toggleCustomSeek');
    const toggleDefaultZoom = document.getElementById('toggleDefaultZoom');
    const displaysContainer = document.getElementById('displaysContainer');

    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    const isInjectable = tab?.url && !/^(chrome|edge|devtools|about):|chrome\.google\.com\/webstore/.test(tab.url);

    // Tab Volume Controller initialization
    if (isInjectable) {
        try {
            await chrome.scripting.executeScript({
                target: { tabId: tab.id },
                files: ['volume-controller.js']
            });
            const res = await chrome.tabs.sendMessage(tab.id, { action: 'getVolume' });
            if (res?.volume !== undefined) {
                slider.value = Math.round(res.volume * 100);
                display.textContent = `${slider.value}%`;
            }
        } catch {}
    }

    slider.addEventListener('input', (e) => {
        const volumeValue = e.target.value;
        display.textContent = `${volumeValue}%`;
        if (tab?.id && isInjectable) {
            chrome.tabs.sendMessage(tab.id, { action: 'setVolume', volume: volumeValue / 100 }).catch(() => {});
        }
    });

    // Check Dark Mode status
    if (isInjectable) {
        try {
            const results = await chrome.scripting.executeScript({
                target: { tabId: tab.id },
                func: () => !!(window.__DARK_MODE_INJECTED__ && window.__DARK_MODE_IS_ACTIVE__)
            });
            if (results?.[0]?.result !== undefined) {
                darkModeToggle.checked = results[0].result;
            }
        } catch {}
    } else {
        darkModeToggle.closest('.toggle-row')?.classList.add('disabled');
    }

    darkModeToggle.addEventListener('change', () => {
        if (isInjectable) {
            chrome.runtime.sendMessage({ action: 'toggleDarkMode', tabId: tab.id });
        }
    });

    // Stateless Custom Seek Duration (Always defaults to 1s & disabled on fresh page)
    if (inputSeekSeconds && toggleCustomSeek) {
        inputSeekSeconds.value = 1;
        toggleCustomSeek.checked = false;

        if (isInjectable) {
            try {
                const res = await chrome.tabs.sendMessage(tab.id, { action: 'getSeekStatus' });
                if (res) {
                    toggleCustomSeek.checked = Boolean(res.enabled);
                    inputSeekSeconds.value = res.duration || 1;
                }
            } catch {
                toggleCustomSeek.checked = false;
                inputSeekSeconds.value = 1;
            }
        } else {
            toggleCustomSeek.closest('.toggle-row')?.classList.add('disabled');
        }

        const updateTabSeek = async () => {
            if (!isInjectable || !tab?.id) return;
            const enabled = toggleCustomSeek.checked;
            const duration = Math.max(1, Math.min(300, parseInt(inputSeekSeconds.value, 10) || 1));
            inputSeekSeconds.value = duration;

            try {
                await chrome.scripting.executeScript({
                    target: { tabId: tab.id },
                    files: ['custom-seek.js']
                });
                await chrome.tabs.sendMessage(tab.id, { action: 'setSeekStatus', enabled, duration });
            } catch (err) {
                console.error('Failed to set seek status:', err);
            }
        };

        toggleCustomSeek.addEventListener('change', updateTabSeek);
        inputSeekSeconds.addEventListener('change', updateTabSeek);
        inputSeekSeconds.addEventListener('click', (e) => e.stopPropagation());
    }

    // Resolution-Agnostic Multi-Monitor Auto-Detection & Zoom UI
    const renderDisplays = (displays, displaysZoomConfig, isEnabled) => {
        if (!displaysContainer) return;
        if (!Array.isArray(displays) || displays.length === 0) {
            displaysContainer.innerHTML = '<div style="font-size: 11.5px; color: var(--text-secondary);">No displays detected</div>';
            return;
        }

        displaysContainer.innerHTML = '';
        const sortedDisplays = [...displays].sort((a, b) => {
            if (a.isPrimary && !b.isPrimary) return -1;
            if (!a.isPrimary && b.isPrimary) return 1;
            return (a.bounds?.left || 0) - (b.bounds?.left || 0);
        });

        sortedDisplays.forEach((d, idx) => {
            const row = document.createElement('div');
            row.className = 'display-row';

            const displayName = `#${idx + 1}`;
            const hoverTitle = d.name || (d.isInternal ? 'Internal Display' : `Display ${idx + 1}`);
            const resolution = `${d.bounds.width}\u00D7${d.bounds.height}`;
            const isInternal = Boolean(d.isInternal);
            const isPrimary = Boolean(d.isPrimary);

            let zoomVal = 100;
            if (displaysZoomConfig && displaysZoomConfig[d.id] !== undefined) {
                zoomVal = Number(displaysZoomConfig[d.id]) || 100;
            } else if (isInternal) {
                zoomVal = 120;
            }

            const badgesHtml = `
                <span class="display-badge">${resolution}</span>
                ${isInternal ? '<span class="display-badge internal">Internal</span>' : ''}
                ${isPrimary ? '<span class="display-badge primary">Primary</span>' : ''}
            `;

            row.innerHTML = `
                <div class="display-info">
                    <div class="display-name" title="${hoverTitle}">${displayName}</div>
                    <div class="display-badges">${badgesHtml}</div>
                </div>
                <div class="seek-input-box" title="Zoom percentage">
                    <input type="number" class="display-zoom-input" data-id="${d.id}" min="100" max="200" step="5" value="${zoomVal}" ${isEnabled ? '' : 'disabled'}>
                    <span class="seek-unit">%</span>
                </div>
            `;

            const input = row.querySelector('.display-zoom-input');
            input.addEventListener('click', (e) => e.stopPropagation());
            input.addEventListener('change', (e) => {
                const val = Math.max(100, Math.min(200, parseInt(e.target.value, 10) || 100));
                e.target.value = val;
                chrome.storage.local.get({ displaysZoomConfig: {} }, (res) => {
                    const cfg = res.displaysZoomConfig || {};
                    cfg[d.id] = val;
                    chrome.storage.local.set({ displaysZoomConfig: cfg });
                });
            });

            displaysContainer.appendChild(row);
        });

        displaysContainer.style.opacity = isEnabled ? '1' : '0.4';
    };

    const loadDisplaysUi = async (isEnabled) => {
        try {
            const { cachedDisplays = [], displaysZoomConfig = {} } = await chrome.storage.local.get(['cachedDisplays', 'displaysZoomConfig']);
            let displays = cachedDisplays;
            try {
                const liveDisplays = await chrome.system.display.getInfo();
                if (Array.isArray(liveDisplays) && liveDisplays.length > 0) {
                    displays = liveDisplays;
                    chrome.storage.local.set({ cachedDisplays: liveDisplays });
                }
            } catch {}

            renderDisplays(displays, displaysZoomConfig, isEnabled);
        } catch (e) {
            console.error('Failed to load displays:', e);
        }
    };

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

    const defaultSettings = {
        featureAutoCopy: true,
        featureYtFloatSearch: true,
        featureYtMusic: true,
        featureNewTabPage: true,
        featureWhatsapp: true,
        featurePasteGo: true,
        featureDefaultZoom: true
    };

    chrome.storage.local.get(defaultSettings, (res) => {
        for (const [id, key] of Object.entries(toggles)) {
            const el = document.getElementById(id);
            if (!el) continue;
            el.checked = Boolean(res[key]);
            el.addEventListener('change', (e) => {
                const enabled = e.target.checked;
                chrome.storage.local.set({ [key]: enabled });
                if (scriptActionMap[key]) {
                    chrome.runtime.sendMessage({ action: scriptActionMap[key], enabled });
                }
            });
        }

        if (toggleDefaultZoom) {
            const isZoomEnabled = Boolean(res.featureDefaultZoom);
            toggleDefaultZoom.checked = isZoomEnabled;
            loadDisplaysUi(isZoomEnabled);

            toggleDefaultZoom.addEventListener('change', (e) => {
                const enabled = e.target.checked;
                chrome.storage.local.set({ featureDefaultZoom: enabled });
                if (displaysContainer) {
                    displaysContainer.style.opacity = enabled ? '1' : '0.4';
                    const inputs = displaysContainer.querySelectorAll('.display-zoom-input');
                    inputs.forEach(inp => inp.disabled = !enabled);
                }
            });
        }
    });

    btnEditShortcuts?.addEventListener('click', () => {
        chrome.tabs.create({ url: 'chrome://extensions/shortcuts' });
    });
});
