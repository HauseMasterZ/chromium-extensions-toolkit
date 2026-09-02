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
    const localCssCache = new Map();

    function markReady() {
        if (debounceTimer) clearTimeout(debounceTimer);
        debounceTimer = setTimeout(() => {
            if (activeFetches === 0) {
                requestAnimationFrame(() => {
                    document.documentElement.classList.add('darkreader-ready');
                });
            }
        }, 35);
    }

    function initDarkReader() {
        if (typeof DarkReader !== 'undefined') {
            DarkReader.setFetchMethod(url => {
                if (localCssCache.has(url)) {
                    return Promise.resolve(new Response(localCssCache.get(url), { headers: { 'Content-Type': 'text/css' } }));
                }

                activeFetches++;
                return new Promise((resolve) => {
                    const fallbackResponse = () => {
                        activeFetches--;
                        markReady();
                        resolve(new Response('', { headers: { 'Content-Type': 'text/css' } }));
                    };

                    if (!chrome.runtime?.id) {
                        return fallbackResponse();
                    }

                    try {
                        chrome.runtime.sendMessage({ action: 'fetchCSS', url: url }, response => {
                            activeFetches--;
                            markReady();
                            if (chrome.runtime.lastError || !response?.text) {
                                fallbackResponse();
                            } else {
                                localCssCache.set(url, response.text);
                                resolve(new Response(response.text, { headers: { 'Content-Type': 'text/css' } }));
                            }
                        });
                    } catch {
                        fallbackResponse();
                    }
                });
            });

            window.__DARK_MODE_TOGGLE__ = function() {
                if (enabled) {
                    DarkReader.disable();
                    document.documentElement.classList.add('darkreader--disabled');
                    document.documentElement.classList.remove('darkreader-ready');
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
                        `
                    });
                    enabled = true;
                    markReady();
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
