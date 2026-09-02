// ocr-dom-overlay.js
// Content Script for Webpage DOM Scanner & Interactive Live Text Overlay

(function() {
  if (window.__TOOLKIT_OCR_SCRIPT_LOADED__) return;
  window.__TOOLKIT_OCR_SCRIPT_LOADED__ = true;

  let isOcrActive = false;
  let activeLayers = [];
  let toastTimeout = null;
  let selectedWordSpans = [];

  function updateSelectedBadges() {
    selectedWordSpans.forEach((s, idx) => {
      s.setAttribute('data-ocr-index', idx + 1);
    });
  }

  function clearMultiSelect() {
    for (const s of selectedWordSpans) {
      s.classList.remove('selected');
      s.removeAttribute('data-ocr-index');
    }
    selectedWordSpans = [];
  }

  async function copyText(text) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      try {
        const ta = document.createElement('textarea');
        ta.value = text;
        ta.style.position = 'fixed';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        ta.remove();
        return true;
      } catch {
        return false;
      }
    }
  }

  function truncate(str, maxLen = 32) {
    return str.length > maxLen ? str.slice(0, maxLen) + '...' : str;
  }

  function showOcrToast(text, durationMs = 1500) {
    let toast = document.getElementById('toolkit-ocr-toast');
    if (!toast) {
      toast = document.createElement('div');
      toast.id = 'toolkit-ocr-toast';
      (document.body || document.documentElement).appendChild(toast);
    }
    toast.textContent = text;
    requestAnimationFrame(() => {
      toast.classList.add('visible');
    });

    if (toastTimeout) clearTimeout(toastTimeout);
    toastTimeout = setTimeout(() => {
      toast.classList.remove('visible');
      setTimeout(() => {
        if (!toast.classList.contains('visible') && toast.parentNode) {
          toast.remove();
        }
      }, 250);
    }, durationMs);
  }

  function dismissOcr() {
    isOcrActive = false;
    clearMultiSelect();
    for (const layer of activeLayers) {
      if (layer && layer._targetEl) {
        try {
          layer._targetEl.style.userSelect = '';
          layer._targetEl.style.webkitUserDrag = '';
          layer._targetEl.removeAttribute('draggable');
        } catch {}
      }
      if (layer && layer.parentNode) {
        layer.remove();
      }
    }
    activeLayers = [];
    window.removeEventListener('scroll', repositionLayers, { passive: true });
    window.removeEventListener('resize', repositionLayers);
    showOcrToast('OCR dismissed', 1200);
  }

  function getRenderedImageRect(el, naturalW, naturalH) {
    const rect = el.getBoundingClientRect();
    if (!naturalW || !naturalH) {
      return {
        left: rect.left,
        top: rect.top,
        width: rect.width,
        height: rect.height,
        scaleX: 1,
        scaleY: 1
      };
    }

    const style = window.getComputedStyle(el);
    const objectFit = style.objectFit;

    let renderW = rect.width;
    let renderH = rect.height;
    let offsetX = 0;
    let offsetY = 0;

    if (objectFit === 'contain' || (objectFit === 'scale-down' && (naturalW > rect.width || naturalH > rect.height))) {
      const elRatio = rect.width / rect.height;
      const imgRatio = naturalW / naturalH;
      if (elRatio > imgRatio) {
        renderW = rect.height * imgRatio;
        renderH = rect.height;
        offsetX = (rect.width - renderW) / 2;
      } else {
        renderW = rect.width;
        renderH = rect.width / imgRatio;
        offsetY = (rect.height - renderH) / 2;
      }
    } else if (objectFit === 'cover') {
      const elRatio = rect.width / rect.height;
      const imgRatio = naturalW / naturalH;
      if (elRatio > imgRatio) {
        renderW = rect.width;
        renderH = rect.width / imgRatio;
        offsetY = (rect.height - renderH) / 2;
      } else {
        renderW = rect.height * imgRatio;
        renderH = rect.height;
        offsetX = (rect.width - renderW) / 2;
      }
    }

    return {
      left: rect.left + offsetX,
      top: rect.top + offsetY,
      width: renderW,
      height: renderH,
      scaleX: renderW / naturalW,
      scaleY: renderH / naturalH
    };
  }

  function repositionLayers() {
    if (!isOcrActive) return;
    for (const layer of activeLayers) {
      const el = layer._targetEl;
      if (!el || !el.isConnected) continue;
      const r = getRenderedImageRect(el, layer._origW, layer._origH);
      layer.style.left = `${r.left}px`;
      layer.style.top = `${r.top}px`;
      layer.style.width = `${r.width}px`;
      layer.style.height = `${r.height}px`;

      if (layer._scaleX !== r.scaleX || layer._scaleY !== r.scaleY) {
        layer._scaleX = r.scaleX;
        layer._scaleY = r.scaleY;

        const lines = layer.querySelectorAll('.toolkit-ocr-line');
        for (const lineDiv of lines) {
          const lbox = lineDiv._bbox;
          if (lbox) {
            const lWidth = (lbox.x1 - lbox.x0) * r.scaleX;
            const lHeight = (lbox.y1 - lbox.y0) * r.scaleY;
            lineDiv.style.left = `${lbox.x0 * r.scaleX}px`;
            lineDiv.style.top = `${lbox.y0 * r.scaleY}px`;
            lineDiv.style.width = `${Math.max(4, lWidth)}px`;
            lineDiv.style.height = `${Math.max(8, lHeight)}px`;

            const words = lineDiv.querySelectorAll('.toolkit-ocr-word');
            for (const span of words) {
              const bbox = span._bbox;
              if (bbox) {
                const wWidth = (bbox.x1 - bbox.x0) * r.scaleX;
                const wHeight = (bbox.y1 - bbox.y0) * r.scaleY;
                const wLeft = (bbox.x0 - lbox.x0) * r.scaleX;
                const wTop = (bbox.y0 - lbox.y0) * r.scaleY;
                span.style.left = `${wLeft}px`;
                span.style.top = `${wTop}px`;
                span.style.width = `${Math.max(4, wWidth)}px`;
                span.style.height = `${Math.max(8, wHeight)}px`;
                span.style.fontSize = `${Math.max(9, wHeight * 0.85)}px`;
                span.style.lineHeight = `${Math.max(8, wHeight)}px`;
                span.style.transform = 'none';
                const naturalWidth = span.getBoundingClientRect().width;
                if (naturalWidth > 0 && wWidth > 0) {
                  const scale = wWidth / naturalWidth;
                  if (scale >= 0.4 && scale <= 3.0) {
                    span.style.transform = `scaleX(${scale.toFixed(3)})`;
                  }
                }
              }
            }
          }
        }
      }
    }
  }

  function getImageDataUrl(el) {
    try {
      const w = el.naturalWidth || el.width || el.offsetWidth;
      const h = el.naturalHeight || el.height || el.offsetHeight;
      if (!w || !h || w < 32 || h < 32) return null;

      const canvas = document.createElement('canvas');
      canvas.width = w;
      canvas.height = h;
      const ctx = canvas.getContext('2d');
      ctx.drawImage(el, 0, 0, w, h);
      return canvas.toDataURL('image/png');
    } catch {
      // Tainted canvas by cross-origin resource
      return null;
    }
  }

  function findCandidateImages() {
    const candidates = [];
    const elements = document.querySelectorAll('img, canvas, picture > img, div[style*="background-image"], [role="img"]');

    for (const el of elements) {
      const style = window.getComputedStyle(el);
      if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') continue;

      const rect = el.getBoundingClientRect();
      if (rect.width < 48 || rect.height < 48) continue;

      if (el.tagName !== 'IMG' && el.tagName !== 'CANVAS') {
        const bg = style.backgroundImage;
        if (!bg || !bg.includes('url(') || bg === 'none') continue;
      }

      candidates.push(el);
    }

    // Sort candidates so images currently in viewport are processed first
    const vh = window.innerHeight;
    const vw = window.innerWidth;
    candidates.sort((a, b) => {
      const ra = a.getBoundingClientRect();
      const rb = b.getBoundingClientRect();
      const aInView = ra.top < vh && ra.bottom > 0 && ra.left < vw && ra.right > 0;
      const bInView = rb.top < vh && rb.bottom > 0 && rb.left < vw && rb.right > 0;
      if (aInView && !bInView) return -1;
      if (!aInView && bInView) return 1;
      return 0;
    });

    return candidates;
  }

  async function activateOcr() {
    isOcrActive = true;
    const candidates = findCandidateImages();

    if (candidates.length === 0) {
      showOcrToast('No candidate images found on page', 1800);
      isOcrActive = false;
      return;
    }

    showOcrToast(`Scanning ${candidates.length} image${candidates.length === 1 ? '' : 's'} for text...`, 3000);

    window.addEventListener('scroll', repositionLayers, { passive: true });
    window.addEventListener('resize', repositionLayers);

    let processedCount = 0;
    let imagesWithText = 0;

    for (let i = 0; i < candidates.length; i++) {
      if (!isOcrActive) break; // Terminated by user toggle
      const img = candidates[i];
      const dataUrl = getImageDataUrl(img);
      let imgUrl = null;

      if (!dataUrl) {
        if (img.tagName === 'IMG') {
          imgUrl = img.currentSrc || img.src || img.getAttribute('src');
        } else {
          const bg = window.getComputedStyle(img).backgroundImage;
          const match = bg && bg.match(/url\(['"]?(https?:\/\/[^'"]+)['"]?\)/i);
          if (match) imgUrl = match[1];
        }
      }

      if (!dataUrl && !imgUrl) continue;

      showOcrToast(`Reading image ${i + 1} of ${candidates.length}...`, 2500);

      try {
        const res = await new Promise((resolve) => {
          chrome.runtime.sendMessage({
            action: 'ocrProcessImage',
            imageId: `img_${i}`,
            dataUrl: dataUrl,
            imgUrl: imgUrl
          }, resolve);
        });

        if (!isOcrActive) break;
        processedCount++;

        if (res && res.success && res.words && res.words.length > 0) {
          imagesWithText++;
          createLiveTextOverlay(img, res);
        } else if (res && !res.success) {
          console.warn('OCR recognition error for image', i, res.error);
        }
      } catch (err) {
        console.warn('OCR error for image', i, err);
      }
    }

    if (isOcrActive) {
      if (imagesWithText > 0) {
        showOcrToast(`OCR active: ${imagesWithText} image${imagesWithText === 1 ? '' : 's'} selectable (press again to dismiss)`, 3500);
      } else {
        showOcrToast('No readable text found in page images', 2000);
      }
    }
  }

  function createLiveTextOverlay(el, ocrResult) {
    const originalWidth = ocrResult.width || el.naturalWidth || el.clientWidth;
    const originalHeight = ocrResult.height || el.naturalHeight || el.clientHeight;

    if (!originalWidth || !originalHeight) return;

    // Prevent native image dragging while OCR layer is active
    try {
      el.style.userSelect = 'none';
      el.style.webkitUserDrag = 'none';
      el.setAttribute('draggable', 'false');
    } catch {}

    const r = getRenderedImageRect(el, originalWidth, originalHeight);

    const layer = document.createElement('div');
    layer.className = 'toolkit-ocr-layer';
    layer._targetEl = el;
    layer._origW = originalWidth;
    layer._origH = originalHeight;
    layer._scaleX = r.scaleX;
    layer._scaleY = r.scaleY;
    layer.style.left = `${r.left}px`;
    layer.style.top = `${r.top}px`;
    layer.style.width = `${r.width}px`;
    layer.style.height = `${r.height}px`;

    // Seamless mouse drag tracking: enable dragging state when mouse down on any text
    layer.addEventListener('mousedown', () => {
      layer.classList.add('dragging');
    });

    // Subtle OCR indicator badge
    const badge = document.createElement('div');
    badge.className = 'toolkit-ocr-badge';
    badge.textContent = 'OCR';
    layer.appendChild(badge);

    (document.body || document.documentElement).appendChild(layer);
    activeLayers.push(layer);

    // Group words into lines to guarantee strict top-to-bottom, left-to-right DOM order
    let lines = ocrResult.lines;
    if (!lines || lines.length === 0) {
      const words = [...(ocrResult.words || [])].sort((a, b) => a.bbox.y0 - b.bbox.y0);
      lines = [];
      let currentLine = null;
      for (const w of words) {
        if (!currentLine || Math.abs((w.bbox.y0 + w.bbox.y1) / 2 - (currentLine.bbox.y0 + currentLine.bbox.y1) / 2) > 12) {
          currentLine = { bbox: { ...w.bbox }, words: [w] };
          lines.push(currentLine);
        } else {
          currentLine.words.push(w);
          currentLine.bbox.x0 = Math.min(currentLine.bbox.x0, w.bbox.x0);
          currentLine.bbox.y0 = Math.min(currentLine.bbox.y0, w.bbox.y0);
          currentLine.bbox.x1 = Math.max(currentLine.bbox.x1, w.bbox.x1);
          currentLine.bbox.y1 = Math.max(currentLine.bbox.y1, w.bbox.y1);
        }
      }
    }

    for (const line of lines) {
      if (!line.words || line.words.length === 0) continue;

      const lineDiv = document.createElement('div');
      lineDiv.className = 'toolkit-ocr-line';
      lineDiv._bbox = line.bbox;

      const lWidth = (line.bbox.x1 - line.bbox.x0) * r.scaleX;
      const lHeight = (line.bbox.y1 - line.bbox.y0) * r.scaleY;
      const lLeft = line.bbox.x0 * r.scaleX;
      const lTop = line.bbox.y0 * r.scaleY;

      lineDiv.style.left = `${lLeft}px`;
      lineDiv.style.top = `${lTop}px`;
      lineDiv.style.width = `${Math.max(4, lWidth)}px`;
      lineDiv.style.height = `${Math.max(8, lHeight)}px`;

      // Sort words within line strictly from left to right
      const sortedWords = [...line.words].sort((a, b) => a.bbox.x0 - b.bbox.x0);

      for (const word of sortedWords) {
        if (!word.text || !word.bbox) continue;
        const span = document.createElement('span');
        span.className = 'toolkit-ocr-word';
        span.textContent = word.text; // Exact text without trailing space
        span.title = word.text;
        span._bbox = word.bbox;

        // Position relative to lineDiv
        const wWidth = (word.bbox.x1 - word.bbox.x0) * r.scaleX;
        const wHeight = (word.bbox.y1 - word.bbox.y0) * r.scaleY;
        const wLeft = (word.bbox.x0 - line.bbox.x0) * r.scaleX;
        const wTop = (word.bbox.y0 - line.bbox.y0) * r.scaleY;

        span.style.left = `${wLeft}px`;
        span.style.top = `${wTop}px`;
        span.style.width = `${Math.max(4, wWidth)}px`;
        span.style.height = `${Math.max(8, wHeight)}px`;
        span.style.fontSize = `${Math.max(9, wHeight * 0.85)}px`;
        span.style.lineHeight = `${Math.max(8, wHeight)}px`;

        span.addEventListener('click', async (e) => {
          e.stopPropagation();
          e.preventDefault();

          const isCtrlOrCmd = e.ctrlKey || e.metaKey;

          if (isCtrlOrCmd) {
            const existingIdx = selectedWordSpans.indexOf(span);
            if (existingIdx !== -1) {
              // Deselect if already in chain
              selectedWordSpans.splice(existingIdx, 1);
              span.classList.remove('selected');
              span.removeAttribute('data-ocr-index');
            } else {
              // Append to selection chain in exact order clicked
              selectedWordSpans.push(span);
              span.classList.add('selected');
            }

            updateSelectedBadges();

            if (selectedWordSpans.length > 0) {
              const combinedText = selectedWordSpans.map(s => s.textContent).join(' ');
              await copyText(combinedText);
              showOcrToast(`Copied (${selectedWordSpans.length}): "${truncate(combinedText)}"`, 1500);
            } else {
              showOcrToast('Selection cleared', 1000);
            }
          } else {
            // Single click without Ctrl: copy just this word
            clearMultiSelect();
            selectedWordSpans = [span];
            span.classList.add('selected');
            updateSelectedBadges();
            await copyText(span.textContent);
            showOcrToast(`Copied: "${truncate(span.textContent)}"`, 1200);
          }
        });

        lineDiv.appendChild(span);

        // Measure unscaled rendered text width in DOM and apply scaleX to span wWidth perfectly
        const naturalWidth = span.getBoundingClientRect().width;
        if (naturalWidth > 0 && wWidth > 0) {
          const scale = wWidth / naturalWidth;
          if (scale >= 0.4 && scale <= 3.0) {
            span.style.transform = `scaleX(${scale.toFixed(3)})`;
          }
        }
      }

      layer.appendChild(lineDiv);
    }

    layer.addEventListener('click', (e) => {
      if (!e.target.closest('.toolkit-ocr-word')) {
        if (!e.ctrlKey && !e.metaKey && selectedWordSpans.length > 0) {
          clearMultiSelect();
          showOcrToast('Selection cleared', 800);
        }
      }
    });
  }

  function toggleOcr() {
    if (isOcrActive) {
      dismissOcr();
    } else {
      activateOcr();
    }
  }

  window.addEventListener('mouseup', () => {
    for (const layer of activeLayers) {
      if (layer) layer.classList.remove('dragging');
    }
  });

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg.action === 'toggle_ocr') {
      toggleOcr();
      sendResponse({ active: isOcrActive });
      return false;
    }
  });
})();
