# Project Rules & Behavioral Guidelines

## 1. Strictly Zero Emojis
- Under no circumstances use any emojis or emoji-like unicode symbols in chat responses, artifacts, code files, comments, or plans.
- Keep all communication, status updates, and code strictly text-based and professional.

## 2. Commit and Push Policy
- After every single change, stage, commit, and push the changes to remote (`git push origin main`).
- Use existing commit messages as a template following the conventional format (e.g. `fix: <scope>`, `feat: <scope>`).

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
- Internal Display Multi-Tier Architecture: Integrated laptop panels lack external DDC/CI scalers. Internal backlight control must route through a panel-agnostic multi-tier fallback: Tier 1 Win32 Kernel IOCTL (`IOCTL_VIDEO_SET_DISPLAY_BRIGHTNESS` on `\\.\LCD` updating both AC and DC policies in <10ms) -> Tier 2 WHQL WMI Backlight Interface (`root\wmi:WmiMonitorBrightnessMethods` -> `WmiSetBrightness`) -> Tier 3 GPU Hardware LUT Ramp via `SetDeviceGammaRamp` on `\\.\DISPLAY1`. Contrast and RGB white balance gains on internal displays must route directly through hardware LUT gamma ramps.
- Native Messaging Stream Decoding (UTF-8 BOM Invariant): Native messaging hosts reading length-prefixed packets from standard input (`Console.OpenStandardInput`) must inspect and discard any optional 3-byte UTF-8 Byte Order Mark (`0xEF, 0xBB, 0xBF`) on the first packet, preventing length prefix corruption from permanently stalling the stdin reader loop.
- Resilient Target Resolution: Resolve target monitors using tiered matching (canonical ID, PnP ID, GDI device name, and vendor substring) to prevent misrouting across dynamic display enumeration shifts.

## 9. Display Numbering Convention
- In user-facing UI surfaces (Popup, New Tab Panel Controls, Spec Tables), reference monitors by ordinal display index (`#1`, `#2`) in native display order, rather than vendor brand names or model strings.
- Authoritative OS Display Ordering Invariant: Display numbering must be derived deterministically from the operating system's active GDI device enumeration (`EnumDisplayMonitors` sorted by natural GDI device index: `DISPLAY1` -> `#1`, `DISPLAY2` -> `#2`, `DISPLAY5` -> `#3`). Telemetry payloads must transmit the 1-based `windowsDisplayNumber`, and all frontend surfaces must sort displays strictly by `windowsDisplayNumber` ascending rather than primary monitor status, hardware connection order, or arbitrary array indices.

## 10. Code Style, Scope Isolation & Repository Hygiene
- Repository Line Ending Preservation: Code files in this repository use LF (`\n`) line endings. Programmatic file edits, generation scripts, and templates must preserve LF (`\n`) formatting to maintain clean, minimal git diffs.
- Lexical Scope Isolation: In browser extension scripts, enforce strict variable scoping to avoid identifier shadowing or re-declaration collisions (`SyntaxError: Identifier 'x' has already been declared`).


## 11. Absolute Workspace Boundary Isolation
- Under no circumstances read, inspect, query, or execute commands against files or directories outside `C:\Users\HauseMaster\Documents\Code\CToolkit`. Sibling repositories in `Documents\Code\` are strictly off-limits.
- When an uploaded screenshot or context references an external repository or URL, Antigravity must address only its relationship to the current CToolkit extension (e.g. browser zoom scaling, DOM overrides, or CSP), without inspecting external project codebases.
- Workspace boundaries are mechanically enforced at the runtime level via `.agents/hooks.json` PreToolUse lifecycle hooks.

## 12. Native Messaging Process & Win32 Handle Invariants
- Cooperative Teardown Invariant: `System.Environment.Exit` is strictly forbidden in background or worker threads of native messaging hosts. Process exit must always be cooperative via signaling flags (`[MonitorController]::IsRunning = false; [MonitorController]::WakeSignal.Set();`), ensuring the main thread unwinds and executes the PowerShell pipeline's `finally` block to release NVML, runspaces, GDI DCs, and Win32 physical monitor handles.
- Win32 Physical Monitor Handle Arrays: `DestroyPhysicalMonitors` must never be called on individual array elements inside a monitor enumeration loop. Clean up shared handle arrays as distinct sets to avoid double-free exceptions on multi-monitor configurations sharing an `HMONITOR`.
- Unmanaged Handle & Memory Cleanup: All unmanaged GDI device contexts (`CreateDC`), kernel device files (`CreateFile`), and unmanaged heap allocations (`Marshal.AllocHGlobal`) must be wrapped in `try ... finally` blocks to ensure `DeleteDC`, `CloseHandle`, and `FreeHGlobal` execute even under driver reset or bus exceptions.
- NVML Throttle Bitmask Invariant: Bit `0x40` denotes hardware thermal slowdown (`nvmlClocksThrottleReasonHwThermalSlowdown`) and bit `0x20` denotes software thermal slowdown. Never test generic hardware slowdown (`0x08`) for thermal alerts.

## 13. Chrome Extension MV3 Network & IPC Resilience
- Cross-Origin Page CSP Proxying: Content scripts must never execute direct cross-origin `fetch()` calls from restricted page origins (such as `youtube.com`). External network requests must be proxied through `Toolkit/bg-service-worker.js` with target origins declared under `host_permissions` in `Toolkit/manifest.json`.
- Unchecked Runtime LastError Prevention: All `chrome.runtime.sendMessage` callbacks must inspect `if (chrome.runtime.lastError) return;` at the leading edge to prevent Chromium from logging `Unchecked runtime.lastError: The message port closed before a response was received`.

## 14. Display Auto-Zoom Concurrency & Reentrancy Guards
- Programmatic Reentrancy Guard: Programmatic zoom adjustments (`setZoomSettings`, `setZoom`) must set temporary reentrancy lock tokens to prevent `chrome.tabs.onZoomChange` from misidentifying the extension's own per-tab mode switches as manual user zoom overrides.
- Bounded Memory Lifecycle: Ephemeral tab and window tracking structures (such as `pendingPurgedTabs`) must be cleared following session initialization and strictly guarded against unbounded monotonic memory growth.

## 15. WebHID Invariant & Info Panel Boundary Isolation
- Under no circumstances execute, initialize, or poll WebHID (`navigator.hid`, `queryAtkMouseState`, `checkAndQueryAtkMouseOnDemand`, `device.open`) on page load or outside State 3 (`infoState === 3`).
- All WebHID access in `Toolkit/newtab-script.js` must be strictly gated behind `if (infoState !== 3) return;` to prevent Chromium from surfacing the taskbar/tray HID notification icon on new tab creation.
- Mechanically enforced via `.git/hooks/pre-commit`, `.agents/scripts/verify_invariants.py`, and `.agents/scripts/workspace_guard.py`.

