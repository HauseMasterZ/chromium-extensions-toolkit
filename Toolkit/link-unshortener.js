// ==========================================
// UNIVERSAL LINK UNSHORTENER & GATEWAY UNWRAPPER
// ==========================================

let dynamicShorteners = new Set();

try {
    chrome.storage.local.get('cachedShortenersList', (res) => {
        if (Array.isArray(res.cachedShortenersList)) {
            dynamicShorteners = new Set(res.cachedShortenersList);
        }
    });
    chrome.storage.onChanged.addListener((changes, area) => {
        if (area === 'local' && changes.cachedShortenersList?.newValue) {
            dynamicShorteners = new Set(changes.cachedShortenersList.newValue);
        }
    });
} catch {}

function unwrapGatewayUrl(rawUrl) {
    if (!rawUrl) return null;
    try {
        const url = new URL(rawUrl);
        const paramNames = ['q', 'url', 'dest', 'destination', 'target', 'u', 'redirect_uri', 'r', 'z', 'link'];
        for (const p of paramNames) {
            const val = url.searchParams.get(p);
            if (val && /^https?:\/\//i.test(val)) {
                return val;
            }
        }
    } catch {}
    return null;
}

function isShortOrGatewayLink(rawUrl) {
    if (!rawUrl || !/^https?:\/\//i.test(rawUrl)) return false;
    if (unwrapGatewayUrl(rawUrl)) return true;
    
    try {
        const url = new URL(rawUrl);
        const host = url.hostname.toLowerCase().replace(/^www\./, '');
        const pathname = url.pathname;

        // Never treat same-domain internal links as shorteners
        const currentHost = window.location.hostname.toLowerCase().replace(/^www\./, '');
        if (host === currentHost || host.endsWith('.' + currentHost) || currentHost.endsWith('.' + host)) {
            return false;
        }

        // Exclude static media, stylesheets, and binary downloads
        if (/\.(png|jpg|jpeg|gif|webp|svg|mp4|webm|zip|tar|gz|pdf|css|js|woff|woff2|ttf|json|xml)$/i.test(pathname)) {
            return false;
        }

        // Tier 2: 40,495+ verified dynamic shorteners & clickthrough database
        if (dynamicShorteners.has(host)) return true;

        // Built-in known shortener services
        const knownHosts = new Set([
            'bit.ly', 't.co', 'tinyurl.com', 'is.gd', 'v.gd', 'amzn.to', 'buff.ly', 'ow.ly',
            'goo.gl', 'qr.ae', 'cutt.ly', 'rb.gy', 'shorturl.at', 'ift.tt', 'trib.al',
            'rebrand.ly', 'lnkd.in', 'linktr.ee', 'rotf.lol', 'tiny.cc', 'lmg.gg', 'redd.it',
            'spoti.fi', 'apple.co', 'w.wiki', 'wapo.st', 'nyti.ms', 'bit.do', 'shorte.st',
            'geni.us', 'a.co', 'snip.ly', 'snip.li', 't.ly', 'dub.sh', 'snip.to', 's.id'
        ]);
        if (knownHosts.has(host)) return true;

        // Dedicated shortener TLDs with single slug (e.g. *.gg/xyz, *.ly/xyz, *.to/xyz, *.link/xyz)
        const shortTlds = /\.(gg|ly|to|co|is|gd|cc|link|me|click|fi|ms|it|st|app|bio|us|sh|io|so|at|am|ws|nu|ee|ai|xyz|site)$/i;
        if (host.length <= 14 && shortTlds.test(host) && /^\/[a-zA-Z0-9_\-\.]{1,25}\/?$/.test(pathname)) {
            return true;
        }

        // Tier 3: External cross-origin paths for sponsor/vanity unshortening (e.g. piavpn.com/ltt, dbrand.com/mkbhd)
        if (pathname && pathname.length > 1 && pathname !== '/' && !pathname.includes('//')) {
            return true;
        }
    } catch {}
    return false;
}

function injectUnshortenStyles() {
    if (document.getElementById('toolkit-unshorten-styles')) return;
    const style = document.createElement('style');
    style.id = 'toolkit-unshorten-styles';
    style.textContent = `
        @keyframes toolkitUnshortenPulse {
            0% { text-decoration-color: rgba(59, 130, 246, 0.35); }
            50% { text-decoration-color: rgba(59, 130, 246, 1); }
            100% { text-decoration-color: rgba(59, 130, 246, 0.35); }
        }
        a[data-unshorten-state="resolving"] {
            text-decoration: underline dashed #3b82f6 !important;
            text-decoration-thickness: 1.5px !important;
            text-underline-offset: 3px !important;
            animation: toolkitUnshortenPulse 0.75s infinite ease-in-out !important;
        }
        a[data-unshorten-state="resolved"] {
            text-decoration-style: solid !important;
        }
    `;
    (document.head || document.documentElement).appendChild(style);
}

const resolvingElements = new WeakSet();
const tabUnshortenCache = new Map();

function isHighConfidenceShortener(rawUrl) {
    if (!rawUrl) return false;
    if (unwrapGatewayUrl(rawUrl)) return true;
    try {
        const url = new URL(rawUrl);
        const host = url.hostname.toLowerCase().replace(/^www\./, '');
        return dynamicShorteners.has(host) || knownHosts.has(host);
    } catch {}
    return false;
}

function refreshBrowserStatusBubble(a) {
    if (!a || lastHoveredAnchor !== a) return;
    a.style.pointerEvents = 'none';
    requestAnimationFrame(() => {
        a.style.pointerEvents = '';
        a.dispatchEvent(new MouseEvent('mousemove', {
            bubbles: true,
            cancelable: true,
            view: window,
            clientX: lastMouseX,
            clientY: lastMouseY
        }));
    });
}

function handleLinkUnshorten(a) {
    if (!a || !a.href || resolvingElements.has(a)) return;

    // If wrapped in a gateway, unwrap first
    const unwrapped = unwrapGatewayUrl(a.href);
    if (unwrapped) {
        a.href = unwrapped;
    }

    if (!isShortOrGatewayLink(a.href)) {
        if (unwrapped) {
            a.dataset.unshortened = 'true';
            refreshBrowserStatusBubble(a);
        }
        delete a.dataset.unshortenState;
        return;
    }

    const targetHref = a.href;

    // 0ms In-Tab Cache Hit
    if (tabUnshortenCache.has(targetHref)) {
        const cachedUrl = tabUnshortenCache.get(targetHref);
        if (cachedUrl && cachedUrl !== targetHref) {
            a.dataset.unshortenState = 'resolved';
            a.dataset.unshortened = 'true';
            a.dataset.originalShortUrl = targetHref;
            a.href = cachedUrl;
            refreshBrowserStatusBubble(a);
        }
        return;
    }

    resolvingElements.add(a);
    a.dataset.unshortenState = 'resolving';

    try {
        if (!chrome.runtime?.id) {
            resolvingElements.delete(a);
            delete a.dataset.unshortenState;
            return;
        }

        chrome.runtime.sendMessage({ action: 'unshortenUrl', url: targetHref }, (res) => {
            resolvingElements.delete(a);
            if (chrome.runtime.lastError || !res?.cleanUrl || res.cleanUrl === targetHref) {
                delete a.dataset.unshortenState;
                return;
            }

            tabUnshortenCache.set(targetHref, res.cleanUrl);
            a.dataset.unshortenState = 'resolved';
            a.dataset.unshortened = 'true';
            a.dataset.originalShortUrl = targetHref;
            a.href = res.cleanUrl;
            refreshBrowserStatusBubble(a);
        });
    } catch {
        resolvingElements.delete(a);
        delete a.dataset.unshortenState;
    }
}

let lastHoveredAnchor = null;
let lastMouseX = 0;
let lastMouseY = 0;
let hoverUnshortenTimer = null;

document.addEventListener('mouseover', (e) => {
    lastMouseX = e.clientX;
    lastMouseY = e.clientY;
    const a = e.target.closest?.('a[href]');
    lastHoveredAnchor = a;
    if (!a) return;
    try { injectUnshortenStyles(); } catch {}
    if (hoverUnshortenTimer) clearTimeout(hoverUnshortenTimer);
    
    // Instant 0ms for high-confidence shorteners, tight 15ms debounce for general external links
    if (isHighConfidenceShortener(a.href) || tabUnshortenCache.has(a.href)) {
        handleLinkUnshorten(a);
    } else {
        hoverUnshortenTimer = setTimeout(() => handleLinkUnshorten(a), 15);
    }
}, { passive: true });

document.addEventListener('mousemove', (e) => {
    lastMouseX = e.clientX;
    lastMouseY = e.clientY;
}, { passive: true });

document.addEventListener('focusin', (e) => {
    const a = e.target.closest?.('a[href]');
    lastHoveredAnchor = a;
    if (!a) return;
    handleLinkUnshorten(a);
}, { passive: true });

// Synchronously unwrap on right-click context menu so Chrome's native "Copy link address" captures clean URL
document.addEventListener('contextmenu', (e) => {
    const a = e.target.closest?.('a[href]');
    if (!a || !a.href) return;
    const unwrapped = unwrapGatewayUrl(a.href);
    if (unwrapped) {
        a.href = unwrapped;
        a.dataset.unshortened = 'true';
    }
    if (isShortOrGatewayLink(a.href)) {
        handleLinkUnshorten(a);
    }
}, { capture: true });

// Immediately resolve on right-click to prepare native menu actions
document.addEventListener('mousedown', (e) => {
    if (e.button === 2) {
        const a = e.target.closest?.('a[href]');
        if (!a || !a.href) return;
        const unwrapped = unwrapGatewayUrl(a.href);
        if (unwrapped) {
            a.href = unwrapped;
            a.dataset.unshortened = 'true';
        }
        if (isShortOrGatewayLink(a.href)) handleLinkUnshorten(a);
    }
}, { passive: true });

// Intercept clipboard copy to ensure any gateway URL copied via shortcut/context menu is unwrapped
document.addEventListener('copy', (e) => {
    const target = e.target;
    if (target && (target.isContentEditable || target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.closest?.('[contenteditable="true"]'))) return;
    const sel = window.getSelection()?.toString()?.trim();
    if (sel && /^https?:\/\//i.test(sel)) {
        const unwrapped = unwrapGatewayUrl(sel);
        if (unwrapped) {
            e.clipboardData?.setData('text/plain', unwrapped);
            e.preventDefault();
        }
    }
});

// Intercept left-click in capture phase to bypass YouTube/Google tracking router
document.addEventListener('click', (e) => {
    if (e.button !== 0) return;
    const a = e.target.closest?.('a[href]');
    if (!a || !a.href) return;

    const unwrapped = unwrapGatewayUrl(a.href);
    if (unwrapped) {
        a.href = unwrapped;
        a.dataset.unshortened = 'true';
        if (!isShortOrGatewayLink(unwrapped)) return;
    }

    if (isShortOrGatewayLink(a.href) && !a.dataset.unshortened) {
        const targetUrl = a.href;
        e.preventDefault();
        e.stopImmediatePropagation();
        
        const navigate = (dest) => {
            a.href = dest;
            a.dataset.unshortened = 'true';
            if (a.target === '_blank' || e.ctrlKey || e.metaKey) {
                window.open(dest, '_blank', 'noopener,noreferrer');
            } else {
                window.location.href = dest;
            }
        };

        try {
            if (chrome.runtime?.id) {
                chrome.runtime.sendMessage({ action: 'unshortenUrl', url: targetUrl }, (res) => {
                    navigate(res?.cleanUrl || targetUrl);
                });
            } else {
                navigate(targetUrl);
            }
        } catch {
            navigate(targetUrl);
        }
    }
}, true);

// Intercept middle-click (button 1) in capture phase to open clean/unshortened link in a background tab
document.addEventListener('auxclick', (e) => {
    if (e.button !== 1) return;
    const a = e.target.closest?.('a[href]');
    if (!a || !a.href) return;

    const unwrapped = unwrapGatewayUrl(a.href);
    const targetUrl = unwrapped || a.href;

    if (unwrapped || isShortOrGatewayLink(targetUrl)) {
        e.preventDefault();
        e.stopImmediatePropagation();
        a.href = targetUrl;
        try {
            if (chrome.runtime?.id) {
                chrome.runtime.sendMessage({ action: 'openUnshortenedTab', url: targetUrl });
            } else {
                window.open(targetUrl, '_blank');
            }
        } catch {
            window.open(targetUrl, '_blank');
        }
    }
}, true);
