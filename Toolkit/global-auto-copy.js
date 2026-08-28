let isEnabled = true;
try {
    if (chrome.storage?.local) {
        chrome.storage.local.get({ featureAutoCopy: true }, (res) => { if (res) isEnabled = res.featureAutoCopy; });
        chrome.storage.onChanged.addListener((changes, area) => {
            if (area === 'local' && changes.featureAutoCopy) isEnabled = changes.featureAutoCopy.newValue;
        });
    }
} catch {}

let overlayHost = null;
let shadowRoot = null;
let hideTimer = null;
let currentRawText = '';
let isEditing = false;

function getSelectionRect() {
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0) return null;
    const range = sel.getRangeAt(0);
    const rect = range.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) return null;
    return rect;
}

function showAndroidClipboardOverlay(text, mouseX, mouseY) {
    currentRawText = text;
    isEditing = false;

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
                pointer-events: auto;
                cursor: pointer;
                opacity: 0;
                transform: scale(0.9) translateY(6px);
                transition: opacity 0.2s cubic-bezier(0.1, 0.9, 0.2, 1), transform 0.2s cubic-bezier(0.1, 0.9, 0.2, 1), max-width 0.2s ease, background-color 0.2s ease;
                max-width: 280px;
                box-sizing: border-box;
                user-select: none;
            }
            .chip-container:hover {
                background: #36343b;
            }
            .chip-container.visible {
                opacity: 1;
                transform: scale(1) translateY(0);
            }
            .chip-container.editing {
                cursor: default;
                max-width: 360px;
                background: #2b2930;
                box-shadow: 0 8px 32px rgba(0, 0, 0, 0.7), 0 0 0 1px rgba(10, 132, 255, 0.35);
            }
            .preview-card {
                background: #1d1b20;
                color: #e6e1e5;
                font-size: 11.5px;
                line-height: 1.35;
                padding: 6px 10px;
                border-radius: 11px;
                max-width: 180px;
                overflow: hidden;
                text-overflow: ellipsis;
                white-space: nowrap;
                border: 1px solid rgba(255, 255, 255, 0.06);
                box-sizing: border-box;
                transition: all 0.2s ease;
            }
            .preview-card.editing {
                max-width: 280px;
                max-height: 140px;
                white-space: pre-wrap;
                word-break: break-word;
                overflow-y: auto;
                cursor: text;
                outline: none;
                user-select: text;
                border-color: rgba(10, 132, 255, 0.4);
                background: #151318;
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
                transition: background-color 0.2s, color 0.2s, transform 0.15s;
            }
            .icon-badge svg {
                width: 14px;
                height: 14px;
                fill: currentColor;
            }
            .chip-container.editing .icon-badge {
                background: #0a84ff;
                color: #ffffff;
                cursor: pointer;
            }
            .chip-container.editing .icon-badge:hover {
                transform: scale(1.08);
            }
            .icon-badge.saved {
                background: #34c759 !important;
                color: #ffffff !important;
            }
        `;
        shadowRoot.appendChild(style);

        const container = document.createElement('div');
        container.className = 'chip-container';
        container.title = 'Click to edit clipboard';
        container.innerHTML = `
            <div class="preview-card" spellcheck="false"></div>
            <div class="icon-badge" title="Save changes">
                <svg viewBox="0 0 24 24"><path d="M19 3h-4.18C14.4 1.84 13.3 1 12 1c-1.3 0-2.4.84-2.82 2H5c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2zm-7 0c.55 0 1 .45 1 1s-.45 1-1 1-1-.45-1-1 .45-1 1-1zm-2 14l-4-4 1.41-1.41L10 14.17l6.59-6.59L18 9l-8 8z"/></svg>
            </div>
        `;
        shadowRoot.appendChild(container);
        document.documentElement.appendChild(overlayHost);

        const preview = container.querySelector('.preview-card');
        const iconBadge = container.querySelector('.icon-badge');

        const enterEditMode = () => {
            if (isEditing) return;
            isEditing = true;
            clearTimeout(hideTimer);
            container.classList.add('editing');
            preview.classList.add('editing');
            preview.setAttribute('contenteditable', 'true');
            preview.textContent = currentRawText;
            
            setTimeout(() => {
                preview.focus();
                const range = document.createRange();
                range.selectNodeContents(preview);
                const sel = window.getSelection();
                sel.removeAllRanges();
                sel.addRange(range);
            }, 20);
        };

        const commitEdit = () => {
            if (!isEditing) return;
            isEditing = false;
            const newText = preview.innerText.trim();
            if (newText && newText !== currentRawText) {
                currentRawText = newText;
                navigator.clipboard.writeText(newText).catch(() => {});
            }

            container.classList.remove('editing');
            preview.classList.remove('editing');
            preview.removeAttribute('contenteditable');
            preview.textContent = currentRawText.length > 40 ? currentRawText.slice(0, 40) + '…' : currentRawText;

            iconBadge.classList.add('saved');
            setTimeout(() => iconBadge.classList.remove('saved'), 600);

            clearTimeout(hideTimer);
            hideTimer = setTimeout(() => {
                container.classList.remove('visible');
            }, 1400);
        };

        const cancelEdit = () => {
            isEditing = false;
            container.classList.remove('editing');
            preview.classList.remove('editing');
            preview.removeAttribute('contenteditable');
            container.classList.remove('visible');
        };

        container.addEventListener('click', (e) => {
            if (!isEditing) {
                e.stopPropagation();
                enterEditMode();
            }
        });

        iconBadge.addEventListener('click', (e) => {
            if (isEditing) {
                e.stopPropagation();
                commitEdit();
            }
        });

        preview.addEventListener('keydown', (e) => {
            if (!isEditing) return;
            if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                commitEdit();
            } else if (e.key === 'Escape') {
                e.preventDefault();
                cancelEdit();
            }
        });

        preview.addEventListener('blur', () => {
            if (isEditing) commitEdit();
        });
    }

    const container = shadowRoot.querySelector('.chip-container');
    const preview = shadowRoot.querySelector('.preview-card');
    
    container.classList.remove('editing');
    preview.classList.remove('editing');
    preview.removeAttribute('contenteditable');
    preview.textContent = text.length > 40 ? text.slice(0, 40) + '…' : text;

    // Calculate position: bottom-right of selection rect
    const rect = getSelectionRect();
    const margin = 8;
    const estWidth = 240;
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
        if (!isEditing) container.classList.remove('visible');
    }, 1800);
}

function isRichEditor(target) {
    if (!target) return false;
    if (target.isContentEditable) return true;
    if (target.getAttribute?.('contenteditable') && target.getAttribute('contenteditable') !== 'false') return true;
    if (target.closest?.('[contenteditable]:not([contenteditable="false"]), [role="textbox"], [role="combobox"], [role="searchbox"], [data-slate-editor], [data-lexical-editor], .DraftEditor-root, .monaco-editor, .cm-editor, .ql-editor, [data-editor]')) return true;
    return false;
}

document.addEventListener('mouseup', e => {
    if (!isEnabled) return;
    if (e.altKey) return;
    if (isEditing) return;

    const target = e.target;
    // Privacy protection: Never auto-copy from password inputs
    if (target && target.tagName === 'INPUT' && target.type === 'password') return;

    let text = '';
    if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA')) {
        const start = target.selectionStart;
        const end = target.selectionEnd;
        if (typeof start === 'number' && typeof end === 'number' && start !== end) {
            text = target.value.substring(start, end).trim();
        }
    }
    if (!text) {
        text = window.getSelection()?.toString()?.trim() || '';
    }

    if (text) {
        document.execCommand('copy');
        showAndroidClipboardOverlay(text, e.clientX, e.clientY);
    }
});

// ==========================================
// UNIVERSAL SAFE FORCE-PASTE & FORCE-COPY ENGINE
// ==========================================

function enableSafePaste(e) {
    const target = e.target;
    if (!target || isRichEditor(target)) return;

    const isInput = target.tagName === 'INPUT' || target.tagName === 'TEXTAREA';
    if (!isInput) return;

    // Dispatch synthetic input and change events after paste for reactive form frameworks
    setTimeout(() => {
        try {
            target.dispatchEvent(new Event('input', { bubbles: true, cancelable: true }));
            target.dispatchEvent(new Event('change', { bubbles: true, cancelable: true }));
        } catch {}
    }, 0);
}

function enableSafeCopyCut(e) {
    const target = e.target;
    if (!target || isRichEditor(target)) return;
    if (e.defaultPrevented) return;
}

function enableSafeContextMenu(e) {
    const target = e.target;
    if (!target || isRichEditor(target)) return;
}

function enableSafeSelection(e) {
    const target = e.target;
    if (!target || isRichEditor(target)) return;
}

// Attach strictly on user interaction
window.addEventListener('paste', enableSafePaste, true);
window.addEventListener('copy', enableSafeCopyCut, true);
window.addEventListener('cut', enableSafeCopyCut, true);
window.addEventListener('contextmenu', enableSafeContextMenu, true);
window.addEventListener('selectstart', enableSafeSelection, true);
window.addEventListener('dragstart', enableSafeSelection, true);

// On-demand attribute sanitization strictly when the user focuses or clicks a form field
function sanitizeTargetElement(el) {
    if (!el || (el.tagName !== 'INPUT' && el.tagName !== 'TEXTAREA')) return;
    const attrs = ['onpaste', 'oncopy', 'oncut', 'oncontextmenu', 'onselectstart', 'ondragstart'];
    for (const attr of attrs) {
        if (el.hasAttribute(attr)) el.removeAttribute(attr);
    }
}

document.addEventListener('focusin', (e) => sanitizeTargetElement(e.target), { passive: true, capture: true });
document.addEventListener('mousedown', (e) => sanitizeTargetElement(e.target), { passive: true, capture: true });