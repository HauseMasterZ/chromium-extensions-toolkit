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

const knownHosts = new Set([
    'bit.ly', 't.co', 'tinyurl.com', 'is.gd', 'v.gd', 'amzn.to', 'buff.ly', 'ow.ly',
    'goo.gl', 'qr.ae', 'cutt.ly', 'rb.gy', 'shorturl.at', 'ift.tt', 'trib.al',
    'rebrand.ly', 'lnkd.in', 'linktr.ee', 'rotf.lol', 'tiny.cc', 'lmg.gg', 'redd.it',
    'spoti.fi', 'apple.co', 'w.wiki', 'wapo.st', 'nyti.ms', 'bit.do', 'shorte.st',
    'geni.us', 'a.co', 'snip.ly', 'snip.li', 't.ly', 'dub.sh', 'snip.to', 's.id'
]);

const shortTlds = /\.(gg|ly|to|co|is|gd|cc|link|me|click|fi|ms|it|st|app|bio|us|sh|io|so|at|am|ws|nu|ee|ai|xyz|site)$/i;

const excludedAuthHosts = new Set([
    'accounts.google.com', 'myaccount.google.com', 'support.google.com', 'mail.google.com',
    'login.microsoftonline.com', 'account.microsoft.com', 'appleid.apple.com'
]);

function getBaseDomain(h) {
    if (!h) return '';
    const parts = h.split('.');
    return parts.length >= 2 ? parts.slice(-2).join('.') : h;
}

function isShortOrGatewayLink(rawUrl) {
    if (!rawUrl || !/^https?:\/\//i.test(rawUrl)) return false;
    if (unwrapGatewayUrl(rawUrl)) return true;
    
    try {
        const url = new URL(rawUrl);
        const host = url.hostname.toLowerCase().replace(/^www\./, '');
        const pathname = url.pathname;

        // Never touch authentication, account switcher, or login service domains
        if (excludedAuthHosts.has(host)) return false;

        // Never treat same-domain or same base-domain internal links as shorteners (e.g. mail.google.com -> accounts.google.com)
        const currentHost = window.location.hostname.toLowerCase().replace(/^www\./, '');
        if (host === currentHost || host.endsWith('.' + currentHost) || currentHost.endsWith('.' + host)) {
            return false;
        }
        const currentBase = getBaseDomain(currentHost);
        const linkBase = getBaseDomain(host);
        if (currentBase && linkBase && currentBase === linkBase) {
            return false;
        }

        // Exclude static media, stylesheets, and binary downloads
        if (/\.(png|jpg|jpeg|gif|webp|svg|mp4|webm|zip|tar|gz|pdf|css|js|woff|woff2|ttf|json|xml)$/i.test(pathname)) {
            return false;
        }

        // Tier 2: 40,495+ verified dynamic shorteners & clickthrough database
        if (dynamicShorteners.has(host)) return true;

        // Built-in known shortener services
        if (knownHosts.has(host)) return true;

        // Dedicated shortener TLDs with single slug (e.g. *.gg/xyz, *.ly/xyz, *.to/xyz, *.link/xyz)
        if (host.length <= 14 && shortTlds.test(host) && /^\/[a-zA-Z0-9_\-\.]{1,25}\/?$/.test(pathname)) {
            return true;
        }

        // Tier 3: External cross-origin paths for unshortening, vanity links, and tracking stripping (e.g. search result links)
        if ((pathname && pathname.length > 1 && pathname !== '/' && !pathname.includes('//')) ||
            (url.search && url.search.length > 1) ||
            currentHost.includes('google.') || currentHost.includes('bing.') || currentHost.includes('duckduckgo.')) {
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
        a[data-unshorten-state="resolving"],
        a[data-unshorten-state="resolving"] * {
            text-decoration: underline dashed #3b82f6 !important;
            text-decoration-thickness: 1.5px !important;
            text-underline-offset: 3px !important;
            animation: toolkitUnshortenPulse 0.75s infinite ease-in-out !important;
        }
        a[data-unshorten-state="resolved"],
        a[data-unshorten-state="resolved"] * {
            text-decoration-style: solid !important;
        }
    `;
    (document.head || document.documentElement).appendChild(style);
}

try { injectUnshortenStyles(); } catch {}

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
    try {
        a.dispatchEvent(new MouseEvent('mousemove', {
            bubbles: true,
            cancelable: true,
            view: window,
            clientX: lastMouseX,
            clientY: lastMouseY
        }));
    } catch {}
}

function saveRawHref(a) {
    if (!a || !a.href) return;
    if (!a.dataset.rawHref) {
        a.dataset.rawHref = a.href;
    }
}

function getAnchorFromEvent(e) {
    if (!e) return null;
    if (e.target?.closest) {
        const a = e.target.closest('a[href]');
        if (a) return a;
    }
    if (typeof e.composedPath === 'function') {
        for (const el of e.composedPath()) {
            if (el?.tagName === 'A' && el.href) return el;
        }
    }
    return null;
}

function handleLinkUnshorten(a) {
    if (!a || !a.href || resolvingElements.has(a)) return;

    saveRawHref(a);

    // If wrapped in a gateway, unwrap first
    const unwrapped = unwrapGatewayUrl(a.href);
    if (unwrapped) {
        a.href = unwrapped;
        a.dataset.unshortened = 'true';
        a.dataset.unshortenState = 'resolved';
        refreshBrowserStatusBubble(a);
    }

    if (!isShortOrGatewayLink(a.href)) {
        if (!unwrapped) {
            delete a.dataset.unshortenState;
        }
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
                if (!a.dataset.unshortened) {
                    delete a.dataset.unshortenState;
                } else {
                    a.dataset.unshortenState = 'resolved';
                }
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

function isExternalSearchOrGatewayLink(a) {
    if (!a || !a.href) return false;
    if (unwrapGatewayUrl(a.href)) return true;

    try {
        const url = new URL(a.href);
        const host = url.hostname.toLowerCase().replace(/^www\./, '');
        if (excludedAuthHosts.has(host)) return false;

        const currentHost = window.location.hostname.toLowerCase().replace(/^www\./, '');
        const currentBase = getBaseDomain(currentHost);
        const linkBase = getBaseDomain(host);

        // Same base domain internal links (e.g. google.com -> accounts.google.com, pagination, tabs) are never external search targets
        if (currentBase && linkBase && currentBase === linkBase) return false;

        // On search engine domains, any external cross-origin link is a search result
        if (currentHost.includes('google.') || currentHost.includes('bing.') || currentHost.includes('duckduckgo.')) {
            return true;
        }
    } catch {}
    return false;
}

function neutralizeGoogleTracking(a) {
    if (!a) return;
    if (a.hasAttribute('data-jsarwt')) a.removeAttribute('data-jsarwt');
    if (a.hasAttribute('onmousedown')) a.removeAttribute('onmousedown');
    if (a.hasAttribute('ping')) a.removeAttribute('ping');
    const jsaction = a.getAttribute('jsaction');
    if (jsaction && (jsaction.includes('rcuQ6b') || jsaction.includes('rwt'))) {
        a.removeAttribute('jsaction');
    }
}

let lastHoveredAnchor = null;
let lastMouseX = 0;
let lastMouseY = 0;
let hoverUnshortenTimer = null;

document.addEventListener('mouseover', (e) => {
    lastMouseX = e.clientX;
    lastMouseY = e.clientY;
    const a = getAnchorFromEvent(e);
    lastHoveredAnchor = a;
    if (!a) return;
    saveRawHref(a);
    try { injectUnshortenStyles(); } catch {}

    if (isExternalSearchOrGatewayLink(a)) {
        neutralizeGoogleTracking(a);
    }

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
    const a = getAnchorFromEvent(e);
    lastHoveredAnchor = a;
    if (!a) return;
    saveRawHref(a);
    handleLinkUnshorten(a);
}, { passive: true });

let lastRightClickedLink = null;

// Synchronously unwrap on right-click context menu so Chrome's native "Copy link address" captures clean URL
document.addEventListener('contextmenu', (e) => {
    const a = getAnchorFromEvent(e);
    if (!a || !a.href) {
        lastRightClickedLink = null;
        return;
    }
    saveRawHref(a);
    lastRightClickedLink = {
        rawUrl: a.dataset.rawHref || a.dataset.originalShortUrl || a.href,
        currentUrl: a.href
    };
    const unwrapped = unwrapGatewayUrl(a.href);
    if (unwrapped) {
        a.href = unwrapped;
        a.dataset.unshortened = 'true';
    }
    if (isShortOrGatewayLink(a.href)) {
        handleLinkUnshorten(a);
    }
}, { capture: true });

// Synchronously unwrap and prevent tracking scripts from rewriting URLs on mouse press
document.addEventListener('mousedown', (e) => {
    const a = getAnchorFromEvent(e);
    if (!a || !a.href) return;

    saveRawHref(a);
    const unwrapped = unwrapGatewayUrl(a.href);
    if (unwrapped) {
        a.href = unwrapped;
        a.dataset.unshortened = 'true';
    }
    if (tabUnshortenCache.has(a.href)) {
        const cachedUrl = tabUnshortenCache.get(a.href);
        if (cachedUrl && cachedUrl !== a.href) {
            a.href = cachedUrl;
            a.dataset.unshortened = 'true';
        }
    }

    if (e.button === 2) {
        // Right click: prepare clean URL for context menu
        if (isShortOrGatewayLink(a.href)) handleLinkUnshorten(a);
    } else if (e.button === 0 || e.button === 1) {
        // Left or middle click: stop search engine from replacing clean href with tracking redirect
        if (isExternalSearchOrGatewayLink(a)) {
            neutralizeGoogleTracking(a);
            e.stopImmediatePropagation();
        }
    }
}, { capture: true });

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

// Non-intrusive left-click: synchronously unwrap tracking gateways and bypass tracking router in 0ms
document.addEventListener('click', (e) => {
    if (e.button !== 0) return;
    const a = getAnchorFromEvent(e);
    if (!a || !a.href) return;

    saveRawHref(a);
    // Fast synchronous gateway unwrap in 0ms (e.g. google.com/url?q=... -> clean destination)
    const unwrapped = unwrapGatewayUrl(a.href);
    if (unwrapped) {
        a.href = unwrapped;
        a.dataset.unshortened = 'true';
    }

    // If already pre-resolved in cache from hover, apply clean URL synchronously
    if (tabUnshortenCache.has(a.href)) {
        const cachedUrl = tabUnshortenCache.get(a.href);
        if (cachedUrl && cachedUrl !== a.href) {
            a.href = cachedUrl;
            a.dataset.unshortened = 'true';
        }
    }

    // For external search results / gateway links, stop Google's tracking script from hijacking or delaying navigation
    if (isExternalSearchOrGatewayLink(a)) {
        neutralizeGoogleTracking(a);
        e.stopImmediatePropagation();
        // NEVER call e.preventDefault()! The browser navigates directly and instantly to a.href in 0ms.
    }
}, { capture: true });

// Non-intrusive middle-click: synchronously prepare clean URL for background tab
document.addEventListener('auxclick', (e) => {
    if (e.button !== 1) return;
    const a = getAnchorFromEvent(e);
    if (!a || !a.href) return;

    saveRawHref(a);
    const unwrapped = unwrapGatewayUrl(a.href);
    if (unwrapped) {
        a.href = unwrapped;
        a.dataset.unshortened = 'true';
    }
    if (tabUnshortenCache.has(a.href)) {
        const cachedUrl = tabUnshortenCache.get(a.href);
        if (cachedUrl && cachedUrl !== a.href) {
            a.href = cachedUrl;
            a.dataset.unshortened = 'true';
        }
    }

    if (isExternalSearchOrGatewayLink(a)) {
        neutralizeGoogleTracking(a);
        e.stopImmediatePropagation();
    }
}, { capture: true });

function findRawUrlInCache(cleanUrl) {
    if (!cleanUrl) return null;
    for (const [raw, clean] of tabUnshortenCache.entries()) {
        if (clean === cleanUrl) return raw;
    }
    return null;
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg?.action === 'get_raw_link') {
        let rawUrl = lastRightClickedLink?.rawUrl;

        if (!rawUrl && msg.linkUrl) {
            for (const a of document.querySelectorAll('a[href]')) {
                if (a.href === msg.linkUrl) {
                    rawUrl = a.dataset.rawHref || a.dataset.originalShortUrl;
                    if (rawUrl) break;
                }
            }
            if (!rawUrl) {
                rawUrl = findRawUrlInCache(msg.linkUrl);
            }
        }

        sendResponse({ rawUrl: rawUrl || msg.linkUrl });
        return false;
    }
});
