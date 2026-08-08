chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg.action === 'read_clipboard') {
        navigator.clipboard.readText()
            .then(text => sendResponse({ result: text }))
            .catch(err => sendResponse({ error: err.toString() }));
        return true; 
    }
});
