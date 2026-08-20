// autodark-init.js
// Intelligently delays the official Dark Reader to maximize Lighthouse scores

(function() {
    if (window.__DARK_MODE_INJECTED__) {
        window.__DARK_MODE_TOGGLE__();
        return;
    }
    window.__DARK_MODE_INJECTED__ = true;
    let enabled = false;

    function initDarkReader() {
        if (typeof DarkReader !== 'undefined') {
            DarkReader.setFetchMethod(url => {
                return new Promise((resolve) => {
                    const fallbackResponse = () => resolve(new Response('', { headers: { 'Content-Type': 'text/css' } }));

                    if (!chrome.runtime?.id) {
                        return fallbackResponse();
                    }

                    try {
                        chrome.runtime.sendMessage({ action: 'fetchCSS', url: url }, response => {
                            if (chrome.runtime.lastError || !response?.text) {
                                fallbackResponse();
                            } else {
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
                    document.documentElement.classList.remove('fast-dark-active');
                    enabled = false;
                } else {
                    DarkReader.enable({
                        brightness: 100,
                        contrast: 100,
                        sepia: 0,
                        darkSchemeBackgroundColor: '#000000',
                        darkSchemeTextColor: '#e8eaed',
                        lightSchemeBackgroundColor: '#000000',
                        lightSchemeTextColor: '#e8eaed',
                    });
                    document.documentElement.classList.add('fast-dark-active');
                    enabled = true;
                }
                window.__DARK_MODE_IS_ACTIVE__ = enabled;
                return enabled;
            };
            
            // Enable immediately on first injection
            window.__DARK_MODE_TOGGLE__();
        }
    }

    initDarkReader();
})();
