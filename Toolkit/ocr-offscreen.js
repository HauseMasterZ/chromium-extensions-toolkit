// ocr-offscreen.js
// Offscreen Document Worker for 100% Offline Tesseract.js WASM Engine

let tesseractWorkerPromise = null;
let idleTimer = null;

async function createLocalWorker() {
  const options = {
    workerPath: chrome.runtime.getURL('ocr/worker.min.js'),
    corePath: chrome.runtime.getURL('ocr/tesseract-core-simd-lstm.wasm.js'),
    langPath: chrome.runtime.getURL('ocr'),
    workerBlobURL: false,
    gzip: true,
    cacheMethod: 'none',
    logger: () => {}
  };

  try {
    const worker = await Tesseract.createWorker('eng', 1, options);
    return worker;
  } catch (simdErr) {
    console.warn('SIMD WASM init failed, falling back to standard LSTM WASM:', simdErr);
    options.corePath = chrome.runtime.getURL('ocr/tesseract-core-lstm.wasm.js');
    const fallbackWorker = await Tesseract.createWorker('eng', 1, options);
    return fallbackWorker;
  }
}

async function getTesseractWorker() {
  if (!tesseractWorkerPromise) {
    tesseractWorkerPromise = createLocalWorker().catch((err) => {
      tesseractWorkerPromise = null;
      throw err;
    });
  }
  return tesseractWorkerPromise;
}

function resetIdleTimer() {
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = setTimeout(async () => {
    if (tesseractWorkerPromise) {
      try {
        const worker = await tesseractWorkerPromise;
        await worker.terminate();
      } catch {}
      tesseractWorkerPromise = null;
    }
  }, 45000);
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.target !== 'offscreen') return false;

  if (msg.action === 'OCR_RECOGNIZE') {
    resetIdleTimer();
    (async () => {
      try {
        const worker = await getTesseractWorker();
        const ret = await worker.recognize(msg.dataUrl);
        
        const lines = (ret.data?.lines || []).map(line => ({
          text: line.text,
          confidence: line.confidence,
          bbox: line.bbox,
          words: (line.words || []).map(w => ({
            text: w.text,
            confidence: w.confidence,
            bbox: w.bbox
          })).filter(w => w.text && w.text.trim().length > 0)
        })).filter(line => line.words && line.words.length > 0);

        // Sort lines in natural 2D reading order (top-to-bottom, left-to-right)
        lines.sort((a, b) => {
          const midA = (a.bbox.y0 + a.bbox.y1) / 2;
          const midB = (b.bbox.y0 + b.bbox.y1) / 2;
          const avgH = ((a.bbox.y1 - a.bbox.y0) + (b.bbox.y1 - b.bbox.y0)) / 2;
          if (Math.abs(midA - midB) < avgH * 0.5) {
            return a.bbox.x0 - b.bbox.x0;
          }
          return midA - midB;
        });

        const words = [];
        for (const line of lines) {
          line.words.sort((a, b) => a.bbox.x0 - b.bbox.x0);
          for (const w of line.words) {
            words.push(w);
          }
        }

        sendResponse({
          success: true,
          imageId: msg.imageId,
          width: ret.data?.imageColor?.width || ret.data?.width || 0,
          height: ret.data?.imageColor?.height || ret.data?.height || 0,
          lines: lines,
          words: words
        });
      } catch (err) {
        console.error('OCR Recognition error:', err);
        sendResponse({ success: false, imageId: msg.imageId, error: err?.message || String(err) });
      }
    })();
    return true; // Keep message channel open for async response
  }

  if (msg.action === 'OCR_TERMINATE') {
    if (idleTimer) clearTimeout(idleTimer);
    if (tesseractWorkerPromise) {
      tesseractWorkerPromise.then(w => w.terminate()).catch(() => {});
      tesseractWorkerPromise = null;
    }
    sendResponse({ success: true });
    return false;
  }
});
