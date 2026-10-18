(function() {
    if (window.__customSeekInjected) return;
    window.__customSeekInjected = true;

    let isEnabled = false;
    let seekDuration = 1;

    // Listen for per-tab toggle/status messages from popup
    chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
        if (msg.action === 'getSeekStatus') {
            sendResponse({ enabled: isEnabled, duration: seekDuration });
            return true;
        }
        if (msg.action === 'setSeekStatus') {
            isEnabled = Boolean(msg.enabled);
            if (msg.duration !== undefined) {
                seekDuration = Math.max(1, Number(msg.duration) || 1);
            }
            sendResponse({ success: true, enabled: isEnabled, duration: seekDuration });
            return true;
        }
    });

    function getTargetVideo() {
        const videos = Array.from(document.querySelectorAll('video')).filter(v => v.readyState > 0);
        if (!videos.length) return null;

        const playing = videos.find(v => !v.paused && !v.ended);
        if (playing) return playing;

        return videos.sort((a, b) => (b.offsetWidth * b.offsetHeight) - (a.offsetWidth * a.offsetHeight))[0];
    }

    let badgeTimeout = null;
    function showSeekBadge(delta) {
        let badge = document.getElementById('toolkit-seek-badge');
        if (!badge) {
            badge = document.createElement('div');
            badge.id = 'toolkit-seek-badge';
            badge.style.cssText = `
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
            document.documentElement.appendChild(badge);
        }

        const sign = delta > 0 ? '+' : '';
        const symbol = delta > 0 ? '▶▶' : '◀◀';
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
        if (target && (target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName))) {
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
