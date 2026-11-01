(() => {
  if (window.__volumeControllerInjected) return;
  window.__volumeControllerInjected = true;

  let currentVolume = 1.0;
  let isObserving = false;

  function applyVolumeTo(element) {
    if (element.nodeName === 'AUDIO' || element.nodeName === 'VIDEO') {
      element.volume = currentVolume;
    }
    if (element.querySelectorAll) {
      const media = element.querySelectorAll('audio, video');
      for (let i = 0; i < media.length; i++) {
        media[i].volume = currentVolume;
      }
    }
  }

  function applyVolumeAll() {
    const media = document.querySelectorAll('audio, video');
    for (let i = 0; i < media.length; i++) {
      media[i].volume = currentVolume;
    }
  }

  const observer = new MutationObserver((mutations) => {
    if (currentVolume === 1.0) return;
    for (let i = 0; i < mutations.length; i++) {
      const added = mutations[i].addedNodes;
      for (let j = 0; j < added.length; j++) {
        const node = added[j];
        if (node.nodeType === 1) {
          applyVolumeTo(node);
        }
      }
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
