let isEnabled = true;
chrome.storage.local.get({ featureAutoCopy: true }, (res) => { isEnabled = res.featureAutoCopy; });
chrome.storage.onChanged.addListener((changes) => {
    if (changes.featureAutoCopy) isEnabled = changes.featureAutoCopy.newValue;
});

let overlayHost = null;
let shadowRoot = null;
let hideTimer = null;

function getSelectionRect() {
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0) return null;
    const range = sel.getRangeAt(0);
    const rect = range.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) return null;
    return rect;
}

function showAndroidClipboardOverlay(text, mouseX, mouseY) {
    if (!overlayHost) {
        overlayHost = document.createElement('div');
        overlayHost.id = 'toolkit-clipboard-host';
        shadowRoot = overlayHost.attachShadow({ mode: 'closed' });
        
        const style = document.createElement('style');
        style.textContent = `
            :host {
                all: initial;
            }
            .chip-container {
                position: fixed;
                z-index: 2147483647;
                display: flex;
                align-items: center;
                gap: 8px;
                background: #2b2930;
                padding: 6px 8px 6px 6px;
                border-radius: 16px;
                box-shadow: 0 4px 24px rgba(0, 0, 0, 0.5), 0 0 0 1px rgba(255, 255, 255, 0.08);
                font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
                pointer-events: none;
                opacity: 0;
                transform: scale(0.9) translateY(6px);
                transition: opacity 0.2s cubic-bezier(0.1, 0.9, 0.2, 1), transform 0.2s cubic-bezier(0.1, 0.9, 0.2, 1);
                max-width: 260px;
                box-sizing: border-box;
            }
            .chip-container.visible {
                opacity: 1;
                transform: scale(1) translateY(0);
            }
            .preview-card {
                background: #1d1b20;
                color: #e6e1e5;
                font-size: 11.5px;
                line-height: 1.3;
                padding: 6px 10px;
                border-radius: 11px;
                max-width: 170px;
                overflow: hidden;
                text-overflow: ellipsis;
                white-space: nowrap;
                border: 1px solid rgba(255, 255, 255, 0.06);
                box-sizing: border-box;
            }
            .icon-badge {
                width: 26px;
                height: 26px;
                border-radius: 9px;
                background: #4a4458;
                color: #e8def8;
                display: flex;
                align-items: center;
                justify-content: center;
                flex-shrink: 0;
            }
            .icon-badge svg {
                width: 14px;
                height: 14px;
                fill: currentColor;
            }
        `;
        shadowRoot.appendChild(style);

        const container = document.createElement('div');
        container.className = 'chip-container';
        container.innerHTML = `
            <div class="preview-card"></div>
            <div class="icon-badge">
                <svg viewBox="0 0 24 24"><path d="M19 3h-4.18C14.4 1.84 13.3 1 12 1c-1.3 0-2.4.84-2.82 2H5c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2zm-7 0c.55 0 1 .45 1 1s-.45 1-1 1-1-.45-1-1 .45-1 1-1zm-2 14l-4-4 1.41-1.41L10 14.17l6.59-6.59L18 9l-8 8z"/></svg>
            </div>
        `;
        shadowRoot.appendChild(container);
        document.documentElement.appendChild(overlayHost);
    }

    const container = shadowRoot.querySelector('.chip-container');
    const preview = shadowRoot.querySelector('.preview-card');
    
    preview.textContent = text.length > 40 ? text.slice(0, 40) + '…' : text;

    // Calculate position: bottom-right of selection rect
    const rect = getSelectionRect();
    const margin = 8;
    const estWidth = 220;
    const estHeight = 38;

    let targetLeft = rect ? rect.right + margin : mouseX + margin;
    let targetTop = rect ? rect.bottom + margin : mouseY + margin;

    // Viewport clamping
    const maxLeft = window.innerWidth - estWidth - 12;
    const maxTop = window.innerHeight - estHeight - 12;

    if (targetLeft > maxLeft) {
        targetLeft = rect ? Math.max(12, rect.right - estWidth) : maxLeft;
    }
    if (targetTop > maxTop) {
        targetTop = rect ? Math.max(12, rect.top - estHeight - margin) : maxTop;
    }

    container.style.left = `${Math.round(targetLeft)}px`;
    container.style.top = `${Math.round(targetTop)}px`;

    container.classList.add('visible');

    clearTimeout(hideTimer);
    hideTimer = setTimeout(() => {
        container.classList.remove('visible');
    }, 1600);
}

document.addEventListener('mouseup', e => {
    if (!isEnabled) return;
    if (e.altKey) return;
    const text = window.getSelection().toString().trim();
    if (text) {
        document.execCommand('copy');
        showAndroidClipboardOverlay(text, e.clientX, e.clientY);
    }
});