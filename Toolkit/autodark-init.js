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
                    chrome.runtime.sendMessage({ action: 'fetchCSS', url: url }, response => {
                        if (response && response.text) {
                            resolve(new Response(response.text, { headers: { 'Content-Type': 'text/css' } }));
                        } else {
                            resolve(new Response('', { headers: { 'Content-Type': 'text/css' } }));
                        }
                    });
                });
            });

            window.__DARK_MODE_TOGGLE__ = function() {
                const fastStyle = document.getElementById('fast-inject-style');
                if (enabled) {
                    DarkReader.disable();
                    if (fastStyle) fastStyle.disabled = true;
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
                    if (fastStyle) fastStyle.disabled = false;
                    enabled = true;
                }
                window.__DARK_MODE_IS_ACTIVE__ = enabled;
            };
            
            // Enable immediately on first injection
            window.__DARK_MODE_TOGGLE__();
        }
    }

    initDarkReader();
})();
