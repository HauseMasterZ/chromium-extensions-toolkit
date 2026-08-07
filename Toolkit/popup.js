document.addEventListener('DOMContentLoaded', async () => {
    const slider = document.getElementById('volumeSlider');
    const display = document.getElementById('volumeValue');

    // Get current active tab
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

    if (tab && !tab.url.startsWith("chrome://")) {
        // Inject the controller script dynamically via activeTab permission
        try {
            await chrome.scripting.executeScript({
                target: { tabId: tab.id },
                files: ['volume-controller.js']
            });
        } catch (e) {
            console.error("Failed to inject volume controller:", e);
        }

        // Request current volume from content script
        try {
            const response = await chrome.tabs.sendMessage(tab.id, { action: 'getVolume' });
            if (response && response.volume !== undefined) {
                slider.value = Math.round(response.volume * 100);
                display.textContent = `${slider.value}%`;
            }
        } catch (e) {
            console.log("Could not get initial volume:", e);
        }
    }

    // Handle slider changes
    slider.addEventListener('input', async (e) => {
        const volumeValue = e.target.value;
        display.textContent = `${volumeValue}%`;
        
        if (tab) {
            try {
                await chrome.tabs.sendMessage(tab.id, { 
                    action: 'setVolume', 
                    volume: volumeValue / 100 
                });
            } catch (err) {
                console.error("Could not set volume:", err);
            }
        }
    });

    // Check Dark Mode status
    const darkModeToggle = document.getElementById('toggleDarkMode');
    if (tab && !tab.url.startsWith("chrome://") && !tab.url.startsWith("https://chrome.google.com/webstore")) {
        try {
            const results = await chrome.scripting.executeScript({
                target: { tabId: tab.id },
                func: () => !!(window.__DARK_MODE_INJECTED__ && window.__DARK_MODE_IS_ACTIVE__)
            });
            if (results && results[0]) {
                darkModeToggle.checked = results[0].result;
            }
        } catch (e) {
            console.error("Could not check dark mode status:", e);
        }
    } else {
        darkModeToggle.closest('.toggle-row').classList.add('disabled');
    }

    darkModeToggle.addEventListener('change', (e) => {
        if (tab && !tab.url.startsWith("chrome://") && !tab.url.startsWith("https://chrome.google.com/webstore")) {
            chrome.runtime.sendMessage({ action: 'toggleDarkMode', tabId: tab.id });
        }
    });

    // Handle Settings Toggles
    const toggles = {
        'toggleAutoCopy': 'featureAutoCopy',
        'toggleYtFloatSearch': 'featureYtFloatSearch',
        'toggleYtMusic': 'featureYtMusic',
        'toggleNewTabPage': 'featureNewTabPage',
        'toggleWhatsapp': 'featureWhatsapp',
        'togglePasteGo': 'featurePasteGo'
    };

    // Context-Aware logic: Grey out irrelevant toggles based on the current website
    if (tab && tab.url) {
        const url = tab.url;
        
        // YouTube Float Search only applies to standard YouTube
        if (!url.includes('youtube.com') || url.includes('music.youtube.com')) {
            const row = document.getElementById('toggleYtFloatSearch').closest('.toggle-row');
            row.classList.add('disabled');
        }
        
        // YouTube Music only applies to YT Music
        if (!url.includes('music.youtube.com')) {
            const row = document.getElementById('toggleYtMusic').closest('.toggle-row');
            row.classList.add('disabled');
        }

        // WhatsApp Tweaks only apply to WhatsApp Web
        if (!url.includes('web.whatsapp.com')) {
            const row = document.getElementById('toggleWhatsapp').closest('.toggle-row');
            row.classList.add('disabled');
        }
    }

    // Load initial states (default true)
    chrome.storage.local.get({
        featureAutoCopy: true,
        featureYtFloatSearch: true,
        featureYtMusic: true,
        featureNewTabPage: true,
        featureWhatsapp: true,
        featurePasteGo: true
    }, (res) => {
        for (const [id, key] of Object.entries(toggles)) {
            const el = document.getElementById(id);
            if (el) {
                el.checked = res[key];
                // Add event listener to save state when changed
                el.addEventListener('change', (e) => {
                    chrome.storage.local.set({ [key]: e.target.checked });
                    if (key === 'featureYtMusic') {
                        chrome.runtime.sendMessage({ action: 'updateYtMusicScript', enabled: e.target.checked });
                    } else if (key === 'featureYtFloatSearch') {
                        chrome.runtime.sendMessage({ action: 'updateYtFloatSearchScript', enabled: e.target.checked });
                    } else if (key === 'featureWhatsapp') {
                        chrome.runtime.sendMessage({ action: 'updateWhatsappScript', enabled: e.target.checked });
                    }
                });
            }
        }
    });

    // Handle Edit Shortcuts button
    const btnEditShortcuts = document.getElementById('btnEditShortcuts');
    if (btnEditShortcuts) {
        btnEditShortcuts.addEventListener('click', () => {
            chrome.tabs.create({ url: 'chrome://extensions/shortcuts' });
        });
    }
});
