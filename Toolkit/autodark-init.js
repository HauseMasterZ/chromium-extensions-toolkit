// autodark-init.js
// Runs at document_idle for 100% peak page load speed while maintaining zero-flash pre-paint veil

(function() {
    if (window.__DARK_MODE_INJECTED__) {
        window.__DARK_MODE_TOGGLE__();
        return;
    }
    window.__DARK_MODE_INJECTED__ = true;
    let enabled = false;

    let activeFetches = 0;
    let debounceTimer = null;
    let readyTriggered = false;
    const localCssCache = new Map();

    function triggerReady() {
        if (readyTriggered) return;
        readyTriggered = true;
        requestAnimationFrame(() => {
            document.documentElement.classList.add('darkreader-ready');
        });
    }

    function markReady() {
        if (debounceTimer) clearTimeout(debounceTimer);
        debounceTimer = setTimeout(() => {
            if (activeFetches <= 0) {
                triggerReady();
            }
        }, 35);
    }

    // Safety watchdog: guarantee pre-paint veil removal within 350ms even if external CDN fetches stall
    setTimeout(triggerReady, 350);

    function initDarkReader() {
        if (typeof DarkReader !== 'undefined') {
            DarkReader.setFetchMethod(url => {
                if (localCssCache.has(url)) {
                    return Promise.resolve(new Response(localCssCache.get(url), { headers: { 'Content-Type': 'text/css' } }));
                }

                activeFetches++;
                return new Promise((resolve) => {
                    let completed = false;
                    const finish = (cssText) => {
                        if (completed) return;
                        completed = true;
                        activeFetches = Math.max(0, activeFetches - 1);
                        markReady();
                        if (cssText) {
                            localCssCache.set(url, cssText);
                            resolve(new Response(cssText, { headers: { 'Content-Type': 'text/css' } }));
                        } else {
                            resolve(new Response('', { headers: { 'Content-Type': 'text/css' } }));
                        }
                    };

                    const fetchTimeout = setTimeout(() => finish(''), 2000);

                    if (!chrome.runtime?.id) {
                        clearTimeout(fetchTimeout);
                        return finish('');
                    }

                    try {
                        chrome.runtime.sendMessage({ action: 'fetchCSS', url: url }, response => {
                            clearTimeout(fetchTimeout);
                            if (chrome.runtime.lastError || !response?.text) {
                                finish('');
                            } else {
                                finish(response.text);
                            }
                        });
                    } catch {
                        clearTimeout(fetchTimeout);
                        finish('');
                    }
                });
            });

            window.__DARK_MODE_TOGGLE__ = function() {
                if (enabled) {
                    DarkReader.disable();
                    document.documentElement.classList.add('darkreader--disabled');
                    document.documentElement.classList.remove('darkreader-ready');
                    readyTriggered = false;
                    enabled = false;
                } else {
                    document.documentElement.classList.remove('darkreader--disabled');
                    DarkReader.enable({
                        brightness: 100,
                        contrast: 100,
                        sepia: 0,
                        darkSchemeBackgroundColor: '#000000',
                        darkSchemeTextColor: '#e8eaed',
                        lightSchemeBackgroundColor: '#000000',
                        lightSchemeTextColor: '#e8eaed',
                    }, {
                        css: `
                            html, body {
                                background-image: none !important;
                            }
                            /* Neutralize mix-blend-mode: multiply/darken which crushes images/tiles into pitch-black against dark backgrounds */
                            img,
                            video,
                            canvas,
                            svg,
                            picture,
                            [style*="background-image"],
                            [class*="image-display"],
                            [class*="imageDisplay"],
                            .a-image-container,
                            .a-image-container img,
                            .a-list-item img,
                            .a-section img,
                            .a-section,
                            [class*="imageContainer"],
                            [class*="imageContainer"] img,
                            [class*="productImageContainer"] *,
                            [data-pf=DESKTOP] [class*="img"] *,
                            [class*="ryp__review-candidate-new__product-image"],
                            [class*="VariationOptionItem__swatchImageOverlay"],
                            [class*="fluidLandscapeImage"],
                            [class*="fluidFatImage"],
                            [data-a-image-source],
                            [class*="quadrant-"],
                            [class*="deal"],
                            [class*="Deal"],
                            [style*="mix-blend-mode"] {
                                mix-blend-mode: normal !important;
                            }
                            .a-image-container img,
                            [class*="fluidLandscapeImage"],
                            [class*="fluidFatImage"],
                            [class*="productImageContainer"] img {
                                filter: none !important;
                            }
                        `,
                        ignoreImageAnalysis: ['*']
                    });
                    enabled = true;
                    markReady();
                    setTimeout(triggerReady, 350);
                }
                window.__DARK_MODE_IS_ACTIVE__ = enabled;
                return enabled;
            };
            
            // Enable on document_idle and track stylesheet resolution
            window.__DARK_MODE_TOGGLE__();
        }
    }

    initDarkReader();
})();
