chrome.commands.onCommand.addListener(async c => {
  if (c !== 'run' && c !== 'run_yt') return;
  let [{ id }] = await chrome.tabs.query({ active: true, currentWindow: true });
  try {
    let [{ result }] = await chrome.scripting.executeScript({ target: { tabId: id }, func: () => navigator.clipboard.readText() });
    if (result) {
      if (c === 'run') {
        chrome.tabs.create({ url: /^https?:\/\//i.test(result) ? result : `https://google.com/search?q=${encodeURIComponent(result)}` });
      } else if (c === 'run_yt') {
        chrome.tabs.create({ url: `https://www.youtube.com/results?search_query=${encodeURIComponent(result)}` });
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