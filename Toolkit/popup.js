document.addEventListener('DOMContentLoaded', async () => {
    const slider = document.getElementById('volumeSlider');
    const display = document.getElementById('volumeValue');
    const darkModeToggle = document.getElementById('toggleDarkMode');
    const btnEditShortcuts = document.getElementById('btnEditShortcuts');

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

    // Toggle management
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

    const defaultSettings = Object.fromEntries(Object.values(toggles).map(k => [k, true]));
    chrome.storage.local.get(defaultSettings, (res) => {
        for (const [id, key] of Object.entries(toggles)) {
            const el = document.getElementById(id);
            if (!el) continue;
            el.checked = res[key];
            el.addEventListener('change', (e) => {
                const enabled = e.target.checked;
                chrome.storage.local.set({ [key]: enabled });
                if (scriptActionMap[key]) {
                    chrome.runtime.sendMessage({ action: scriptActionMap[key], enabled });
                }
            });
        }
    });

    btnEditShortcuts?.addEventListener('click', () => {
        chrome.tabs.create({ url: 'chrome://extensions/shortcuts' });
    });
});
