(function() {
    if (window.__customSeekInjected) return;
    window.__customSeekInjected = true;

    let isEnabled = false;
    let seekDuration = 1;

    // Listen for per-tab toggle/status messages from popup
    chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
        if (msg.action === 'getSeekStatus') {
            sendResponse({ enabled: isEnabled, duration: seekDuration });
            return false;
        }
        if (msg.action === 'setSeekStatus') {
            isEnabled = Boolean(msg.enabled);
            if (msg.duration !== undefined) {
                seekDuration = Math.max(1, Number(msg.duration) || 1);
            }
            sendResponse({ success: true, enabled: isEnabled, duration: seekDuration });
            return false;
        }
    });

    function getTargetVideo() {
        const videoList = document.getElementsByTagName('video');
        if (videoList.length === 0) return null;

        let largestPlaying = null;
        let maxPlayingArea = -1;
        let largestAny = null;
        let maxAnyArea = -1;

        for (let i = 0; i < videoList.length; i++) {
            const v = videoList[i];
            if (v.readyState === 0) continue;
            const area = (v.offsetWidth || 0) * (v.offsetHeight || 0);
            if (!v.paused && !v.ended) {
                if (area > maxPlayingArea) {
                    maxPlayingArea = area;
                    largestPlaying = v;
                }
            }
            if (area > maxAnyArea) {
                maxAnyArea = area;
                largestAny = v;
            }
        }

        return largestPlaying || largestAny;
    }

    let badgeTimeout = null;
    let cachedBadge = null;

    function showSeekBadge(delta) {
        if (!cachedBadge || !cachedBadge.isConnected) {
            cachedBadge = document.getElementById('toolkit-seek-badge');
            if (!cachedBadge) {
                cachedBadge = document.createElement('div');
                cachedBadge.id = 'toolkit-seek-badge';
                cachedBadge.style.cssText = `
                    position: fixed;
                    top: 12%;
                    left: 50%;
                    transform: translateX(-50%);
                    background: rgba(18, 18, 18, 0.85);
                    backdrop-filter: blur(16px);
                    -webkit-backdrop-filter: blur(16px);
                    color: #ffffff;
                    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
                    font-size: 14px;
                    font-weight: 600;
                    padding: 6px 14px;
                    border-radius: 20px;
                    border: 1px solid rgba(255, 255, 255, 0.15);
                    z-index: 2147483647;
                    pointer-events: none;
                    transition: opacity 0.2s ease, transform 0.2s ease;
                    box-shadow: 0 4px 20px rgba(0,0,0,0.5);
                    opacity: 0;
                `;
                (document.body || document.documentElement).appendChild(cachedBadge);
            }
        }
        const badge = cachedBadge;


        const sign = delta > 0 ? '+' : '';
        const symbol = delta > 0 ? '>>' : '<<';
        badge.textContent = `${symbol} ${sign}${delta}s`;
        badge.style.opacity = '1';
        badge.style.transform = 'translateX(-50%) scale(1)';

        clearTimeout(badgeTimeout);
        badgeTimeout = setTimeout(() => {
            badge.style.opacity = '0';
            badge.style.transform = 'translateX(-50%) scale(0.95)';
        }, 500);
    }

    window.addEventListener('keydown', (e) => {
        if (!isEnabled) return;
        if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
        if (e.ctrlKey || e.altKey || e.metaKey || e.shiftKey) return;

        const target = e.composedPath ? e.composedPath()[0] : e.target;
        if (target && (target.isContentEditable || target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT')) {
            return;
        }

        const video = getTargetVideo();
        if (!video) return;

        e.preventDefault();
        e.stopImmediatePropagation();

        const delta = (e.key === 'ArrowRight' ? 1 : -1) * seekDuration;
        const newTime = Math.max(0, Math.min(video.duration || Infinity, video.currentTime + delta));
        video.currentTime = newTime;
        showSeekBadge(delta);
    }, { capture: true });
})();
