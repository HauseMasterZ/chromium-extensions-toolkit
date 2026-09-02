# Design Specification: Webpage DOM OCR & Interactive Text Overlay

**Date**: 2026-09-03  
**Status**: Draft / Pending Approval  
**Component**: Chrome Extension (Unified Toolkit)  

---

## 1. Overview & Problem Statement

Users frequently encounter non-selectable text embedded inside web images, infographics, diagrams, social media posts, presentation slides, and rasterized memes across the internet. Currently, copying this text requires third-party tools, screen-snipping utilities, or manual re-typing.

This feature adds a keyboard shortcut to the **Unified Toolkit** extension that performs **on-demand Optical Character Recognition (OCR)** across all visible candidate images on the active webpage's DOM. It overlays an exact, interactive, selectable text layer directly on top of the images (similar to Apple Live Text / Project Naptha), allowing users to seamlessly highlight, select, and copy text directly from the page layout.

---

## 2. Requirements & Constraints

### User Requirements
1. **Shortcut Trigger**:
   - Add a command named `ocr_dom` to `manifest.json`.
   - **No default shortcut key assigned** (left unassigned for the user to configure in `chrome://extensions/shortcuts`).
2. **Interactive Live Text Overlay**:
   - For all candidate images on the active page, extract and map recognized words onto an invisible/semi-transparent text layer overlaid directly on top of each image.
   - Text must be accurately positioned, responsive, selectable with the mouse cursor, and copyable via `Ctrl+C`.
3. **Toggle Behavior**:
   - Pressing the shortcut once initiates scanning and overlays text.
   - Pressing the shortcut a second time cleanly dismisses all OCR overlays and restores standard page state.
4. **Discreet Progress Feedback**:
   - Unobtrusive pill toast showing:
     - `Scanning images for text... (0/N)`
     - `OCR active: X images processed (press again to dismiss)`
     - `OCR dismissed`
5. **Fully Offline & Privacy-First**:
   - 100% client-side execution using bundled WebAssembly (WASM).
   - Zero network requests, zero telemetry, zero data exfiltration.

### Technical & Platform Constraints
1. **Manifest V3 (MV3) Security & CSP**:
   - Cannot run `eval()` or load external scripts/models from CDNs. All WASM and worker scripts must be bundled locally within the extension.
   - Host pages often have restrictive Content Security Policies (`script-src 'self'`, `worker-src 'none'`). Therefore, the OCR engine must run inside an MV3 **Offscreen Document**, where extension-level permissions apply and host page CSPs are bypassed.
2. **Permanent Repository Constraint**:
   - **DO NOT PERFORM GIT ADD, COMMIT, OR PUSH OPERATIONS UNDER ANY CIRCUMSTANCES**. All changes remain local.

---

## 3. Architecture & Data Flow

```
┌────────────────────────────────────────────────────────────────────────┐
│                        Active Tab (Content Script)                     │
│  1. Receives "toggle_ocr" message                                      │
│  2. Discovers visible candidate images (>= 48x48px)                    │
│  3. Converts images to image data / URLs                               │
└───────────────────────────────────┬────────────────────────────────────┘
                                    │ (Message Passing: candidate images)
                                    ▼
┌────────────────────────────────────────────────────────────────────────┐
│                     Background Service Worker                          │
│  • Manages Offscreen Document lifecycle                                │
│  • Bypasses CORS by fetching cross-origin images via host permissions  │
│  • Forwards tasks to Offscreen Document and streams results to Tab     │
└───────────────────────────────────┬────────────────────────────────────┘
                                    │
                                    ▼
┌────────────────────────────────────────────────────────────────────────┐
│                     Offscreen Document (ocr-worker)                    │
│  • Hosts Tesseract.js v5 WASM Engine                                   │
│  • Loads bundled local eng.traineddata.gz                              │
│  • Processes images and outputs bounding boxes { x0, y0, x1, y1, text} │
└───────────────────────────────────┬────────────────────────────────────┘
                                    │ (Returns word/line bounding boxes)
                                    ▼
┌────────────────────────────────────────────────────────────────────────┐
│                        Active Tab (Content Script)                     │
│  4. Scales OCR coordinates to rendered image dimensions                │
│  5. Injects positioned selectable span overlay over each image         │
│  6. Shows completion toast ("OCR active: X images processed")          │
└────────────────────────────────────────────────────────────────────────┘
```

---

## 4. Detailed Component Design

### A. Manifest Configuration (`manifest.json`)
- Add `"offscreen"` to `permissions`.
- Add command:
  ```json
  "ocr_dom": {
    "description": "Toggle DOM Image OCR"
  }
  ```
- Declare local assets under `web_accessible_resources` for WASM/worker scripts if needed.

### B. Background Service Worker (`bg-service-worker.js`)
- Listens for `c === 'ocr_dom'`.
- Sends toggle command to the active tab.
- Offscreen Document Manager:
  - Ensures `ocr-offscreen.html` exists using `chrome.offscreen.createDocument({ reasons: ['WORKERS', 'BLOBS'], justification: 'Run offline OCR engine' })`.
  - Terminates the offscreen document after 30 seconds of inactivity to free memory.
- CORS Proxy Helper:
  - When an image in a content script is tainted by cross-origin restrictions, the background script fetches the image blob directly via extension host permissions (`<all_urls>`), converts to data URL, and passes to the OCR worker.

### C. Offscreen OCR Engine (`ocr-offscreen.html`, `ocr-offscreen.js`)
- Runs Tesseract.js using locally bundled assets in `ocr/`:
  - `ocr/tesseract.min.js`
  - `ocr/worker.min.js`
  - `ocr/tesseract-core.wasm.js` / `.wasm`
  - `ocr/eng.traineddata.gz` (fast English model)
- Accepts `{ imageId, dataUrl }`.
- Returns `{ imageId, width, height, words: [{ text, bbox: { x0, y0, x1, y1 } }] }`.

### D. DOM Image Scanner & Interactive Overlay (`ocr-dom-overlay.js`)
1. **Candidate Discovery**:
   - Queries `img`, `canvas`, `picture > img`, and visible elements with high-resolution CSS background images.
   - Filters out:
     - Hidden elements (`display: none`, `visibility: hidden`, `opacity: 0`).
     - Dimensions smaller than 48×48px (icons, bullets, spacers, tracking pixels).
     - SVGs that already contain native SVG `<text>` elements.
2. **Coordinate Normalization**:
   - `scaleX = element.clientWidth / originalWidth`
   - `scaleY = element.clientHeight / originalHeight`
   - Computed position:
     ```css
     left: scaleX * bbox.x0 px;
     top: scaleY * bbox.y0 px;
     width: scaleX * (bbox.x1 - bbox.x0) px;
     height: scaleY * (bbox.y1 - bbox.y0) px;
     ```
3. **Overlay Element Styling**:
   - Placed in an absolute container matching the image's exact bounding client rect (`position: absolute`, `pointer-events: none`).
   - Words are `<span>` elements with `position: absolute`, `pointer-events: auto`, `user-select: text !important`.
   - Invisible by default (`opacity: 0`), but highlights with standard blue selection tint when highlighted with the mouse.
   - Title attribute set to recognized text for hover preview accessibility.
4. **State Management**:
   - Global toggle flag `window.__TOOLKIT_OCR_ACTIVE__`.
   - If active, removes all `.toolkit-ocr-container` DOM nodes and sets state to inactive.

---

## 5. Performance & Resource Guardrails

1. **Batching**:
   - Processes in-viewport images first, then continues with images below the fold.
2. **Worker Teardown**:
   - Automatically releases Tesseract WASM memory when idle.
3. **Pill Toast Feedback**:
   - Reuses the extension's lightweight native `showPillToast` component to provide immediate, unobtrusive status updates.

---

## 6. Verification Plan

1. **Manifest Validation**:
   - Verify `ocr_dom` appears in `chrome://extensions/shortcuts` with no default key binding.
   - Verify `"offscreen"` permission works without errors.
2. **Functional Tests**:
   - Assign a shortcut in `chrome://extensions/shortcuts` (e.g. `Ctrl+Shift+O` or `Alt+O`).
   - Test on a webpage containing infographic / text images (e.g. Wikipedia infobox image, GitHub diagram).
   - Verify pill toast shows progress.
   - Highlight text inside the image with the mouse; copy (`Ctrl+C`) and paste (`Ctrl+V`) into a text editor to confirm exact text extraction.
3. **Toggle Dismissal**:
   - Press shortcut again; verify all overlays are destroyed and the page returns to 100% normal DOM state.
4. **Strict Safety Rules**:
   - Confirm **zero git add/commit/push commands** were executed.
