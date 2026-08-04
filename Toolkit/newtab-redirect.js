chrome.storage.local.get({ featureNewTabPage: true }, (res) => {
  if (!res.featureNewTabPage) {
    chrome.tabs.update({ url: 'chrome://new-tab-page/' });
  } else {
    document.documentElement.style.display = '';
  }
});
