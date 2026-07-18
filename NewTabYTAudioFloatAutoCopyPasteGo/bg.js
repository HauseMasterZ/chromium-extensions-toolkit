chrome.commands.onCommand.addListener(async c => {
  if (c !== 'run') return;
  let [{ id }] = await chrome.tabs.query({ active: true, currentWindow: true });
  try {
    let [{ result }] = await chrome.scripting.executeScript({ target: { tabId: id }, func: () => navigator.clipboard.readText() });
    if (result) chrome.tabs.create({ url: /^https?:\/\//i.test(result) ? result : `https://google.com/search?q=${encodeURIComponent(result)}` });
  } catch {}
});