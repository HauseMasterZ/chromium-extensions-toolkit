let isEnabled = true;
chrome.storage.local.get({ featureAutoCopy: true }, (res) => { isEnabled = res.featureAutoCopy; });
chrome.storage.onChanged.addListener((changes) => {
    if (changes.featureAutoCopy) isEnabled = changes.featureAutoCopy.newValue;
});

document.addEventListener('mouseup', e => {
  if (!isEnabled) return;
  if (!e.altKey && window.getSelection().toString().trim()) document.execCommand('copy');
});