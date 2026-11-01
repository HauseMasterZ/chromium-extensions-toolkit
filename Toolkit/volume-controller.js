(() => {
  if (window.__volumeControllerInjected) return;
  window.__volumeControllerInjected = true;

  let currentVolume = 1.0;
  let isObserving = false;


  function applyVolumeAll() {
    const media = document.querySelectorAll('audio, video');
    for (let i = 0; i < media.length; i++) {
      media[i].volume = currentVolume;
    }
  }

  let mutationDebounceTimer = null;

  const observer = new MutationObserver((mutations) => {
    if (currentVolume === 1.0) return;
    let needsSubtreeScan = false;
    for (let i = 0; i < mutations.length; i++) {
      const added = mutations[i].addedNodes;
      for (let j = 0; j < added.length; j++) {
        const node = added[j];
        if (node.nodeType === 1) {
          if (node.nodeName === 'AUDIO' || node.nodeName === 'VIDEO') {
            node.volume = currentVolume;
          } else if (!needsSubtreeScan && (node.firstElementChild || node.childNodes.length > 0)) {
            needsSubtreeScan = true;
          }
        }
      }
    }
    if (needsSubtreeScan && !mutationDebounceTimer) {
      mutationDebounceTimer = setTimeout(() => {
        mutationDebounceTimer = null;
        if (currentVolume !== 1.0) {
          applyVolumeAll();
        }
      }, 50);
    }
  });

  function updateObserverState() {
    if (currentVolume !== 1.0 && !isObserving) {
      const target = document.documentElement || document.body;
      if (target) {
        observer.observe(target, { childList: true, subtree: true });
        isObserving = true;
      }
    } else if (currentVolume === 1.0 && isObserving) {
      if (mutationDebounceTimer) {
        clearTimeout(mutationDebounceTimer);
        mutationDebounceTimer = null;
      }
      observer.disconnect();
      isObserving = false;
    }
  }

  chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.action === 'getVolume') {
      sendResponse({ volume: currentVolume });
      return false;
    }
    if (request.action === 'setVolume') {
      const vol = Number(request.volume);
      if (!isNaN(vol)) {
        currentVolume = Math.max(0, Math.min(1, vol));
        applyVolumeAll();
        updateObserverState();
      }
      sendResponse({ success: true, volume: currentVolume });
      return false;
    }
  });
})();
