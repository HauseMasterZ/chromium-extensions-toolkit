# Project Rules & Behavioral Guidelines

## 1. Strictly Zero Emojis
- Under no circumstances use any emojis or emoji-like unicode symbols in chat responses, artifacts, code files, comments, or plans.
- Keep all communication, status updates, and code strictly text-based and professional.

## 2. Read-Only Git Policy
- Under no circumstances run git write commands (`git add`, `git commit`, `git push`, `git checkout -b`, `git branch -D`, etc.).
- All git operations must be strictly read-only (`git status`, `git diff`, `git log`).

## 3. Artifact Guidelines
- After creating or updating an artifact, do not re-summarize its contents in the chat response.
- Point the user directly to the artifact link and highlight only open questions or key decisions that require user input.

## 4. Mathematical Formatting
- Use LaTeX math syntax (`$...$` or `$$...$$`) strictly for actual mathematical or physical formulas.
- Never use LaTeX math notation for non-mathematical text arrows, state transitions, or UI flows.

## 5. Architectural & Feature Design Decisions (Intentional Features)
- CPU Temperature Estimation: In `Toolkit/native-host/host.ps1`, the lumped-parameter continuous thermal observer is intentional. Do not modify or flag as unauthorized.
- Remote Rules Syncing: In `Toolkit/bg-service-worker.js`, bundled fallbacks with remote GitHub sync (`syncRemoteClearUrlsRules`, `syncRemoteShortenersList`) and the daily 24-hour sync alarm are intentional.
- Domain Exclusions: In `Toolkit/bg-service-worker.js`, hardcoded domains in `DEFAULT_PERSISTED_ORIGINS` are intentional to safeguard critical logins and personal services from data clearing.
- Display Auto-Zoom: Display management must remain strictly resolution-agnostic by dynamically enumerating all monitors via `chrome.system.display.getInfo()`. Never hardcode display dimensions (e.g. 2560x1600). Monitor zoom settings are managed per-display via `popup.html`, and lifecycle hooks in `Toolkit/display-zoom.js` must remain debounced and throttled.
- Geolocation & Weather Frequency: In `Toolkit/newtab-script.js`, external IP geolocation pings must occur strictly at most once per 24 hours. Weather data refreshes on its independent 30-minute schedule using cached coordinates.
- Link Unshortener: `Toolkit/link-unshortener.js` is an intentional URL unshortener and tracker stripper. It pre-resolves destinations and strips search engine click-tracking redirects while preserving native click navigation (never blocks navigation).
- Floating Clipboard Overlay: The Android-style floating selection chip in `Toolkit/global-auto-copy.js` is intentional.
- WhatsApp Web Tweaks: Camera spoofing and layout expansions in `Toolkit/whatsapp-virtual-camera.js` and `Toolkit/whatsapp-wide-style.js` are intentional.
- YouTube Music Audio-Only: Stream filtering and ambient UI stripping in `Toolkit/yt-music-audio.js` are intentional.
- KillWindowsSearch.bat: The root utility script for disabling Windows SearchHost is intentional.

## 6. Empirical Verification Policy
- Under no circumstances make assumptions regarding hardware states, display capabilities, color profiles, OS settings, or driver configurations without empirical verification.
- Always inspect code, active telemetry streams, native host outputs, or OS registry/WMI queries before formulating diagnostic hypotheses or claiming root causes.

## 7. Native Platform Preference
- Prioritize native platform APIs (standard Web APIs, DOM event delegation, Chrome Extensions MV3 APIs, Win32 P/Invoke in PowerShell) over third-party packages or npm modules.
- Do not introduce external libraries or dependencies when standard native platform capabilities are available.

## 8. Hardware Control, Fault Tolerance & Latency Optimization
- User interactions targeting hardware registers (DDC/CI VCP, brightness, contrast) must utilize leading-edge immediate dispatch (0ms latency on the initial input event).
- Continuous rapid inputs (wheel scrolling, held keys) must coalesce into a trailing throttle window (~40-50ms) to prevent I2C/native bus flooding while preserving responsiveness.
- In native messaging hosts, cache pre-bound physical handles (`hPhys`) in memory for O(1) writes. Never enumerate or recreate handles per write operation, and eliminate blocking post-write readbacks that induce bus delays.
- Win32 Physical Monitor Handle Invariant: In `dxva2.dll`, `hPhysicalMonitor` can legitimately be `(IntPtr)0` (`IntPtr.Zero`) for the first enumerated monitor on a display adapter. Under no circumstances treat `hPhys == IntPtr.Zero` as a null or invalid handle check.
- Self-Healing Handle Recovery: If a cached hardware write fails due to a stale handle (e.g. display standby wake, exclusive fullscreen mode switch, or cable reconnect), native hosts must automatically re-probe handles once and retry the hardware write before reporting failure.
- Multi-Tier Hardware-to-Driver Fallback: Hardware brightness control must implement a multi-tier fallback hierarchy (Direct DDC/CI -> Auto Re-probe & Retry -> GPU Driver Gamma Ramp via `SetDeviceGammaRamp` on the target GDI device) to guarantee user control remains operational in every hardware scenario.
- Resilient Target Resolution: Resolve target monitors using tiered matching (canonical ID, PnP ID, GDI device name, and vendor substring) to prevent misrouting across dynamic display enumeration shifts.

## 9. Display Numbering Convention
- In user-facing UI surfaces (Popup, New Tab Panel Controls, Spec Tables), reference monitors by ordinal display index (`#1`, `#2`) in native display order, rather than vendor brand names or model strings.
