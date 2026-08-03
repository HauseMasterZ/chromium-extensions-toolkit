chrome.commands.onCommand.addListener(async c => {
  if (c === 'duplicate_tab') {
    let [{ id }] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (id) chrome.tabs.duplicate(id);
    return;
  }
  
  if (c !== 'run' && c !== 'run_yt' && c !== 'run_incognito') return;
  let [{ id, url }] = await chrome.tabs.query({ active: true, currentWindow: true });
  try {
    let result = null;
    let isExtensionPage = false;

    try {
      let res = await chrome.scripting.executeScript({ target: { tabId: id }, func: () => navigator.clipboard.readText() });
      result = res && res[0] ? res[0].result : null;
    } catch (e) {
      isExtensionPage = true;
      try {
        result = await chrome.tabs.sendMessage(id, { action: 'read_clipboard' });
      } catch (e2) {}
    }

    if (result) {
      result = result.trim();
      let isUrl = /^https?:\/\//i.test(result);
      
      if (c === 'run') {
        let finalUrl = isUrl ? result : `https://google.com/search?q=${encodeURIComponent(result)}`;
        if (isExtensionPage) chrome.tabs.update(id, { url: finalUrl });
        else chrome.tabs.create({ url: finalUrl });
      } else if (c === 'run_yt') {
        let finalUrl = `https://www.youtube.com/results?search_query=${encodeURIComponent(result)}`;
        if (isExtensionPage) chrome.tabs.update(id, { url: finalUrl });
        else chrome.tabs.create({ url: finalUrl });
      } else if (c === 'run_incognito') {
        chrome.windows.create({ url: isUrl ? result : `https://google.com/search?q=${encodeURIComponent(result)}`, incognito: true });
      }
    }
  } catch {}
});

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({
    id: "translate_image",
    title: "Translate via Google Lens",
    contexts: ["image"]
  });
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId === "translate_image" && info.srcUrl) {
    let url = `https://lens.google.com/uploadbyurl?url=${encodeURIComponent(info.srcUrl)}`;
    chrome.tabs.create({ url: url });
  }
});