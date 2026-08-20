chrome.storage.local.get({ featureNewTabPage: true }, (res) => {
  // If the feature is disabled, or we are in an incognito window, revert to the native new tab
  if (!res.featureNewTabPage || chrome.extension?.inIncognitoContext) {
    chrome.tabs.update({ url: 'chrome://new-tab-page/' });
  } else {
    document.documentElement.style.display = '';
  }
});
