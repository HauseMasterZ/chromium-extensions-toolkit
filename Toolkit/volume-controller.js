if (typeof window.__volumeControllerInjected === 'undefined') {
    window.__volumeControllerInjected = true;

    let currentVolume = 1.0;

    function applyVolumeTo(element) {
        if (element.nodeName === 'AUDIO' || element.nodeName === 'VIDEO') {
            element.volume = currentVolume;
        }
        if (element.querySelectorAll) {
            element.querySelectorAll('audio, video').forEach(m => m.volume = currentVolume);
        }
    }

    function applyVolumeAll() {
        document.querySelectorAll('audio, video').forEach(m => m.volume = currentVolume);
    }

    const observer = new MutationObserver((mutations) => {
        for (const mutation of mutations) {
            for (const node of mutation.addedNodes) {
                if (node.nodeType === Node.ELEMENT_NODE) {
                    applyVolumeTo(node);
                }
            }
        }
    });

    observer.observe(document.documentElement, {
        childList: true,
        subtree: true
    });

    chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
        if (request.action === 'getVolume') {
            sendResponse({ volume: currentVolume });
            return true;
        }
        if (request.action === 'setVolume') {
            currentVolume = request.volume;
            applyVolumeAll();
            sendResponse({ success: true });
            return true;
        }
    });
}
