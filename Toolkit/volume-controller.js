if (typeof window.__volumeControllerInjected === 'undefined') {
    window.__volumeControllerInjected = true;

    let currentVolume = 1.0;

    // Apply volume to all existing media elements
    function applyVolume() {
        const mediaElements = document.querySelectorAll('audio, video');
        mediaElements.forEach(media => {
            media.volume = currentVolume;
        });
    }

    // Observe for dynamically added media elements to apply volume automatically
    const observer = new MutationObserver((mutations) => {
        let shouldApply = false;
        for (let mutation of mutations) {
            if (mutation.addedNodes.length) {
                mutation.addedNodes.forEach(node => {
                    if (node.nodeName === 'AUDIO' || node.nodeName === 'VIDEO') {
                        shouldApply = true;
                    }
                    // Check if the added node contains media elements
                    if (node.querySelectorAll && node.querySelectorAll('audio, video').length > 0) {
                        shouldApply = true;
                    }
                });
            }
        }
        if (shouldApply) {
            applyVolume();
        }
    });

    // Start observing the whole document
    observer.observe(document.documentElement, {
        childList: true,
        subtree: true
    });

    // Listen for messages from the popup
    chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
        if (request.action === 'getVolume') {
            sendResponse({ volume: currentVolume });
            return true;
        }
        
        if (request.action === 'setVolume') {
            currentVolume = request.volume;
            applyVolume();
            sendResponse({ success: true });
            return true;
        }
    });
}
