document.addEventListener('DOMContentLoaded', async () => {
    const slider = document.getElementById('volumeSlider');
    const display = document.getElementById('volumeValue');
    const darkModeToggle = document.getElementById('toggleDarkMode');
    const btnEditShortcuts = document.getElementById('btnEditShortcuts');
    const inputSeekSeconds = document.getElementById('inputSeekSeconds');
    const toggleCustomSeek = document.getElementById('toggleCustomSeek');
    const rowDefaultZoom = document.getElementById('rowDefaultZoom');
    const inputDefaultZoom = document.getElementById('inputDefaultZoom');
    const toggleDefaultZoom = document.getElementById('toggleDefaultZoom');

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
        darkModeToggle.closest('.toggle-row').classList.add('disabled');
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

    // Default Zoom: % Controller (Ephemeral internal display auto-zoom)
    const updateZoomInputState = () => {
        if (toggleDefaultZoom && inputDefaultZoom) {
            inputDefaultZoom.disabled = !toggleDefaultZoom.checked;
            const box = inputDefaultZoom.closest('.seek-input-box');
            if (box) box.style.opacity = toggleDefaultZoom.checked ? '1' : '0.4';
        }
    };

    if (rowDefaultZoom && toggleDefaultZoom && inputDefaultZoom) {
        rowDefaultZoom.addEventListener('click', (e) => {
            if (e.target.closest('.seek-input-box') || e.target.closest('.switch')) return;
            toggleDefaultZoom.checked = !toggleDefaultZoom.checked;
            toggleDefaultZoom.dispatchEvent(new Event('change'));
        });

        inputDefaultZoom.addEventListener('click', (e) => e.stopPropagation());
        inputDefaultZoom.addEventListener('change', () => {
            const val = Math.max(100, Math.min(200, parseInt(inputDefaultZoom.value, 10) || 120));
            inputDefaultZoom.value = val;
            chrome.storage.local.set({ defaultZoomLevel: val });
        });
    }

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
        togglePasteGo: 'featurePasteGo',
        toggleDefaultZoom: 'featureDefaultZoom'
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
        featureDefaultZoom: true,
        defaultZoomLevel: 120
    };

    chrome.storage.local.get(defaultSettings, (res) => {
        if (inputDefaultZoom) {
            inputDefaultZoom.value = res.defaultZoomLevel || 120;
        }
        for (const [id, key] of Object.entries(toggles)) {
            const el = document.getElementById(id);
            if (!el) continue;
            el.checked = Boolean(res[key]);
            el.addEventListener('change', (e) => {
                const enabled = e.target.checked;
                chrome.storage.local.set({ [key]: enabled });
                if (id === 'toggleDefaultZoom') {
                    updateZoomInputState();
                }
                if (scriptActionMap[key]) {
                    chrome.runtime.sendMessage({ action: scriptActionMap[key], enabled });
                }
            });
        }
        updateZoomInputState();
    });

    btnEditShortcuts?.addEventListener('click', () => {
        chrome.tabs.create({ url: 'chrome://extensions/shortcuts' });
    });
});
