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

        if (dynamicShorteners.has(host)) return true;

        const knownHosts = new Set([
            'bit.ly', 't.co', 'tinyurl.com', 'is.gd', 'v.gd', 'amzn.to', 'buff.ly', 'ow.ly',
            'goo.gl', 'qr.ae', 'cutt.ly', 'rb.gy', 'shorturl.at', 'ift.tt', 'trib.al',
            'rebrand.ly', 'lnkd.in', 'linktr.ee', 'rotf.lol', 'tiny.cc', 'lmg.gg', 'redd.it',
            'spoti.fi', 'apple.co', 'w.wiki', 'wapo.st', 'nyti.ms', 'bit.do', 'shorte.st',
            'geni.us', 'a.co', 'snip.ly', 'snip.li', 't.ly', 'dub.sh', 'snip.to', 's.id'
        ]);
        if (knownHosts.has(host)) return true;

        const shortTlds = /\.(gg|ly|to|co|is|gd|cc|link|me|click|fi|ms|it|st|app|bio|us|sh|io|so|at|am|ws|nu|ee|ai|xyz|site)$/i;
        if (host.length <= 14 && shortTlds.test(host) && /^\/[a-zA-Z0-9_\-\.]{1,25}\/?$/.test(pathname)) {
            return true;
        }

        // Generic vanity single-slug affiliate link pattern (e.g. piavpn.com/ltt, dbrand.com/pcb)
        if (/^\/[a-zA-Z0-9_\-]{1,24}\/?$/.test(pathname) && !pathname.includes('.')) {
            const standardRoots = new Set(['/login', '/signup', '/register', '/about', '/terms', '/privacy', '/contact', '/help', '/support', '/pricing', '/faq']);
            if (!standardRoots.has(pathname.toLowerCase().replace(/\/$/, ''))) {
                return true;
            }
        }
    } catch {}
    return false;
}

const resolvingElements = new WeakSet();

function handleLinkUnshorten(a) {
    if (!a || !a.href || a.dataset.unshortened || resolvingElements.has(a)) return;

    // If wrapped in a gateway, unwrap first
    const unwrapped = unwrapGatewayUrl(a.href);
    if (unwrapped) {
        a.href = unwrapped;
    }

    if (!isShortOrGatewayLink(a.href)) {
        a.dataset.unshortened = 'true';
        return;
    }

    resolvingElements.add(a);
    const targetHref = a.href;

    try {
        chrome.runtime.sendMessage({ action: 'unshortenUrl', url: targetHref }, (res) => {
            resolvingElements.delete(a);
            if (chrome.runtime.lastError || !res?.cleanUrl || res.cleanUrl === targetHref) return;

            a.dataset.unshortened = 'true';
            a.dataset.originalShortUrl = targetHref;
            a.href = res.cleanUrl;
            a.title = `🔗 Destination: ${res.cleanUrl}`;

            // Force Chromium to refresh the native bottom status bubble immediately without requiring hover-out
            if (lastHoveredAnchor === a) {
                a.style.pointerEvents = 'none';
                requestAnimationFrame(() => {
                    a.style.pointerEvents = '';
                    a.dispatchEvent(new MouseEvent('mousemove', {
                        bubbles: true,
                        clientX: lastMouseX,
                        clientY: lastMouseY
                    }));
                });
            }
        });
    } catch {
        resolvingElements.delete(a);
    }
}

function sweepGatewayLinks(root = document) {
    const links = root.querySelectorAll?.('a[href*="redirect?q="], a[href*="google.com/url?q="], a[href*="out.reddit.com"], a[href*="steamcommunity.com/linkfilter"]') || [];
    for (const a of links) {
        const unwrapped = unwrapGatewayUrl(a.href);
        if (unwrapped) {
            a.href = unwrapped;
            if (!isShortOrGatewayLink(unwrapped)) {
                a.dataset.unshortened = 'true';
                a.title = `🔗 Destination: ${unwrapped}`;
            } else {
                delete a.dataset.unshortened;
                handleLinkUnshorten(a);
            }
        }
    }
}

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => sweepGatewayLinks());
} else {
    sweepGatewayLinks();
}

const linkObserver = new MutationObserver((mutations) => {
    for (const mutation of mutations) {
        for (const node of mutation.addedNodes) {
            if (node.nodeType === 1) {
                sweepGatewayLinks(node);
            }
        }
    }
});

linkObserver.observe(document.documentElement || document.body, {
    childList: true,
    subtree: true
});

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
    if (hoverUnshortenTimer) clearTimeout(hoverUnshortenTimer);
    hoverUnshortenTimer = setTimeout(() => handleLinkUnshorten(a), 40);
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

// Immediately resolve on right-click to prepare context menu
document.addEventListener('mousedown', (e) => {
    if (e.button === 2) {
        const a = e.target.closest?.('a[href]');
        if (a) handleLinkUnshorten(a);
    }
}, { passive: true });

// Intercept left-click in capture phase to bypass YouTube/Google tracking router
document.addEventListener('click', (e) => {
    if (e.button !== 0) return;
    const a = e.target.closest?.('a[href]');
    if (!a || !a.href) return;

    const unwrapped = unwrapGatewayUrl(a.href);
    const targetUrl = unwrapped || a.href;

    if (unwrapped || isShortOrGatewayLink(targetUrl)) {
        e.preventDefault();
        e.stopImmediatePropagation();
        a.href = targetUrl;
        
        if (a.dataset.unshortened && targetUrl === a.href) {
            window.open(targetUrl, a.target || '_blank', 'noopener,noreferrer');
        } else {
            chrome.runtime.sendMessage({ action: 'unshortenUrl', url: targetUrl }, (res) => {
                const finalDest = res?.cleanUrl || targetUrl;
                a.href = finalDest;
                a.dataset.unshortened = 'true';
                window.open(finalDest, a.target || '_blank', 'noopener,noreferrer');
            });
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
        chrome.runtime.sendMessage({ action: 'openUnshortenedTab', url: targetUrl });
    }
}, true);
