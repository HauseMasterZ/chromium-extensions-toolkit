(() => {
const openTabs = (urls, updateFirst = false) => {
    if (updateFirst) chrome.tabs.update({ url: urls[0] });
    else chrome.tabs.create({ url: urls[0] });
    urls.slice(1).forEach(url => chrome.tabs.create({ url }));
};

document.getElementById('link-l').addEventListener('click', () => openTabs(['https://discord.com/channels/@me', 'https://music.youtube.com/', 'https://photos.google.com/u/1/?pli=1']));
document.getElementById('link-m').addEventListener('click', () => openTabs(['https://mail.google.com/mail/u/0/#inbox', 'https://reddit.com', 'https://app.notesnook.com/notes'], true));
document.getElementById('link-r').addEventListener('click', () => openTabs(['https://web.whatsapp.com', 'https://gemini.google.com/u/1/app?hl=en-IN&pageId=none'], true));

// Time and Weather Logic
const timeEl = document.getElementById('time');
const weatherEl = document.getElementById('weather');

function timeToWords(hours, minutes) {
    const nums = ["", "One", "Two", "Three", "Four", "Five", "Six", "Seven", "Eight", "Nine", "Ten", "Eleven", "Twelve", "Thirteen", "Fourteen", "Fifteen", "Sixteen", "Seventeen", "Eighteen", "Nineteen"];
    const tens = ["", "", "Twenty", "Thirty", "Forty", "Fifty"];

    function numToWord(n) {
        if (n < 20) return nums[n];
        return tens[Math.floor(n / 10)] + (n % 10 !== 0 ? " " + nums[n % 10] : "");
    }

    let h = hours % 12;
    if (h === 0) h = 12;
    
    let hourStr = nums[h];
    
    let minuteStr = "";
    if (minutes === 0) {
        minuteStr = "Oh clock";
    } else if (minutes < 10) {
        minuteStr = `Oh ${nums[minutes]}`;
    } else {
        minuteStr = numToWord(minutes);
    }
    
    return `<span class="time-its">It's</span> <span class="time-hour">${hourStr}</span> <span class="time-minute">${minuteStr}</span>`;
}

function updateTime() {
    const now = new Date();
    timeEl.innerHTML = timeToWords(now.getHours(), now.getMinutes());
    
    // Optimize: Schedule next update exactly when the minute changes with 50ms guard
    const msUntilNextMinute = (60 - now.getSeconds()) * 1000 - now.getMilliseconds();
    setTimeout(updateTime, Math.max(50, msUntilNextMinute + 50));
}
updateTime();

// Instant synchronous hydration from localStorage cache to eliminate visual pop-in
const localCachedWeather = localStorage.getItem('weatherCache');
if (localCachedWeather) {
    weatherEl.innerHTML = localCachedWeather;
} else {
    weatherEl.textContent = 'Loading weather...';
}

// Hydrate from chrome.storage.local (centralized in background service worker)
try {
    chrome.storage.local.get(['weatherCache', 'weatherCacheTime'], (res) => {
        const now = Date.now();
        const cacheTime = parseInt(res?.weatherCacheTime, 10);
        const isStale = !res?.weatherCache || isNaN(cacheTime) || (now - cacheTime) >= 30 * 60 * 1000;

        if (res?.weatherCache) {
            weatherEl.innerHTML = res.weatherCache;
            try { localStorage.setItem('weatherCache', res.weatherCache); } catch {}
        }

        if (isStale) {
            chrome.runtime.sendMessage({ action: 'refresh_weather' }, (resp) => {
                if (chrome.runtime.lastError) return;
                if (resp?.weather) {
                    weatherEl.innerHTML = resp.weather;
                    try { localStorage.setItem('weatherCache', resp.weather); } catch {}
                }
            });
        }
    });
} catch {}

// Fallback to 'Weather unavailable' if no data resolves after 6 seconds
setTimeout(() => {
    if (weatherEl && weatherEl.textContent === 'Loading weather...') {
        weatherEl.textContent = 'Weather unavailable';
    }
}, 6000);

// Listen for background service worker weather updates via chrome.storage.onChanged
try {
    chrome.storage.onChanged.addListener((changes, area) => {
        if (area === 'local' && changes.weatherCache?.newValue) {
            weatherEl.innerHTML = changes.weatherCache.newValue;
            try { localStorage.setItem('weatherCache', changes.weatherCache.newValue); } catch {}
        }
    });
} catch {}


// Hardware Telemetry & Info-Panel 3-State Cycle (Streaming 0.5Hz)
const hardwareEl = document.getElementById('hardware');
const panelControlsEl = document.getElementById('panel-controls');
const mouseControlsEl = document.getElementById('mouse-controls');

// =============================================================================
// INDIVIDUAL MONITOR CONFIGURATIONS & FEATURE FLAGS
// Each monitor has its own explicit profile listing all available hardware controls.
// Comment out or remove any feature object below to hide it for that monitor.
// =============================================================================

const MONITOR_CONFIG_PROFILES = {
    // -------------------------------------------------------------------------
    // Profile: Primary Display (Acer)
    // -------------------------------------------------------------------------
    'ACER': {
        name: 'Primary Display',
        features: [
            { key: 'brightness', label: 'Brightness', type: 'number', min: 0, max: 100 },
            { key: 'contrast', label: 'Contrast', type: 'number', min: 0, max: 100 },
            { key: 'blackBoost', label: 'Black Boost', type: 'number', min: 0, max: 100 },
            { key: 'colorPreset', label: 'Color Preset', type: 'select', options: [
                { value: 5, text: '6500K (Standard)' },
                { value: 6, text: '7500K' },
                { value: 8, text: '9300K (Cool)' },
                { value: 11, text: 'User / Custom' }
            ]},
            { key: 'gainR', label: 'Red Gain', type: 'number', min: 0, max: 100, requiresUserMode: true },
            { key: 'gainG', label: 'Green Gain', type: 'number', min: 0, max: 100, requiresUserMode: true },
            { key: 'gainB', label: 'Blue Gain', type: 'number', min: 0, max: 100, requiresUserMode: true },
            { key: 'overdrive', label: 'Overdrive', type: 'select', options: [
                { value: 0, text: 'Off' },
                { value: 1, text: 'Normal' },
                { value: 2, text: 'Extreme' }
            ]},
            { key: 'strobing', label: 'VRB (Strobing)', type: 'select', options: [
                { value: 0, text: 'Off' },
                { value: 1, text: 'Normal' },
                { value: 2, text: 'Extreme' }
            ]},
            { key: 'freeSync', label: 'FreeSync / VRR', type: 'select', options: [
                { value: 0, text: 'Off' },
                { value: 1, text: 'On' }
            ]},
            { key: 'superSharpness', label: 'Super Sharpness', type: 'select', options: [
                { value: 0, text: 'Off' },
                { value: 1, text: 'On' }
            ]},
            { key: 'blueLight', label: 'BlueLight Shield', type: 'select', options: [
                { value: 0, text: 'Off' },
                { value: 1, text: 'Level 1 (50%)' },
                { value: 2, text: 'Level 2 (60%)' },
                { value: 3, text: 'Level 3 (70%)' },
                { value: 4, text: 'Level 4 (80%)' }
            ]},
            { key: 'volume', label: 'Volume', type: 'volume', min: 0, max: 100 },
            { key: 'inputSource', label: 'Input Source', type: 'select', options: [
                { value: 15, text: 'DisplayPort 1' },
                { value: 17, text: 'HDMI 1' },
                { value: 18, text: 'HDMI 2' }
            ]},
            { key: 'powerMode', label: 'Power Mode', type: 'select', options: [
                { value: 1, text: 'On' },
                { value: 4, text: 'Standby' },
                { value: 5, text: 'Power Off' }
            ]}
        ]
    },

    // -------------------------------------------------------------------------
    // Profile: Monitor #3 (Lenovo LOQ 24-10)
    // -------------------------------------------------------------------------
    'LENOVO': {
        name: 'Lenovo LOQ 24-10',
        features: [
            { key: 'brightness', label: 'Brightness', type: 'number', min: 0, max: 100 },
            { key: 'contrast', label: 'Contrast', type: 'number', min: 0, max: 100 },
            { key: 'gamma', label: 'Gamma', type: 'select', options: [
                { value: 20480, text: '1.8' },
                { value: 25600, text: '2.0' },
                { value: 30720, text: '2.2 (Standard)' },
                { value: 35840, text: '2.4' },
                { value: 40960, text: '2.6' }
            ]},
            { key: 'darkBoost', label: 'Dark Boost', type: 'select', options: [
                { value: 0, text: 'Off' },
                { value: 1, text: 'Level 1' },
                { value: 2, text: 'Level 2' },
                { value: 3, text: 'Level 3' },
                { value: 4, text: 'Level 4' },
                { value: 5, text: 'Level 5' },
                { value: 6, text: 'Level 6' },
                { value: 7, text: 'Level 7' }
            ]},
            { key: 'colorPreset', label: 'Color Preset', type: 'select', options: [
                { value: 1, text: 'sRGB' },
                { value: 5, text: '6500K (Standard)' },
                { value: 6, text: '7500K' },
                { value: 8, text: '9300K (Cool)' },
                { value: 11, text: 'User / Custom' }
            ]},
            { key: 'gainR', label: 'Red Gain', type: 'number', min: 0, max: 100, requiresUserMode: true },
            { key: 'gainG', label: 'Green Gain', type: 'number', min: 0, max: 100, requiresUserMode: true },
            { key: 'gainB', label: 'Blue Gain', type: 'number', min: 0, max: 100, requiresUserMode: true },
            { key: 'overdrive', label: 'Over Drive', type: 'select', options: [
                { value: 0, text: 'Off' },
                { value: 3, text: 'Level 1' },
                { value: 4, text: 'Level 2' },
                { value: 5, text: 'Level 3' },
                { value: 6, text: 'Level 4 (Extreme)' }
            ]},
            { key: 'strobing', label: 'MPRT (Strobing)', type: 'select', options: [
                { value: 0, text: 'Off' },
                { value: 1, text: 'On' }
            ]},
            { key: 'freeSync', label: 'Adaptive-Sync', type: 'select', options: [
                { value: 0, text: 'Off' },
                { value: 1, text: 'On' }
            ]},
            { key: 'gameMode', label: 'Game Mode', type: 'select', options: [
                { value: 10, text: 'Standard' },
                { value: 1, text: 'FPS 1' },
                { value: 2, text: 'FPS 2' },
                { value: 3, text: 'Racing' },
                { value: 4, text: 'RTS' },
                { value: 5, text: 'Game 1' },
                { value: 6, text: 'Game 2' }
            ]},
            { key: 'inputSource', label: 'Input Source', type: 'select', options: [
                { value: 15, text: 'DisplayPort 1' },
                { value: 17, text: 'HDMI 1' },
                { value: 18, text: 'HDMI 2' }
            ]},
            { key: 'powerMode', label: 'Power Mode', type: 'select', options: [
                { value: 1, text: 'On' },
                { value: 4, text: 'Standby' },
                { value: 5, text: 'Power Off' }
            ]}
        ]
    }
};

// Fallback profile for any additional display connected
const DEFAULT_MONITOR_FEATURES = [
    { key: 'brightness', label: 'Brightness', type: 'number', min: 0, max: 100 },
    { key: 'contrast', label: 'Contrast', type: 'number', min: 0, max: 100 },
    { key: 'volume', label: 'Volume', type: 'volume', min: 0, max: 100 },
    { key: 'inputSource', label: 'Input Source', type: 'select', options: [
        { value: 15, text: 'DisplayPort 1' },
        { value: 17, text: 'HDMI 1' },
        { value: 18, text: 'HDMI 2' }
    ]},
    { key: 'colorPreset', label: 'Color Preset', type: 'select', options: [
        { value: 5, text: '6500K (Standard)' },
        { value: 6, text: '7500K' },
        { value: 8, text: '9300K (Cool)' },
        { value: 11, text: 'User / Custom' }
    ]},
    { key: 'powerMode', label: 'Power Mode', type: 'select', options: [
        { value: 1, text: 'On' },
        { value: 4, text: 'Standby' },
        { value: 5, text: 'Power Off' }
    ]}
];

const INTERNAL_MONITOR_FEATURES = [
    { key: 'brightness', label: 'Brightness', min: 0, max: 100, type: 'numeric' },
    { key: 'contrast', label: 'Contrast', min: 0, max: 100, type: 'numeric' },
    { key: 'gainR', label: 'Red Gain', min: 0, max: 100, type: 'numeric' },
    { key: 'gainG', label: 'Green Gain', min: 0, max: 100, type: 'numeric' },
    { key: 'gainB', label: 'Blue Gain', min: 0, max: 100, type: 'numeric' }
];

function getFeaturesForMonitor(m) {
    if (!m) return DEFAULT_MONITOR_FEATURES;
    if (m.isInternal) {
        return INTERNAL_MONITOR_FEATURES;
    }
    const name = (m.name || '').toUpperCase();
    const pnp = (m.pnpId || '').toUpperCase();
    if (name.includes('INTERNAL') || pnp.includes('INTERNAL')) {
        return INTERNAL_MONITOR_FEATURES;
    }
    if (name.includes('ACER') || pnp.startsWith('ACR')) {
        return MONITOR_CONFIG_PROFILES['ACER'].features;
    }
    if (name.includes('LENOVO') || pnp.startsWith('LEN')) {
        return MONITOR_CONFIG_PROFILES['LENOVO'].features;
    }
    if (m.id && MONITOR_CONFIG_PROFILES[m.id]) {
        return MONITOR_CONFIG_PROFILES[m.id].features;
    }
    return DEFAULT_MONITOR_FEATURES;
}

const ColorPresetAdapter = {
    normalize(val) {
        const n = Number(val);
        if (n === 12) return 11;
        return isNaN(n) ? 5 : n;
    },
    isUserMode(val) {
        const n = Number(val);
        return n === 11 || n === 12;
    }
};

let infoState = 1; // Default is always State 1: Weather (1: Weather, 2: Empty, 3: Telemetry)
try { localStorage.removeItem('newtab_info_state'); } catch {}

let telemetryPort = null;
let telemetryReconnectTimer = null;
let currentPanelTopologySignature = null;
let latestMonitors = [];
let latestTelemetry = null;
let clientProbeCounter = 0;
let waitingForProbeId = 0;
let probeTimeoutId = null;

// Ephemeral runtime: purge any legacy stored cache keys
try {
    localStorage.removeItem('cached_empirical_monitors');
    localStorage.removeItem('newtab_info_state');
    localStorage.removeItem('atk_mouse_state');
    localStorage.removeItem('mouse_config');
    sessionStorage.removeItem('cached_hardware_telemetry');
    sessionStorage.removeItem('atk_mouse_state');
    chrome.storage?.local?.remove(['cached_empirical_monitors', 'cached_monitors', 'atk_mouse_state', 'mouse_config']);
} catch (e) {}

// Explicit In-Flight Lease Manager to eliminate telemetry race conditions & rubber-banding
class InFlightLeaseManager {
    constructor() {
        this.leases = new Map();
        this.LEASE_DURATION_MS = 3500;
    }

    grant(mid, ctrl, targetValue) {
        const key = `${mid}_${ctrl}`;
        this.leases.set(key, {
            targetValue: Number(targetValue),
            leaseExpiryTimestamp: Date.now() + this.LEASE_DURATION_MS,
            status: 'pending'
        });
    }

    hasActiveLease(mid, ctrl) {
        const key = `${mid}_${ctrl}`;
        const lease = this.leases.get(key);
        if (!lease) return false;
        if (Date.now() > lease.leaseExpiryTimestamp) {
            this.leases.delete(key);
            return false;
        }
        return true;
    }

    reconcileIncoming(mid, ctrl, incomingValue) {
        const key = `${mid}_${ctrl}`;
        const lease = this.leases.get(key);
        const incomingNum = Number(incomingValue);
        if (!lease) {
            return { shouldUpdateUI: true, value: incomingNum };
        }
        const now = Date.now();

        // 1. Hardware confirmed target value
        if (incomingNum === lease.targetValue) {
            this.leases.delete(key);
            return { shouldUpdateUI: true, value: incomingNum, confirmed: true };
        }

        // 2. Hardware has not confirmed yet, but lease is still active -> suppress telemetry bounce
        if (now <= lease.leaseExpiryTimestamp) {
            return { shouldUpdateUI: false, value: lease.targetValue, suppressed: true };
        }

        // 3. Lease expired without hardware confirmation -> rollback to verified hardware state
        this.leases.delete(key);
        return { shouldUpdateUI: true, value: incomingNum, expired: true };
    }

    clear(mid, ctrl) {
        this.leases.delete(`${mid}_${ctrl}`);
    }
}

const leaseManager = new InFlightLeaseManager();

// Wheel Delta Physics Accumulator for smooth trackpads and notched wheels
const wheelAccumulators = new Map();
const WHEEL_PIXEL_THRESHOLD = 36;

function processWheelDelta(key, e) {
    const delta = e.deltaY;
    if (delta === 0) return 0;

    // Standard notched line scroll (mouse wheels)
    if (e.deltaMode === 1) {
        return delta < 0 ? 1 : -1;
    }
    // Page scroll mode
    if (e.deltaMode === 2) {
        return delta < 0 ? 3 : -3;
    }

    // High delta (traditional mouse wheel emitting 100 or 120 pixels per notch)
    if (Math.abs(delta) >= 80) {
        wheelAccumulators.delete(key);
        return delta < 0 ? 1 : -1;
    }

    // Micro-delta pixel mode (precision trackpad or free-spinning precision wheel)
    let accum = (wheelAccumulators.get(key) || 0) + delta;
    let steps = 0;
    if (Math.abs(accum) >= WHEEL_PIXEL_THRESHOLD) {
        steps = -Math.trunc(accum / WHEEL_PIXEL_THRESHOLD);
        accum = accum % WHEEL_PIXEL_THRESHOLD;
    }
    wheelAccumulators.set(key, accum);
    return steps;
}

// Coalescing Dispatch & Debounce Controller
const pendingDispatches = new Map();
const lastDispatchTimes = new Map();

function executeHardwareDispatch(mid, ctrl, numVal) {
    const targetMon = latestMonitors.find(m => m.id === mid || m.pnpId === mid);
    if (targetMon) {
        targetMon[ctrl] = numVal;
    }
    const pnp = targetMon?.pnpId || mid;
    const gdi = targetMon?.gdiDevice;

    const payload = {
        action: 'set_panel_control',
        monitorId: mid,
        pnpId: pnp,
        gdiDevice: gdi,
        control: ctrl,
        value: numVal,
        isInternal: Boolean(targetMon?.isInternal || (typeof mid === 'string' && mid.toLowerCase().includes('internal')) || (gdi && gdi.includes('DISPLAY1')))
    };

    let sent = false;
    if (telemetryPort) {
        try {
            telemetryPort.postMessage(payload);
            sent = true;
        } catch (e) {
            telemetryPort = null;
        }
    }

    if (!sent) {
        try {
            chrome.runtime.sendMessage(payload, () => {
                if (chrome.runtime.lastError) {}
            });
        } catch (e) {}
    }
}

function cancelPendingDispatch(key) {
    const pending = pendingDispatches.get(key);
    if (pending) {
        clearTimeout(pending.timerId);
        pendingDispatches.delete(key);
    }
}

// Leading-Edge Immediate Dispatch with Coalesced Trailing Throttle:
// First user interaction (wheel notch, arrow key) executes immediately with 0ms delay.
// Subsequent continuous rapid inputs are coalesced and rate-limited to throttleMs (~45ms)
// to prevent I2C bus flooding while giving immediate physical responsiveness.
function scheduleThrottledDispatch(mid, ctrl, value, throttleMs = 45) {
    const key = `${mid}_${ctrl}`;
    const numVal = Number(value);

    // Grant optimistic lease immediately to suppress telemetry rubber-banding
    leaseManager.grant(mid, ctrl, numVal);

    const now = Date.now();
    const timeSinceLast = now - (lastDispatchTimes.get(key) || 0);

    // Leading edge: If outside throttle interval and no trailing dispatch pending, fire immediately
    if (timeSinceLast >= throttleMs && !pendingDispatches.has(key)) {
        cancelPendingDispatch(key);
        executeHardwareDispatch(mid, ctrl, numVal);
        lastDispatchTimes.set(key, now);
        return;
    }

    // Trailing coalesce: If already pending, update the coalesced target value
    if (pendingDispatches.has(key)) {
        pendingDispatches.get(key).value = numVal;
    } else {
        const delay = Math.max(0, throttleMs - timeSinceLast);
        const timerId = setTimeout(() => {
            const pending = pendingDispatches.get(key);
            pendingDispatches.delete(key);
            if (pending) {
                executeHardwareDispatch(mid, ctrl, pending.value);
                lastDispatchTimes.set(key, Date.now());
            }
        }, delay);
        pendingDispatches.set(key, { timerId, value: numVal });
    }
}

// Pure Trailing Debounce for raw text input typing (prevents intermediate keystroke thrashing)
function scheduleDebouncedDispatch(mid, ctrl, value, delayMs = 120) {
    const key = `${mid}_${ctrl}`;
    const numVal = Number(value);

    leaseManager.grant(mid, ctrl, numVal);
    cancelPendingDispatch(key);

    const timerId = setTimeout(() => {
        pendingDispatches.delete(key);
        executeHardwareDispatch(mid, ctrl, numVal);
        lastDispatchTimes.set(key, Date.now());
    }, delayMs);

    pendingDispatches.set(key, { timerId, value: numVal });
}

function flushPendingDispatch(mid, ctrl, fallbackValue = null) {
    const key = `${mid}_${ctrl}`;
    const pending = pendingDispatches.get(key);
    cancelPendingDispatch(key);

    let targetVal = fallbackValue !== null ? Number(fallbackValue) : null;
    if (pending) {
        targetVal = pending.value;
    }

    if (targetVal !== null) {
        leaseManager.grant(mid, ctrl, targetVal);
        executeHardwareDispatch(mid, ctrl, targetVal);
        lastDispatchTimes.set(key, Date.now());
        return true;
    }
    return false;
}

const CANONICAL_FEATURE_LABELS = {
    brightness: 'Brightness',
    contrast: 'Contrast',
    colorPreset: 'Color Preset',
    gainR: 'Red Gain',
    gainG: 'Green Gain',
    gainB: 'Blue Gain',
    overdrive: 'Overdrive',
    strobing: 'VRB / MPRT',
    freeSync: 'FreeSync / VRR',
    inputSource: 'Input Source'
};

const ALLOWED_FEATURE_KEYS = [
    'brightness', 'contrast',
    'colorPreset', 'gainR', 'gainG', 'gainB',
    'overdrive', 'strobing', 'freeSync',
    'inputSource'
];

function getUnifiedFeatureList(monitors) {
    if (!Array.isArray(monitors) || monitors.length === 0) return [];

    const featCounts = new Map();
    for (const m of monitors) {
        const feats = getFeaturesForMonitor(m);
        for (const f of feats) {
            featCounts.set(f.key, (featCounts.get(f.key) || 0) + 1);
        }
    }

    const list = [];
    for (const [key, count] of featCounts.entries()) {
        if (key === 'powerMode') continue;
        if (monitors.length > 1 && count < 2) continue;
        list.push(key);
    }

    list.sort((a, b) => {
        const idxA = ALLOWED_FEATURE_KEYS.indexOf(a);
        const idxB = ALLOWED_FEATURE_KEYS.indexOf(b);
        return (idxA >= 0 ? idxA : 999) - (idxB >= 0 ? idxB : 999);
    });
    return list;
}

const panelElementsMap = new Map();
let panelGainRows = [];
let panelGainCells = [];
let lastUserModeKey = '';

function syncRgbGainVisibility(container) {
    const root = container || (panelControlsEl ? (panelControlsEl.querySelector('.panel-controls-grid') || panelControlsEl.querySelector('table')) : null);
    if (!root) return;

    // Detect which monitors currently have User / Custom color preset active via indexed map
    const userModeMonitors = new Set();
    let hasExternalUserMode = false;
    for (let i = 0; i < latestMonitors.length; i++) {
        const m = latestMonitors[i];
        if (!m.isInternal) {
            const sel = panelElementsMap.get(`${m.id}_colorPreset`);
            if (sel && ColorPresetAdapter.isUserMode(sel.value)) {
                userModeMonitors.add(m.id);
                if (m.pnpId) userModeMonitors.add(m.pnpId);
                hasExternalUserMode = true;
            }
        }
    }
    if (hasExternalUserMode) {
        for (let i = 0; i < latestMonitors.length; i++) {
            const m = latestMonitors[i];
            if (m.isInternal) {
                userModeMonitors.add(m.id);
                if (m.pnpId) userModeMonitors.add(m.pnpId);
            }
        }
    }

    // Fast-path guard: avoid DOM reads and writes if active user-mode set is unchanged
    let userModeKey = '';
    for (const mid of userModeMonitors) {
        userModeKey += mid + ';';
    }
    if (userModeKey === lastUserModeKey && root._hasRenderedGains) {
        return;
    }
    lastUserModeKey = userModeKey;
    root._hasRenderedGains = true;

    const anyUserMode = userModeMonitors.size > 0;

    // Smoothly toggle row visibility without DOM destruction
    const gainRows = panelGainRows.length > 0 ? panelGainRows : Array.from(root.querySelectorAll('[data-requires-user-mode="true"]'));
    for (let i = 0; i < gainRows.length; i++) {
        gainRows[i].style.display = anyUserMode ? '' : 'none';
    }

    // Toggle per-monitor cell content: editable input when in user mode, N/A indicator when not
    const gainCells = panelGainCells.length > 0 ? panelGainCells : Array.from(root.querySelectorAll('[data-ctrl="gainR"], [data-ctrl="gainG"], [data-ctrl="gainB"]'));
    for (let i = 0; i < gainCells.length; i++) {
        const cell = gainCells[i];
        if (!cell._mid) {
            cell._mid = cell.getAttribute('data-mid');
            cell._inputWrap = cell.querySelector('.gain-input-wrap');
            cell._naWrap = cell.querySelector('.gain-na-wrap');
        }
        const isUser = userModeMonitors.has(cell._mid);
        if (cell._inputWrap) cell._inputWrap.style.display = isUser ? 'block' : 'none';
        if (cell._naWrap) cell._naWrap.style.display = isUser ? 'none' : 'block';
        if (isUser) {
            cell.classList.remove('panel-cell-na');
            cell.classList.add('panel-cell-numeric');
        } else {
            cell.classList.remove('panel-cell-numeric');
            cell.classList.add('panel-cell-na');
        }
    }
}

function renderPanelControls(monitors) {
    if (!panelControlsEl || !Array.isArray(monitors) || monitors.length === 0) {
        if (panelControlsEl && Array.isArray(monitors) && monitors.length === 0) {
            currentPanelTopologySignature = null;
            panelElementsMap.clear();
            panelGainRows = [];
            panelGainCells = [];
            lastUserModeKey = '';
            panelControlsEl.style.marginTop = '6px';
            panelControlsEl.textContent = 'No DDC/CI compatible monitors detected';
        }
        return;
    }

    panelControlsEl.style.marginTop = '0';

    // Ensure every monitor uses its canonical pnpId as primary identifier (avoid redundant copy if already normalized)
    const normalizedMonitors = (monitors.length > 0 && monitors[0].pnpId && monitors[0].id === monitors[0].pnpId)
        ? monitors
        : monitors.map(m => (m.pnpId && m.id !== m.pnpId ? { ...m, id: m.pnpId } : m));

    // Sort monitors strictly by authoritative windowsDisplayNumber ascending (1, 2, 3...)
    const sortedMonitors = [...normalizedMonitors].sort((a, b) => {
        const numA = (typeof a.windowsDisplayNumber === 'number' && a.windowsDisplayNumber > 0) ? a.windowsDisplayNumber : 999;
        const numB = (typeof b.windowsDisplayNumber === 'number' && b.windowsDisplayNumber > 0) ? b.windowsDisplayNumber : 999;
        if (numA !== numB) return numA - numB;
        return (a.id || '').localeCompare(b.id || '');
    });

    latestMonitors = sortedMonitors;

    // Topology signature is purely based on monitor IDs (stable across preset changes)
    const topologySignature = sortedMonitors.map(m => m.id).join(',');
    const existingGrid = panelControlsEl.querySelector('.panel-controls-grid') || panelControlsEl.querySelector('table');

    // Fine-grained in-place update if grid is already mounted for this topology
    if (existingGrid && currentPanelTopologySignature === topologySignature) {
        for (const m of sortedMonitors) {
            const rawFeats = getFeaturesForMonitor(m);
            for (const f of rawFeats) {
                let el = panelElementsMap.get(`${m.id}_${f.key}`);
                if (!el) {
                    el = existingGrid.querySelector(`[data-mid="${m.id}"][data-ctrl="${f.key}"]`);
                    if (el) panelElementsMap.set(`${m.id}_${f.key}`, el);
                }
                if (!el) continue;

                // Reconcile incoming hardware telemetry via anti-rubber-banding lease manager
                let incomingRaw = m[f.key];
                if (f.key === 'colorPreset') incomingRaw = ColorPresetAdapter.normalize(incomingRaw);

                if (f.type === 'volume') {
                    const isVolNa = (incomingRaw === -1 || incomingRaw === undefined);
                    if (!el._volCell && el.closest) {
                        el._volCell = el.closest('.panel-cell');
                        if (el._volCell) {
                            el._volInputWrap = el._volCell.querySelector('.vol-input-wrap');
                            el._volNaWrap = el._volCell.querySelector('.vol-na-wrap');
                        }
                    }
                    const cell = el._volCell;
                    if (cell) {
                        if (el._volInputWrap) el._volInputWrap.style.display = isVolNa ? 'none' : '';
                        if (el._volNaWrap) el._volNaWrap.style.display = isVolNa ? '' : 'none';
                        if (isVolNa) {
                            cell.classList.remove('panel-cell-numeric');
                            cell.classList.add('panel-cell-na');
                        } else {
                            cell.classList.remove('panel-cell-na');
                            cell.classList.add('panel-cell-numeric');
                        }
                    }
                    if (isVolNa) continue;
                }

                const { shouldUpdateUI, value } = leaseManager.reconcileIncoming(m.id, f.key, incomingRaw);
                if (!shouldUpdateUI) continue;

                // Never overwrite an input element that the user is actively typing into
                if (document.activeElement === el) continue;

                if (el.tagName === 'INPUT') {
                    const strVal = String(value);
                    if (el.value !== strVal) el.value = strVal;
                } else if (el.tagName === 'SELECT') {
                    const numVal = Number(value);
                    if (Number(el.value) !== numVal) {
                        el.value = numVal;
                        if (f.key === 'colorPreset') {
                            syncRgbGainVisibility(existingGrid);
                        }
                    }
                }
            }
        }
        const firstCol = existingGrid.querySelector('.panel-column:first-child');
        if (firstCol && !firstCol.querySelector('#peripheral-dock')) {
            firstCol.insertAdjacentHTML('beforeend', renderPeripheralDockHtml());
            attachPeripheralDockListeners(firstCol);
        } else {
            updatePeripheralDockUI(existingGrid);
        }
        return;
    }

    // Full grid creation (only runs once per hardware topology change)
    currentPanelTopologySignature = topologySignature;

    const numMonitors = sortedMonitors.length;
    const monitorColWidth = 250;
    const tableWidth = numMonitors === 3 ? 750 : (numMonitors * monitorColWidth);

    let html = `<div class="panel-controls-grid" style="display: flex; justify-content: center; width: ${tableWidth}px; margin: 0 auto; border-top: 1px solid rgba(255, 255, 255, 0.12); font-size: 13px; line-height: 1.35; color: #ccc; text-align: left; font-variant-numeric: tabular-nums; white-space: nowrap;">`;

    const seenNewtabNums = new Set();
    for (let mIdx = 0; mIdx < numMonitors; mIdx++) {
        const m = sortedMonitors[mIdx];
        let displayNum = m.windowsDisplayNumber || (mIdx + 1);
        if (seenNewtabNums.has(displayNum)) {
            displayNum = mIdx + 1;
            while (seenNewtabNums.has(displayNum)) displayNum++;
        }
        seenNewtabNums.add(displayNum);

        const rawFeats = getFeaturesForMonitor(m);
        const feats = rawFeats.filter(f => ALLOWED_FEATURE_KEYS.includes(f.key));
        feats.sort((a, b) => {
            const idxA = ALLOWED_FEATURE_KEYS.indexOf(a.key);
            const idxB = ALLOWED_FEATURE_KEYS.indexOf(b.key);
            return (idxA >= 0 ? idxA : 999) - (idxB >= 0 ? idxB : 999);
        });

        html += `<div class="panel-column" style="width: ${monitorColWidth}px; flex: 0 0 ${monitorColWidth}px; box-sizing: border-box;">`;
        html += `<div title="${m.name || ''}" style="padding: 2px 14px 3px 14px; font-weight: normal; color: #fff; overflow: hidden; text-overflow: ellipsis;">#${displayNum}</div>`;

        for (const f of feats) {
            let val = m[f.key];
            if (f.key === 'colorPreset') val = ColorPresetAdapter.normalize(val);

            let controlContent = '';
            let cellClass = 'panel-cell';

            if (f.key === 'gainR' || f.key === 'gainG' || f.key === 'gainB') {
                cellClass += ' panel-cell-numeric';
                controlContent = `
                    <div class="gain-input-wrap">
                        <input type="text" class="panel-input" data-mid="${m.id}" data-ctrl="${f.key}" data-min="${f.min}" data-max="${f.max}" value="${val ?? 50}">
                    </div>
                    <div class="gain-na-wrap" style="display: none;">
                        <span style="color: #666; font-size: 12px; margin-left: 4px;">N/A</span>
                    </div>
                `;
            } else if (f.type === 'volume') {
                const isVolNa = (val === -1 || val === undefined);
                cellClass += isVolNa ? ' panel-cell-na' : ' panel-cell-numeric';
                controlContent = `
                    <div class="vol-input-wrap" style="${isVolNa ? 'display: none;' : ''}">
                        <input type="text" class="panel-input" data-mid="${m.id}" data-ctrl="${f.key}" data-min="${f.min}" data-max="${f.max}" value="${!isVolNa ? val : 50}">
                    </div>
                    <div class="vol-na-wrap" style="${isVolNa ? '' : 'display: none;'}">
                        <span style="color: #666; font-size: 12px; margin-left: 4px;">N/A</span>
                    </div>
                `;
            } else if (f.type === 'select') {
                cellClass += ' panel-cell-select';
                const hasMatch = f.options.some(o => o.value === val);
                const optsHtml = f.options.map(o => `<option value="${o.value}" ${o.value === val ? 'selected' : ''}>${o.text}</option>`).join('');
                const fallbackOpt = !hasMatch && val !== undefined && val !== -1 ? `<option value="${val}" selected>Mode ${val}</option>` : '';
                controlContent = `<select class="panel-select" data-mid="${m.id}" data-ctrl="${f.key}">${optsHtml}${fallbackOpt}</select>`;
            } else {
                cellClass += ' panel-cell-numeric';
                controlContent = `<input type="text" class="panel-input" data-mid="${m.id}" data-ctrl="${f.key}" data-min="${f.min}" data-max="${f.max}" value="${val ?? 50}">`;
            }

            const isUserModeRequired = f.key === 'gainR' || f.key === 'gainG' || f.key === 'gainB';
            const trAttr = isUserModeRequired ? 'data-requires-user-mode="true"' : '';

            html += `
                <div class="${cellClass}" data-mid="${m.id}" data-ctrl="${f.key}" ${trAttr} style="padding: 2px 14px;">
                    <div style="display: flex; justify-content: space-between; align-items: center; width: 100%;">
                        <span style="color: #888; overflow: hidden; text-overflow: ellipsis; padding-right: 8px;">${f.label}</span>
                        <div>${controlContent}</div>
                    </div>
                </div>
            `;
        }

        if (mIdx === 0) {
            html += renderPeripheralDockHtml();
        }

        html += `</div>`;
    }

    html += `</div>`;
    panelControlsEl.innerHTML = html;
    attachPeripheralDockListeners(panelControlsEl);

    const newGrid = panelControlsEl.querySelector('.panel-controls-grid') || panelControlsEl;

    // Index inputs and gain rows in fast-path lookup maps
    panelElementsMap.clear();
    const inputsAndSelects = newGrid.querySelectorAll('.panel-input, .panel-select');
    inputsAndSelects.forEach(el => {
        const mid = el.getAttribute('data-mid');
        const ctrl = el.getAttribute('data-ctrl');
        if (mid && ctrl) {
            panelElementsMap.set(`${mid}_${ctrl}`, el);
        }
    });
    panelGainRows = Array.from(newGrid.querySelectorAll('[data-requires-user-mode="true"]'));
    panelGainCells = Array.from(newGrid.querySelectorAll('[data-ctrl="gainR"], [data-ctrl="gainG"], [data-ctrl="gainB"]'));

    syncRgbGainVisibility(newGrid);
    initPanelControlDelegation();
}

let isPanelDelegationInitialized = false;

function initPanelControlDelegation() {
    if (isPanelDelegationInitialized || !panelControlsEl) return;
    isPanelDelegationInitialized = true;

    // 1. Delegated Wheel Handler: Instant leading-edge scrolling on numeric cells & select dropdowns
    panelControlsEl.addEventListener('wheel', (e) => {
        const cell = e.target.closest('.panel-cell');
        if (!cell || cell.classList.contains('panel-cell-na') || cell.classList.contains('panel-cell-empty')) return;

        const mid = cell.getAttribute('data-mid');
        const ctrl = cell.getAttribute('data-ctrl');
        if (!mid || !ctrl) return;
        const cellKey = `${mid}_${ctrl}`;

        const targetEl = panelElementsMap.get(cellKey);
        const input = (targetEl && targetEl.tagName === 'INPUT') ? targetEl : (targetEl ? null : cell.querySelector('.panel-input'));
        const select = (targetEl && targetEl.tagName === 'SELECT') ? targetEl : (targetEl ? null : cell.querySelector('.panel-select'));
        if (!input && !select) return;

        e.preventDefault();

        const steps = processWheelDelta(cellKey, e);
        if (steps === 0) return;

        if (input) {
            const minVal = Number(input.getAttribute('data-min') !== null ? input.getAttribute('data-min') : 0);
            const maxVal = Number(input.getAttribute('data-max') !== null ? input.getAttribute('data-max') : 100);
            const defaultStep = ctrl === 'brightness' ? 2 : 1;
            const multiplier = e.shiftKey ? (ctrl === 'brightness' ? 10 : 5) : defaultStep;
            const current = Math.max(minVal, Math.min(maxVal, parseInt(input.value, 10) || 0));

            if ((steps > 0 && current >= maxVal) || (steps < 0 && current <= minVal)) {
                input.value = steps > 0 ? maxVal : minVal;
                return;
            }

            const next = Math.max(minVal, Math.min(maxVal, current + (steps * multiplier)));
            input.value = next;
            scheduleThrottledDispatch(mid, ctrl, next, 45);
        } else if (select) {
            if (select.options.length <= 1) return;
            const direction = -steps;
            const nextIdx = Math.max(0, Math.min(select.options.length - 1, select.selectedIndex + direction));
            if (nextIdx !== select.selectedIndex) {
                select.selectedIndex = nextIdx;
                const numVal = Number(select.value);
                if (ctrl === 'colorPreset') {
                    syncRgbGainVisibility(panelControlsEl.querySelector('.panel-controls-grid') || panelControlsEl.querySelector('table'));
                }
                scheduleThrottledDispatch(mid, ctrl, numVal, 45);
            }
        }
    }, { passive: false });

    // 2. Delegated Click Handler: Clicking anywhere in a numeric cell focuses its input
    panelControlsEl.addEventListener('click', (e) => {
        const cell = e.target.closest('.panel-cell');
        if (!cell || cell.classList.contains('panel-cell-na') || cell.classList.contains('panel-cell-empty')) return;
        const mid = cell.getAttribute('data-mid');
        const ctrl = cell.getAttribute('data-ctrl');
        const input = (mid && ctrl) ? panelElementsMap.get(`${mid}_${ctrl}`) : cell.querySelector('.panel-input');
        if (input && input.tagName === 'INPUT' && e.target !== input) {
            input.focus();
            input.select();
        }
    });

    // 3. Delegated Keydown Handler: Arrow keys & Enter on numeric inputs
    panelControlsEl.addEventListener('keydown', (e) => {
        const input = e.target.closest('.panel-input');
        if (!input) return;

        const cell = input.closest('.panel-cell');
        const mid = input.getAttribute('data-mid');
        const ctrl = input.getAttribute('data-ctrl');
        if (!mid || !ctrl) return;

        const minVal = Number(input.getAttribute('data-min') !== null ? input.getAttribute('data-min') : 0);
        const maxVal = Number(input.getAttribute('data-max') !== null ? input.getAttribute('data-max') : 100);

        if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
            e.preventDefault();
            const defaultStep = ctrl === 'brightness' ? 2 : 1;
            const step = e.shiftKey ? (ctrl === 'brightness' ? 10 : 5) : defaultStep;
            const current = Math.max(minVal, Math.min(maxVal, parseInt(input.value, 10) || 0));
            const direction = e.key === 'ArrowUp' ? 1 : -1;

            if ((direction > 0 && current >= maxVal) || (direction < 0 && current <= minVal)) {
                input.value = direction > 0 ? maxVal : minVal;
                return;
            }

            const next = Math.max(minVal, Math.min(maxVal, current + (direction * step)));
            input.value = next;
            scheduleThrottledDispatch(mid, ctrl, next, 45);
        } else if (e.key === 'Enter') {
            input.blur();
        }
    });

    // 4. Delegated Input Handler: Debounced text typing
    panelControlsEl.addEventListener('input', (e) => {
        const input = e.target.closest('.panel-input');
        if (!input) return;

        const mid = input.getAttribute('data-mid');
        const ctrl = input.getAttribute('data-ctrl');
        if (!mid || !ctrl) return;

        const minVal = Number(input.getAttribute('data-min') !== null ? input.getAttribute('data-min') : 0);
        const maxVal = Number(input.getAttribute('data-max') !== null ? input.getAttribute('data-max') : 100);

        const num = parseInt(input.value.replace(/[^0-9]/g, ''), 10);
        if (!isNaN(num)) {
            const clamped = Math.max(minVal, Math.min(maxVal, num));
            scheduleDebouncedDispatch(mid, ctrl, clamped, 120);
        }
    });

    // 5. Delegated Focusout Handler: Flushes pending input immediately on blur
    panelControlsEl.addEventListener('focusout', (e) => {
        const input = e.target.closest('.panel-input');
        if (!input) return;

        const mid = input.getAttribute('data-mid');
        const ctrl = input.getAttribute('data-ctrl');
        if (!mid || !ctrl) return;

        const minVal = Number(input.getAttribute('data-min') !== null ? input.getAttribute('data-min') : 0);
        const maxVal = Number(input.getAttribute('data-max') !== null ? input.getAttribute('data-max') : 100);

        let num = parseInt(input.value.replace(/[^0-9]/g, ''), 10);
        if (isNaN(num)) num = minVal;
        const clamped = Math.max(minVal, Math.min(maxVal, num));
        input.value = clamped;
        flushPendingDispatch(mid, ctrl, clamped);
    });

    // 6. Delegated Change Handler: Dropdown selection change
    panelControlsEl.addEventListener('change', (e) => {
        const select = e.target.closest('.panel-select');
        if (!select) return;

        const mid = select.getAttribute('data-mid');
        const ctrl = select.getAttribute('data-ctrl');
        if (!mid || !ctrl) return;

        const val = Number(select.value);
        if (ctrl === 'colorPreset') {
            syncRgbGainVisibility(panelControlsEl.querySelector('.panel-controls-grid') || panelControlsEl.querySelector('table'));
        }
        flushPendingDispatch(mid, ctrl, val);
    });
}

let telemetryCells = null;
let isStatsSynchronized = false;
let hasMonitorProbeCompleted = false;

function ensureTelemetryTable() {
    if (telemetryCells && hardwareEl && hardwareEl.querySelector('table')) return;
    if (!hardwareEl) return;
    const existingTable = hardwareEl.querySelector('table');
    if (!existingTable) {
        hardwareEl.innerHTML = `
        <table style="table-layout: fixed; width: 750px; margin: 0 auto; border-collapse: collapse; font-size: 13px; line-height: 1.35; color: #ccc; text-align: left; font-variant-numeric: tabular-nums; white-space: nowrap;">
            <colgroup>
                <col style="width: 250px;">
                <col style="width: 250px;">
                <col style="width: 250px;">
            </colgroup>
            <thead>
                <tr style="color: #fff;">
                    <th style="padding: 2px 14px 3px 14px; font-weight: normal;">CPU</th>
                    <th style="padding: 2px 14px 3px 14px; font-weight: normal; border-left: 1px solid rgba(255, 255, 255, 0.12);">GPU</th>
                    <th style="padding: 2px 14px 3px 14px; font-weight: normal; border-left: 1px solid rgba(255, 255, 255, 0.12);">TJMax</th>
                </tr>
            </thead>
            <tbody>
                <tr>
                    <td id="tc-c1" style="padding: 2px 14px; overflow: hidden;">Load: --% &nbsp;|&nbsp; -- MHz</td>
                    <td id="tc-g1" style="padding: 2px 14px; border-left: 1px solid rgba(255, 255, 255, 0.12); overflow: hidden;">Load: --% &nbsp;|&nbsp; Core clk: -- MHz</td>
                    <td id="tc-o1" style="padding: 2px 14px; border-left: 1px solid rgba(255, 255, 255, 0.12); overflow: hidden;">P-State: --</td>
                </tr>
                <tr>
                    <td id="tc-c2" style="padding: 2px 14px; overflow: hidden;">P: -- GHz | E: -- GHz</td>
                    <td id="tc-g2" style="padding: 2px 14px; border-left: 1px solid rgba(255, 255, 255, 0.12); overflow: hidden;">Mem clk: -- MHz &nbsp;|&nbsp; Temp: --&deg;C</td>
                    <td id="tc-o2" style="padding: 2px 14px; border-left: 1px solid rgba(255, 255, 255, 0.12); overflow: hidden;">CPU Throttle: --</td>
                </tr>
                <tr>
                    <td id="tc-c3" style="padding: 2px 14px; overflow: hidden;">PKG: --W &nbsp;|&nbsp; Temp: --&deg;C</td>
                    <td id="tc-g3" style="padding: 2px 14px; border-left: 1px solid rgba(255, 255, 255, 0.12); overflow: hidden;">iGPU: --W (--) &nbsp;|&nbsp; dGPU: --W</td>
                    <td id="tc-o3" style="padding: 2px 14px; border-left: 1px solid rgba(255, 255, 255, 0.12); overflow: hidden;">GPU: -- &nbsp;|&nbsp; VRM: --</td>
                </tr>
                <tr>
                    <td id="tc-c4" style="padding: 2px 14px; overflow: hidden;">RAM: --</td>
                    <td id="tc-g4" style="padding: 2px 14px; border-left: 1px solid rgba(255, 255, 255, 0.12); overflow: hidden;">VRAM: --</td>
                    <td id="tc-o4" style="padding: 2px 14px; border-left: 1px solid rgba(255, 255, 255, 0.12); overflow: hidden;">Page: --</td>
                </tr>
            </tbody>
        </table>
    `;
    }
    telemetryCells = {
        c1: document.getElementById('tc-c1'),
        g1: document.getElementById('tc-g1'),
        o1: document.getElementById('tc-o1'),
        c2: document.getElementById('tc-c2'),
        g2: document.getElementById('tc-g2'),
        o2: document.getElementById('tc-o2'),
        c3: document.getElementById('tc-c3'),
        g3: document.getElementById('tc-g3'),
        o3: document.getElementById('tc-o3'),
        c4: document.getElementById('tc-c4'),
        g4: document.getElementById('tc-g4'),
        o4: document.getElementById('tc-o4')
    };
}

function updateTelemetryCells(response) {
    if (!telemetryCells || !response) return;
    if (response.cpuLoad === undefined || response.cpuClock === undefined) return;

    const cpuLimitVal = response.cpuLimit !== undefined ? Number(response.cpuLimit) : 100;
    const cpuThrottleText = cpuLimitVal < 100 ? `Yes (${cpuLimitVal}%)` : `No (${cpuLimitVal}%)`;
    const isGpuThrottleActive = String(response.hwThermal || '').trim().toLowerCase() === 'active';
    const isVrmActive = String(response.vrmBrake || '').trim().toLowerCase() === 'active';
    const gpuThrottleText = isGpuThrottleActive ? 'Yes' : 'No';
    const vrmThrottleText = isVrmActive ? 'Yes' : 'No';

    const setCell = (cell, text) => {
        if (cell && cell.textContent !== text) {
            cell.textContent = text;
        }
    };

    const formatPower = (val) => (typeof val === 'number' ? val.toFixed(1) : (val ?? '--'));

    setCell(telemetryCells.c1, `Load: ${response.cpuLoad}% \u00A0|\u00A0 ${response.cpuClock} MHz`);
    setCell(telemetryCells.g1, `Load: ${response.gpuLoad}% \u00A0|\u00A0 Core clk: ${response.coreClock} MHz`);
    setCell(telemetryCells.o1, `P-State: ${response.pState || '--'}`);

    setCell(telemetryCells.c2, response.peClock || '--');
    setCell(telemetryCells.g2, `Mem clk: ${response.memClock ?? '--'} MHz \u00A0|\u00A0 Temp: ${response.gpuTemp ?? '--'}°C`);
    setCell(telemetryCells.o2, `CPU Throttle: ${cpuThrottleText}`);

    setCell(telemetryCells.c3, `PKG: ${formatPower(response.cpuPower)}W \u00A0|\u00A0 Temp: ${response.cpuTemp ?? '--'}°C`);
    setCell(telemetryCells.g3, `iGPU: ${formatPower(response.igpuPower)}W (${response.igpuRam || '--'}) \u00A0|\u00A0 dGPU: ${formatPower(response.gpuPower)}W`);
    setCell(telemetryCells.o3, `GPU: ${gpuThrottleText} \u00A0|\u00A0 VRM: ${vrmThrottleText}`);

    setCell(telemetryCells.c4, `RAM: ${response.ramUsed || '--'}`);
    setCell(telemetryCells.g4, `VRAM: ${response.vramUsed || '--'}`);
    setCell(telemetryCells.o4, `Page: ${response.pageUsed || 'N/A'}`);
}

function applyTelemetryData(response) {
    if (!response || response.error) return;

    if (response.cpuLoad !== undefined) {
        latestTelemetry = response;
    } else if (response.monitors) {
        if (latestTelemetry) {
            latestTelemetry = { ...latestTelemetry, ...response };
        } else {
            latestTelemetry = response;
        }
    }

    if (response.hasProbed === true) {
        hasMonitorProbeCompleted = true;
        if (Array.isArray(response.monitors) && response.monitors.length > 0) {
            latestMonitors = response.monitors.map(m => ({
                ...m,
                id: m.pnpId || m.id
            }));
        } else if (Array.isArray(response.monitors) && response.monitors.length === 0) {
            latestMonitors = [];
        }
    } else if (Array.isArray(response.monitors) && response.monitors.length > 0) {
        latestMonitors = response.monitors.map(m => ({
            ...m,
            id: m.pnpId || m.id
        }));
    }

    ensureTelemetryTable();
    if (latestTelemetry && latestTelemetry.cpuLoad !== undefined) {
        updateTelemetryCells(latestTelemetry);
    }
    if (latestMonitors && latestMonitors.length > 0 && panelControlsEl) {
        renderPanelControls(latestMonitors);
    }

    if (infoState === 3) {
        checkAndSynchronizeStatsDisplay();
    }
}

ensureTelemetryTable();

// Instant hydration of empirical telemetry and monitor specs from session storage
try {
    if (chrome.storage?.session) {
        chrome.storage.session.get('latest_telemetry', (res) => {
            if (chrome.runtime.lastError) return;
            if (res?.latest_telemetry) {
                applyTelemetryData(res.latest_telemetry);
            }
        });
        chrome.storage.onChanged.addListener((changes, area) => {
            if (area === 'session' && changes.latest_telemetry?.newValue) {
                applyTelemetryData(changes.latest_telemetry.newValue);
            }
        });
    }
} catch (e) {}

function checkAndSynchronizeStatsDisplay() {
    if (isStatsSynchronized || infoState !== 3) return;
    const isHwReady = Boolean(latestTelemetry && latestTelemetry.cpuLoad !== undefined && latestTelemetry.cpuClock !== undefined);
    const isPanelReady = Boolean(hasMonitorProbeCompleted || (latestMonitors && latestMonitors.length > 0));

    ensureTelemetryTable();

    if (hardwareEl) {
        if (isHwReady && latestTelemetry) {
            updateTelemetryCells(latestTelemetry);
        }
        hardwareEl.style.display = 'block';
    }

    if (panelControlsEl) {
        if (latestMonitors && latestMonitors.length > 0) {
            renderPanelControls(latestMonitors);
            panelControlsEl.style.opacity = '1';
            panelControlsEl.style.display = 'block';
        } else if (hasMonitorProbeCompleted) {
            currentPanelTopologySignature = null;
            panelElementsMap.clear();
            panelGainRows = [];
            panelGainCells = [];
            lastUserModeKey = '';
            panelControlsEl.style.marginTop = '6px';
            panelControlsEl.textContent = 'No DDC/CI compatible monitors detected';
            panelControlsEl.style.opacity = '1';
            panelControlsEl.style.display = 'block';
        } else {
            panelControlsEl.style.display = 'none';
        }
    }

    renderMouseControls();

    if (isHwReady && isPanelReady) {
        isStatsSynchronized = true;
    }
}

function renderTelemetry(response) {
    if (!response || response.error) {
        if (infoState === 3) {
            const msg = (response && response.message) ? response.message : 'Host Offline';
            if (hardwareEl && !hardwareEl.querySelector('table')) {
                hardwareEl.textContent = `Host Offline (${msg})`;
                telemetryCells = null;
            }
            if (panelControlsEl) {
                const hasExistingTable = panelControlsEl.querySelector('.panel-controls-grid') || panelControlsEl.querySelector('table');
                if (!hasExistingTable) {
                    panelControlsEl.textContent = `Host Offline (${msg})`;
                }
            }
        }
        return;
    }

    if (response.cpuLoad !== undefined) {
        latestTelemetry = response;
    } else if (response.monitors) {
        if (latestTelemetry) {
            latestTelemetry = { ...latestTelemetry, ...response };
        } else {
            latestTelemetry = response;
        }
    }

    if (waitingForProbeId > 0) {
        const respProbeId = Number(response.probeId || 0);
        if (respProbeId >= waitingForProbeId && !response.isProbing) {
            waitingForProbeId = 0;
            if (probeTimeoutId) {
                clearTimeout(probeTimeoutId);
                probeTimeoutId = null;
            }
        }
    }

    if (response.hasProbed === true) {
        hasMonitorProbeCompleted = true;
        if (Array.isArray(response.monitors) && response.monitors.length > 0) {
            latestMonitors = response.monitors.map(m => ({
                ...m,
                id: m.pnpId || m.id
            }));
        } else if (Array.isArray(response.monitors) && response.monitors.length === 0) {
            latestMonitors = [];
        }
    } else if (Array.isArray(response.monitors) && response.monitors.length > 0) {
        latestMonitors = response.monitors.map(m => ({
            ...m,
            id: m.pnpId || m.id
        }));
    }

    if (infoState !== 3) return;

    if (!isStatsSynchronized) {
        checkAndSynchronizeStatsDisplay();
        return;
    }

    if (latestMonitors && latestMonitors.length > 0) {
        panelControlsEl.style.display = 'block';
        renderPanelControls(latestMonitors);
    } else if (hasMonitorProbeCompleted && latestMonitors.length === 0) {
        currentPanelTopologySignature = null;
        panelElementsMap.clear();
        panelGainRows = [];
        panelGainCells = [];
        lastUserModeKey = '';
        panelControlsEl.style.marginTop = '6px';
        panelControlsEl.style.display = 'block';
        panelControlsEl.textContent = 'No DDC/CI compatible monitors detected';
    }

    if (!hardwareEl) return;
    ensureTelemetryTable();
    if (!telemetryCells) return;

    if (response.cpuLoad !== undefined && response.cpuClock !== undefined) {
        updateTelemetryCells(response);
    }
}

function requestEmpiricalMonitorProbe() {
    const probeId = ++clientProbeCounter;
    waitingForProbeId = probeId;
    if (probeTimeoutId) {
        clearTimeout(probeTimeoutId);
    }
    probeTimeoutId = setTimeout(() => {
        if (waitingForProbeId === probeId) {
            waitingForProbeId = 0;
            hasMonitorProbeCompleted = true;
            if (panelControlsEl) panelControlsEl.style.opacity = '1';
            checkAndSynchronizeStatsDisplay();
            if (isStatsSynchronized && latestTelemetry && latestTelemetry.monitors && Array.isArray(latestTelemetry.monitors)) {
                renderPanelControls(latestTelemetry.monitors);
            }
        }
        probeTimeoutId = null;
    }, 4000);

    const probeMsg = { action: 'probe_monitors', probeId: probeId };
    if (telemetryPort) {
        try {
            telemetryPort.postMessage(probeMsg);
            return;
        } catch (e) {
            telemetryPort = null;
        }
    }
    try {
        chrome.runtime.sendMessage(probeMsg, () => {
            if (chrome.runtime.lastError) {}
        });
    } catch (e) {}
}

function startTelemetryStream() {
    if (telemetryReconnectTimer) {
        clearTimeout(telemetryReconnectTimer);
        telemetryReconnectTimer = null;
    }
    if (telemetryPort || document.hidden || infoState !== 3) return;

    ensureTelemetryTable();
    if (hardwareEl) {
        hardwareEl.style.display = 'block';
    }

    try {
        telemetryPort = chrome.runtime.connect({ name: 'telemetry' });

        telemetryPort.onMessage.addListener((data) => {
            renderTelemetry(data);
        });

        if (infoState === 3 && !hasMonitorProbeCompleted) {
            requestEmpiricalMonitorProbe();
        }

        telemetryPort.onDisconnect.addListener(() => {
            telemetryPort = null;
            if (infoState === 3 && !document.hidden) {
                if (telemetryReconnectTimer) clearTimeout(telemetryReconnectTimer);
                telemetryReconnectTimer = setTimeout(() => {
                    telemetryReconnectTimer = null;
                    if (infoState === 3 && !document.hidden && !telemetryPort) {
                        startTelemetryStream();
                    }
                }, 1000);
            }
        });
    } catch (e) {
        telemetryPort = null;
        if (infoState === 3) {
            if (hardwareEl && !hardwareEl.querySelector('table')) {
                hardwareEl.textContent = 'Connection Error';
            }
            if (panelControlsEl && (!latestMonitors || latestMonitors.length === 0)) {
                panelControlsEl.style.display = 'none';
            }
        }
    }
}

function stopTelemetryStream() {
    if (telemetryReconnectTimer) {
        clearTimeout(telemetryReconnectTimer);
        telemetryReconnectTimer = null;
    }
    if (probeTimeoutId) {
        clearTimeout(probeTimeoutId);
        probeTimeoutId = null;
    }
    if (telemetryPort) {
        try {
            telemetryPort.disconnect();
        } catch (e) {}
        telemetryPort = null;
    }
}

function setInfoState(state) {
    infoState = state;
    if (infoState !== 3) {
        if (waitingForProbeId > 0) {
            waitingForProbeId = 0;
            if (probeTimeoutId) {
                clearTimeout(probeTimeoutId);
                probeTimeoutId = null;
            }
        }
        if (panelControlsEl) panelControlsEl.style.opacity = '1';
    }
    if (infoState === 1) {
        // State 1: Weather (Default)
        stopTelemetryStream();
        if (weatherEl) {
            weatherEl.style.display = 'block';
            weatherEl.style.visibility = 'visible';
        }
        if (mouseControlsEl) {
            mouseControlsEl.style.display = 'none';
            mouseControlsEl.innerHTML = '';
        }
        if (hardwareEl) hardwareEl.style.display = 'none';
        if (panelControlsEl) panelControlsEl.style.display = 'none';
    } else if (infoState === 2) {
        // State 2: Empty (Show Nothing)
        stopTelemetryStream();
        if (weatherEl) weatherEl.style.display = 'none';
        if (mouseControlsEl) {
            mouseControlsEl.style.display = 'none';
            mouseControlsEl.innerHTML = '';
        }
        if (hardwareEl) hardwareEl.style.display = 'none';
        if (panelControlsEl) panelControlsEl.style.display = 'none';
    } else if (infoState === 3) {
        // State 3: Telemetry (Combined Hardware Telemetry Spec & Monitor Panel Spec)
        if (weatherEl) weatherEl.style.display = 'none';
        if (mouseControlsEl) {
            mouseControlsEl.style.display = 'none';
            mouseControlsEl.innerHTML = '';
        }
        renderMouseControls();
        checkAndQueryAtkMouseOnDemand(false);
        checkAndQueryKeyboardOnDemand(false);

        // Immediate 0ms rendering of cached empirical telemetry and monitor spec
        ensureTelemetryTable();
        if (hardwareEl) {
            if (latestTelemetry && latestTelemetry.cpuLoad !== undefined) {
                updateTelemetryCells(latestTelemetry);
            }
            hardwareEl.style.display = 'block';
        }

        if (panelControlsEl) {
            if (latestMonitors && latestMonitors.length > 0) {
                renderPanelControls(latestMonitors);
                panelControlsEl.style.opacity = '1';
                panelControlsEl.style.display = 'block';
            } else if (hasMonitorProbeCompleted) {
                panelControlsEl.style.marginTop = '6px';
                panelControlsEl.textContent = 'No DDC/CI compatible monitors detected';
                panelControlsEl.style.opacity = '1';
                panelControlsEl.style.display = 'block';
            }
        }

        const isHwReady = Boolean(latestTelemetry && latestTelemetry.cpuLoad !== undefined && latestTelemetry.cpuClock !== undefined);
        const isPanelReady = Boolean(hasMonitorProbeCompleted || (latestMonitors && latestMonitors.length > 0));
        isStatsSynchronized = (isHwReady && isPanelReady);

        if (!telemetryPort) {
            startTelemetryStream();
        } else if (!hasMonitorProbeCompleted) {
            requestEmpiricalMonitorProbe();
        }
    }
}

// Pitch Black Overlay & Telemetry Disable on Logo Right-Click
let isBlackoutActive = false;
let telemetryWasActiveBeforeBlackout = false;
const blackoutOverlayEl = document.getElementById('blackout-overlay');

function triggerBlackout() {
    if (isBlackoutActive) return;
    isBlackoutActive = true;
    telemetryWasActiveBeforeBlackout = (infoState === 3);
    if (telemetryWasActiveBeforeBlackout) {
        setInfoState(2);
    }
    if (blackoutOverlayEl) {
        blackoutOverlayEl.classList.add('active');
    }
    if (document.activeElement && typeof document.activeElement.blur === 'function') {
        document.activeElement.blur();
    }
}

function undoBlackout() {
    if (!isBlackoutActive) return;
    isBlackoutActive = false;
    if (blackoutOverlayEl) {
        blackoutOverlayEl.classList.remove('active');
    }
    if (telemetryWasActiveBeforeBlackout) {
        setInfoState(3);
    }
    telemetryWasActiveBeforeBlackout = false;
}

if (blackoutOverlayEl) {
    blackoutOverlayEl.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        undoBlackout();
    });
    blackoutOverlayEl.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        e.stopPropagation();
        undoBlackout();
    });
}

const logoEl = document.querySelector('.logo');
if (logoEl) {
    logoEl.addEventListener('click', () => {
        if (isBlackoutActive) return;
        const nextState = (infoState % 3) + 1;
        setInfoState(nextState);
    });
}

document.addEventListener('contextmenu', (e) => {
    if (isBlackoutActive) {
        e.preventDefault();
        e.stopPropagation();
        undoBlackout();
        return;
    }
    if (logoEl) {
        const rect = logoEl.getBoundingClientRect();
        const isInsideLogo = (e.target === logoEl) || (
            e.clientX >= rect.left &&
            e.clientX <= rect.right &&
            e.clientY >= rect.top &&
            e.clientY <= rect.bottom
        );
        if (isInsideLogo) {
            e.preventDefault();
            e.stopPropagation();
            triggerBlackout();
        }
    }
}, true);

document.addEventListener('click', (e) => {
    if (isBlackoutActive) {
        e.preventDefault();
        e.stopPropagation();
        undoBlackout();
    }
}, true);

document.addEventListener('keydown', (e) => {
    if (isBlackoutActive && e.key === 'Escape') {
        e.preventDefault();
        undoBlackout();
    }
});

// Pause/disconnect telemetry when tab is hidden or minimized; resume when visible
document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
        stopTelemetryStream();
    } else {
        updateTime();
        if (infoState === 3 && !telemetryPort) {
            startTelemetryStream();
        } else if (infoState === 3) {
            requestEmpiricalMonitorProbe();
        }
    }
});

// Clean up OS pipe on tab close or navigation
window.addEventListener('beforeunload', () => {
    stopTelemetryStream();
});

// =============================================================================
// PERIPHERAL DOCK (LAYOUT 4) & SAFE READ-ONLY WEBHID TELEMETRY
// =============================================================================
let isMouseQuerying = false;
let lastMouseQueryTime = 0;
const ATK_MOUSE_QUERY_COOLDOWN_MS = 10000;
let pairedAtkDevice = null;
let pendingTargetConfig = null;

let isKeyboardQuerying = false;
let lastKeyboardQueryTime = 0;
const KEYBOARD_QUERY_COOLDOWN_MS = 10000;
let pairedKeyboardDevice = null;
const MCHOSE_KEYBOARD_VID = 0x41E4;
const MCHOSE_KEYBOARD_NAMES = {
    0x2101: 'MCHOSE Ace 60'
};

const mouseState = {
    name: null,
    sensor: null,
    config: 0,
    battery: null,
    voltage: null,
    pollingRate: null,
    dpi: null,
    stage: null,
    debounce: null,
    motionSync: null,
    firmware: null,
    connection: null,
    isPaired: false,
    configs: [
        { id: 0, label: 'Config 1' },
        { id: 1, label: 'Config 2' },
        { id: 2, label: 'Config 3' },
        { id: 3, label: 'Config 4' }
    ]
};

const keyboardState = {
    name: 'Keyboard',
    layout: null,
    config: 0,
    battery: null,
    voltage: null,
    pollingRate: null,
    latency: null,
    debounce: null,
    rgbMode: null,
    firmware: null,
    connection: null,
    isPaired: false,
    configs: [
        { id: 0, label: 'Config 1' },
        { id: 1, label: 'Config 2' },
        { id: 2, label: 'Config 3' },
        { id: 3, label: 'Config 4' }
    ]
};

try {
    const savedMouseCfg = localStorage.getItem('atkMouseConfig');
    if (savedMouseCfg !== null) {
        const parsed = parseInt(savedMouseCfg, 10);
        if (!isNaN(parsed) && parsed >= 0 && parsed <= 3) {
            mouseState.config = parsed;
        }
    }
} catch {}

try {
    const savedKbCfg = localStorage.getItem('keyboardConfig');
    if (savedKbCfg !== null) {
        const parsed = parseInt(savedKbCfg, 10);
        if (!isNaN(parsed) && parsed >= 0 && parsed <= 3) {
            keyboardState.config = parsed;
        }
    }
} catch {}

const ATK_MOUSE_NAMES = {
    '1,62': 'ATK F1 V3 ULTIMATE +',
    '1,63': 'ATK F1 V3 ULTIMATE +',
    '1,64': 'ATK F1 V3 ULTIMATE +',
    '1,12': 'ATK F1 Ultra Max 2.0',
    '1,33': 'ATK F1 Ultra Max 2.0',
    '2,36': 'ATK F1 PRO',
    '2,37': 'ATK F1 PRO MAX',
    '2,42': 'ATK F1 Ultimate',
    '2,45': 'ATK F1 Ultra',
    '2,50': 'ATK F1 EXTREME',
    '2,48': 'ATK Dragonfly F1 PRO MAX Elden',
    '2,52': 'ATK Dragonfly F1 PRO MAX JOJO',
    '2,104': 'ATK Dragonfly F1 PRO',
    '2,105': 'ATK Dragonfly F1 PRO MAX',
    '2,5': 'ATK Dragonfly F1 MOBA',
    '2,6': 'ATK Dragonfly F1 MOBA',
    '2,33': 'ATK Dragonfly F1 MOBA',
    '2,106': 'ATK Dragonfly F1 MOBA',
    '2,95': 'DRAGONFLY F1 V2 SE NK',
    '2,93': 'DRAGONFLY F1 V2 Plus NK',
    '2,94': 'DRAGONFLY F1 V2 NK',
    '1,6': 'ATK A9 Ultra Max 2.0',
    '1,15': 'ATK A9 Ultra Max 2.0 Tri-Mode',
    '1,27': 'ATK A9 Mini',
    '1,28': 'ATK A9 Mini'
};

const ATK_SENSOR_MAP = {
    '1,62': 'PAW3955',
    '1,63': 'PAW3955',
    '1,64': 'PAW3955',
    '1,12': 'PAW3950 Ultra',
    '1,33': 'PAW3950 Ultra',
    '2,36': 'PAW3395',
    '2,37': 'PAW3395',
    '2,42': 'PAW3950 Ultra',
    '2,45': 'PAW3950 Ultra',
    '2,50': 'PAW3950 Ultra',
    '2,48': 'PAW3395',
    '2,52': 'PAW3395',
    '2,104': 'PAW3395',
    '2,105': 'PAW3395',
    '2,5': 'PAW3395',
    '2,6': 'PAW3395',
    '2,33': 'PAW3395',
    '2,106': 'PAW3395',
    '2,95': 'PAW3395',
    '2,93': 'PAW3395',
    '2,94': 'PAW3395',
    '1,6': 'PAW3950 Ultra',
    '1,15': 'PAW3950 Ultra',
    '1,27': 'PAW3395',
    '1,28': 'PAW3395'
};

const ATK_RATE_MAP = {
    64: '8000Hz',
    32: '4000Hz',
    16: '2000Hz',
    1: '1000Hz',
    2: '500Hz',
    4: '250Hz',
    8: '125Hz'
};

function calculateAtkChecksum(reportId, data15) {
    let sum = reportId;
    for (let i = 0; i < 15; i++) {
        sum += (data15[i] || 0);
    }
    return (85 - (sum & 0xFF)) & 0xFF;
}

function buildAtkPacket(commandId, address = 0, dataLen = 0, payloadBytes = null) {
    const pkt = new Uint8Array(16);
    pkt[0] = commandId;
    pkt[1] = 0;
    pkt[2] = (address >> 8) & 0xFF;
    pkt[3] = address & 0xFF;
    pkt[4] = dataLen;
    if (payloadBytes && payloadBytes.length > 0) {
        for (let i = 0; i < payloadBytes.length && i < 10; i++) {
            pkt[5 + i] = payloadBytes[i];
        }
    }
    pkt[15] = calculateAtkChecksum(8, pkt);
    return pkt;
}

function sendAtkHidCommand(device, commandId, address = 0, dataLen = 0, payloadBytes = null, timeoutMs = 800) {
    return new Promise((resolve, reject) => {
        if (!device || !device.opened) {
            return reject(new Error('Device not open'));
        }

        let isSettled = false;
        const timer = setTimeout(() => {
            cleanup();
            if (!isSettled) {
                isSettled = true;
                reject(new Error(`Command ${commandId} timeout (${timeoutMs}ms)`));
            }
        }, timeoutMs);

        function onReport(event) {
            if (event.reportId !== 8) return;
            const data = event.data;
            if (!data || data.byteLength < 6) return;
            if (data.getUint8(0) === commandId) {
                cleanup();
                if (!isSettled) {
                    isSettled = true;
                    resolve(data);
                }
            }
        }

        function cleanup() {
            clearTimeout(timer);
            try {
                device.removeEventListener('inputreport', onReport);
            } catch {}
        }

        device.addEventListener('inputreport', onReport);

        const packet = buildAtkPacket(commandId, address, dataLen, payloadBytes);
        device.sendReport(8, packet).catch(err => {
            cleanup();
            if (!isSettled) {
                isSettled = true;
                reject(err);
            }
        });
    });
}

function decodeAtkDpi(xDpi, yDpi, dpiEx, sensor = 'PAW3955') {
    const a = (dpiEx & 12) >> 2;
    const s = (dpiEx & 192) >> 6;
    const o = xDpi | (a << 8);
    const g = yDpi | (s << 8);

    let xVal;
    let yVal;

    const sensorUpper = String(sensor || '').toUpperCase();
    if (sensorUpper.includes('ULTRA')) {
        // PAW3950 Ultra (ya): <= 10000 uses 10 DPI steps; > 10000 uses 50 DPI steps + 10050 base
        const ze = 10050;
        const l = dpiEx & 2;
        const h = dpiEx & 32;
        xVal = l ? (o * 50 + ze) : ((o + 1) * 10);
        yVal = h ? (g * 50 + ze) : ((g + 1) * 10);
        if (dpiEx & 1) xVal *= 2;
        if (dpiEx & 16) yVal *= 2;
    } else if (sensorUpper.includes('CORE26K')) {
        const multX = (dpiEx & 2) ? 100 : 50;
        const multY = (dpiEx & 32) ? 100 : 50;
        xVal = (o + 1) * multX * ((dpiEx & 1) ? 2 : 1);
        yVal = (g + 1) * multY * ((dpiEx & 16) ? 2 : 1);
    } else {
        // PAW3950, PAW3395, PAW3395Ultra, PAW3950DM default (Pa): (o + 1) * 50
        xVal = (o + 1) * 50 * ((dpiEx & 1) ? 2 : 1);
        yVal = (g + 1) * 50 * ((dpiEx & 16) ? 2 : 1);
    }

    if (xVal > 0 && xVal < 50000) {
        if (yVal > 0 && yVal < 50000 && xVal !== yVal) {
            return `${xVal}x${yVal} DPI`;
        }
        return `${xVal} DPI`;
    }
    return '';
}

async function fetchAtkDpi(device, activeStage, sensor) {
    if (!device) return '';
    const isPaw3955 = Boolean(sensor && sensor.includes('3955'));

    // For PAW3955MASTER: EEPROM address 6912 + activeStage * 6 (paw3955Dpi1..8)
    if (isPaw3955) {
        try {
            const dpiAddr = 6912 + activeStage * 6;
            const dpiResp = await sendAtkHidCommand(device, 8, dpiAddr, 6, null, 150);
            if (dpiResp && dpiResp.byteLength >= 11) {
                const t = dpiResp.getUint8(5);
                const a = dpiResp.getUint8(6);
                const s = dpiResp.getUint8(7);
                const o = dpiResp.getUint8(8);
                const g = dpiResp.getUint8(9);
                const m = t | (a << 8);
                const w = s | (o << 8);
                const b = (g & 1) !== 0 ? 2 : 1;
                const D = (g & 16) !== 0 ? 2 : 1;
                const xVal = (m + 1) * b;
                const yVal = (w + 1) * D;
                if (xVal > 0 && xVal < 50000) {
                    if (yVal > 0 && yVal < 50000 && xVal !== yVal) {
                        return `${xVal}x${yVal} DPI`;
                    }
                    return `${xVal} DPI`;
                }
            }
        } catch {}
    }

    // Standard/Classic EEPROM address: 12 + Math.floor(activeStage / 2) * 8
    try {
        const dpiEepromAddr = 12 + Math.floor(activeStage / 2) * 8;
        const dpiResp = await sendAtkHidCommand(device, 8, dpiEepromAddr, 8, null, 150);
        if (dpiResp && dpiResp.byteLength >= 13) {
            const stageOffset = (activeStage % 2) * 4;
            const xDpi = dpiResp.getUint8(5 + stageOffset);
            const yDpi = dpiResp.getUint8(5 + stageOffset + 1);
            const dpiEx = dpiResp.getUint8(5 + stageOffset + 2);
            return decodeAtkDpi(xDpi, yDpi, dpiEx, sensor);
        }
    } catch {}

    return '';
}

function isAtkCommDevice(d) {
    if (!d || (d.vendorId !== 0x373B && d.vendorId !== 14139)) return false;
    if (Array.isArray(d.collections)) {
        for (const col of d.collections) {
            if ((col.usagePage === 0xFF02 || col.usagePage === 65282) && (col.usage === 0x0002 || col.usage === 2)) {
                return true;
            }
        }
    }
    return false;
}

async function getPairedAtkCommDevice() {
    if (typeof navigator === 'undefined' || !navigator.hid) return null;
    try {
        const devices = await navigator.hid.getDevices();
        for (const dev of devices) {
            if (isAtkCommDevice(dev)) {
                return dev;
            }
        }
        return null;
    } catch {
        return null;
    }
}

function isMchoseKeyboardDevice(device) {
    if (!device || device.vendorId !== MCHOSE_KEYBOARD_VID) return false;
    if (Array.isArray(device.collections)) {
        const matchCollection = (cols) => {
            for (const col of cols) {
                if (col.usagePage === 0x0001 && col.usage === 0x0000) {
                    return true;
                }
                if (Array.isArray(col.children) && matchCollection(col.children)) {
                    return true;
                }
            }
            return false;
        };
        return matchCollection(device.collections);
    }
    return false;
}

async function getPairedKeyboardDevice() {
    if (infoState !== 3 || typeof navigator === 'undefined' || !navigator.hid) return null;
    try {
        const devices = await navigator.hid.getDevices();
        for (const dev of devices) {
            if (isMchoseKeyboardDevice(dev)) {
                return dev;
            }
        }
        return null;
    } catch {
        return null;
    }
}

async function queryAtkMouseState(device, force = false) {
    if (!device || isMouseQuerying || (infoState !== 3 && pendingTargetConfig === null)) return;
    const now = Date.now();

    if (!force && (now - lastMouseQueryTime < ATK_MOUSE_QUERY_COOLDOWN_MS) && mouseState.config !== null && mouseState.dpi) {
        renderMouseControls();
        return;
    }

    isMouseQuerying = true;
    try {
        if (!device.opened) {
            await device.open();
        }

        // 1. Active Config (cmd: 14)
        try {
            const cfgResp = await sendAtkHidCommand(device, 14, 0, 0, null, 150);
            if (cfgResp && cfgResp.byteLength >= 6) {
                if (pendingTargetConfig === null) {
                    mouseState.config = cfgResp.getUint8(5);
                    try { localStorage.setItem('atkMouseConfig', String(mouseState.config)); } catch {}
                }
            }
        } catch {}

        // 2. Model & Sensor via CID/MID (cmd: 16)
        try {
            const cidResp = await sendAtkHidCommand(device, 16, 0, 0, null, 150);
            if (cidResp && cidResp.byteLength >= 7) {
                const cid = cidResp.getUint8(5);
                const mid = cidResp.getUint8(6);
                const key = `${cid},${mid}`;
                mouseState.name = ATK_MOUSE_NAMES[key] || device.productName || 'ATK Wireless Mouse';
                mouseState.sensor = ATK_SENSOR_MAP[key] || 'PAW3955';
            }
        } catch {}

        if (!mouseState.name) {
            mouseState.name = device.productName || 'ATK Wireless Mouse';
        }
        if (!mouseState.sensor) {
            mouseState.sensor = 'PAW3955';
        }

        // 3. Battery Level & Voltage (cmd: 4)
        try {
            const batResp = await sendAtkHidCommand(device, 4, 0, 0, null, 150);
            if (batResp && batResp.byteLength >= 6) {
                mouseState.battery = batResp.getUint8(5);
                if (batResp.byteLength >= 9) {
                    const mv = batResp.getUint16(7);
                    if (mv > 2000 && mv < 5000) {
                        mouseState.voltage = (mv / 1000.0).toFixed(2);
                    }
                }
            }
        } catch {}

        // 4. Firmware Version (cmd: 18)
        try {
            const verResp = await sendAtkHidCommand(device, 18, 0, 0, null, 150);
            if (verResp && verResp.byteLength >= 7) {
                const major = verResp.getUint8(5);
                const minor = verResp.getUint8(6);
                mouseState.firmware = `v${major}.${minor.toString(16).padStart(2, '0')}`;
            }
        } catch {}

        // 5. Polling Rate & Active DPI Stage from EEPROM addr 0 (cmd: 8)
        let activeStage = 0;
        try {
            const rateResp = await sendAtkHidCommand(device, 8, 0, 10, null, 150);
            if (rateResp && rateResp.byteLength >= 10) {
                const rateCode = rateResp.getUint8(5);
                mouseState.pollingRate = ATK_RATE_MAP[rateCode] || `${rateCode}Hz`;
                activeStage = rateResp.getUint8(9);
                const maxDpi = rateResp.getUint8(7);
                mouseState.stage = `Stage ${activeStage + 1} / ${maxDpi}`;
            }
        } catch {}

        // 6. Debounce & MotionSync from EEPROM addr 169 (cmd: 8)
        try {
            const debResp = await sendAtkHidCommand(device, 8, 169, 10, null, 150);
            if (debResp && debResp.byteLength >= 8) {
                mouseState.debounce = `${debResp.getUint8(5)}ms`;
                mouseState.motionSync = debResp.getUint8(7) === 1;
            }
        } catch {}

        // 7. Exact DPI for active stage from EEPROM (cmd: 8)
        try {
            const dpiStr = await fetchAtkDpi(device, activeStage, mouseState.sensor);
            if (dpiStr) {
                mouseState.dpi = dpiStr;
            }
        } catch {}

        if (!mouseState.connection) {
            if (device.productName && (device.productName.includes('Dongle') || device.productName.includes('Receiver'))) {
                mouseState.connection = '2.4G Wireless';
            } else if (device.productName && device.productName.includes('Wireless')) {
                mouseState.connection = '2.4G Wireless';
            } else {
                mouseState.connection = 'USB / 2.4G';
            }
        }

        mouseState.isPaired = true;
        lastMouseQueryTime = Date.now();
    } catch (e) {
        console.warn('[CToolkit] Mouse WebHID query failed:', e);
    } finally {
        if (device && device.opened) {
            try { await device.close(); } catch {}
        }
        isMouseQuerying = false;
        renderMouseControls();
    }
}

async function checkAndQueryAtkMouseOnDemand(force = false) {
    if (infoState !== 3 || typeof navigator === 'undefined' || !navigator.hid) return;
    try {
        if (!pairedAtkDevice) {
            pairedAtkDevice = await getPairedAtkCommDevice();
        }
        if (pairedAtkDevice && (!lastMouseQueryTime || force || Date.now() - lastMouseQueryTime > ATK_MOUSE_QUERY_COOLDOWN_MS)) {
            await queryAtkMouseState(pairedAtkDevice, force);
        } else {
            renderMouseControls();
        }
    } catch {
        renderMouseControls();
    }
}

async function requestAtkDevicePairing() {
    if (typeof navigator === 'undefined' || !navigator.hid) {
        return;
    }
    try {
        const selected = await navigator.hid.requestDevice({
            filters: [
                { vendorId: 0x373B, usagePage: 0xFF02, usage: 0x0002 }
            ]
        });
        const matched = selected.find(isAtkCommDevice) || (selected.length > 0 ? selected[0] : null);
        if (matched) {
            pairedAtkDevice = matched;
            await queryAtkMouseState(matched, true);
        }
    } catch (e) {
        console.warn('[CToolkit] WebHID pairing cancelled or failed:', e);
    }
}

async function queryKeyboardState(device, force = false) {
    if (infoState !== 3 || typeof navigator === 'undefined' || !navigator.hid || !device || isKeyboardQuerying) return;
    const now = Date.now();

    if (!force && (now - lastKeyboardQueryTime < KEYBOARD_QUERY_COOLDOWN_MS) && keyboardState.isPaired) {
        updatePeripheralDockUI();
        return;
    }

    isKeyboardQuerying = true;
    try {
        keyboardState.name = MCHOSE_KEYBOARD_NAMES[device.productId] || device.productName || 'MCHOSE Keyboard';
        keyboardState.layout = '60% ANSI (61 Keys)';
        keyboardState.connection = 'USB Wired';
        keyboardState.battery = 'Wired';
        keyboardState.voltage = null;
        keyboardState.isPaired = true;
        lastKeyboardQueryTime = Date.now();
    } finally {
        isKeyboardQuerying = false;
        updatePeripheralDockUI();
    }
}

async function checkAndQueryKeyboardOnDemand(force = false) {
    if (infoState !== 3 || typeof navigator === 'undefined' || !navigator.hid) return;
    try {
        if (!pairedKeyboardDevice) {
            pairedKeyboardDevice = await getPairedKeyboardDevice();
        }
        if (pairedKeyboardDevice && (!lastKeyboardQueryTime || !keyboardState.isPaired || force || Date.now() - lastKeyboardQueryTime >= KEYBOARD_QUERY_COOLDOWN_MS)) {
            await queryKeyboardState(pairedKeyboardDevice, force);
        } else {
            updatePeripheralDockUI();
        }
    } catch {
        updatePeripheralDockUI();
    }
}

async function requestKeyboardDevicePairing() {
    if (infoState !== 3 || typeof navigator === 'undefined' || !navigator.hid) {
        return;
    }
    try {
        const selected = await navigator.hid.requestDevice({
            filters: [
                { vendorId: MCHOSE_KEYBOARD_VID, usagePage: 0x0001, usage: 0x0000 },
                { vendorId: MCHOSE_KEYBOARD_VID }
            ]
        });
        const matched = selected.find(isMchoseKeyboardDevice) || (await getPairedKeyboardDevice()) || (selected.length > 0 ? selected[0] : null);
        if (matched) {
            pairedKeyboardDevice = matched;
            await queryKeyboardState(matched, true);
        }
    } catch (e) {
        console.warn('[CToolkit] Keyboard WebHID pairing cancelled or failed:', e);
    }
}

async function switchAtkConfig(targetConfig) {
    if (typeof targetConfig !== 'number' || isNaN(targetConfig) || targetConfig < 0 || targetConfig > 3) return;

    pendingTargetConfig = targetConfig;
    mouseState.config = targetConfig;
    try { localStorage.setItem('atkMouseConfig', String(targetConfig)); } catch {}
    updatePeripheralDockUI();

    // Await active query completion or timeout to prevent bus collisions
    const startTime = Date.now();
    while (isMouseQuerying) {
        if (Date.now() - startTime > 1200) {
            isMouseQuerying = false;
            break;
        }
        await new Promise(r => setTimeout(r, 30));
        if (pendingTargetConfig !== targetConfig) {
            return;
        }
    }

    isMouseQuerying = true;
    const finalTarget = pendingTargetConfig;
    pendingTargetConfig = null;

    try {
        if (!pairedAtkDevice) {
            pairedAtkDevice = await getPairedAtkCommDevice();
        }
        if (!pairedAtkDevice && typeof navigator !== 'undefined' && navigator.hid?.requestDevice) {
            try {
                const selected = await navigator.hid.requestDevice({
                    filters: [
                        { vendorId: 0x373B, usagePage: 0xFF02, usage: 0x0002 }
                    ]
                });
                const matched = selected.find(isAtkCommDevice) || (selected.length > 0 ? selected[0] : null);
                if (matched) {
                    pairedAtkDevice = matched;
                }
            } catch (e) {
                console.warn('[CToolkit] WebHID pairing cancelled or failed:', e);
            }
        }
        if (!pairedAtkDevice) {
            return;
        }

        await new Promise(r => setTimeout(r, 20));
        if (!pairedAtkDevice.opened) {
            await pairedAtkDevice.open();
        }

        // Send SetCurrentConfig (cmd: 15, addr: 0, len: 1, payload: [finalTarget])
        try {
            await sendAtkHidCommand(pairedAtkDevice, 15, 0, 1, [finalTarget], 400);
        } catch (err) {
            console.warn('[CToolkit] SetCurrentConfig cmd 15 sent:', err);
        }

        // Synchronous read-back verification (cmd: 14)
        try {
            const cfgResp = await sendAtkHidCommand(pairedAtkDevice, 14, 0, 0, null, 250);
            if (cfgResp && cfgResp.byteLength >= 6) {
                mouseState.config = cfgResp.getUint8(5);
            } else {
                mouseState.config = finalTarget;
            }
        } catch {
            mouseState.config = finalTarget;
        }

        // Refresh polling rate, stage & DPI for the newly switched profile (cmd: 8)
        let activeStage = 0;
        try {
            const rateResp = await sendAtkHidCommand(pairedAtkDevice, 8, 0, 10, null, 200);
            if (rateResp && rateResp.byteLength >= 10) {
                const rateCode = rateResp.getUint8(5);
                mouseState.pollingRate = ATK_RATE_MAP[rateCode] || `${rateCode}Hz`;
                activeStage = rateResp.getUint8(9);
                const maxDpi = rateResp.getUint8(7);
                mouseState.stage = `Stage ${activeStage + 1} / ${maxDpi}`;

                const dpiStr = await fetchAtkDpi(pairedAtkDevice, activeStage, mouseState.sensor);
                if (dpiStr) {
                    mouseState.dpi = dpiStr;
                }
            }
        } catch {}

        // Debounce & MotionSync from EEPROM addr 169 (cmd: 8)
        try {
            const debResp = await sendAtkHidCommand(pairedAtkDevice, 8, 169, 10, null, 150);
            if (debResp && debResp.byteLength >= 8) {
                mouseState.debounce = `${debResp.getUint8(5)}ms`;
                mouseState.motionSync = debResp.getUint8(7) === 1;
            }
        } catch {}

        mouseState.isPaired = true;
        lastMouseQueryTime = Date.now();
        try { localStorage.setItem('atkMouseConfig', String(mouseState.config)); } catch {}
    } catch (e) {
        console.warn('[CToolkit] Failed to switch mouse config:', e);
        mouseState.config = finalTarget;
    } finally {
        if (pairedAtkDevice && pairedAtkDevice.opened) {
            try { await pairedAtkDevice.close(); } catch {}
        }
        isMouseQuerying = false;
        updatePeripheralDockUI();
    }
}

function switchKeyboardConfig(targetConfig) {
    if (typeof targetConfig !== 'number' || isNaN(targetConfig) || targetConfig < 0 || targetConfig > 3) return;
    keyboardState.config = targetConfig;
    try {
        localStorage.setItem('keyboardConfig', String(targetConfig));
    } catch {}
    updatePeripheralDockUI();
}

function renderPeripheralDockHtml() {
    let kbBatText = '--%';
    if (keyboardState.isPaired && keyboardState.battery === 'Wired') {
        kbBatText = 'Wired';
    } else if (keyboardState.isPaired && keyboardState.battery !== null) {
        kbBatText = `${keyboardState.battery}%`;
    }
    const msBatText = (mouseState.isPaired && mouseState.battery !== null) ? `${mouseState.battery}%` : '--%';

    const kbConfigsHtml = [0, 1, 2, 3].map(cfgId => {
        const isActive = keyboardState.config === cfgId;
        return `<button type="button" class="peripheral-config-btn${isActive ? ' active' : ''}" data-device="keyboard" data-config-id="${cfgId}">Cfg ${cfgId + 1}</button>`;
    }).join('');

    const msConfigsHtml = [0, 1, 2, 3].map(cfgId => {
        const isActive = mouseState.config === cfgId;
        return `<button type="button" class="peripheral-config-btn${isActive ? ' active' : ''}" data-device="mouse" data-config-id="${cfgId}">Cfg ${cfgId + 1}</button>`;
    }).join('');

    let kbBattDisplay = '--';
    if (keyboardState.isPaired && keyboardState.battery === 'Wired') {
        kbBattDisplay = 'Wired (USB)';
    } else if (keyboardState.isPaired && keyboardState.battery !== null) {
        kbBattDisplay = `${keyboardState.battery}%${keyboardState.voltage ? ` (${keyboardState.voltage}V)` : ''}`;
    }

    const msBattDisplay = (mouseState.isPaired && mouseState.battery !== null)
        ? `${mouseState.battery}%${mouseState.voltage ? ` (${mouseState.voltage}V)` : ''}`
        : '--';

    return `
        <div class="peripheral-dock" id="peripheral-dock">
            <!-- Keyboard Micro-Pill & Popover Island -->
            <div class="peripheral-pill-wrap" data-device="keyboard">
                <button type="button" class="peripheral-micro-pill" id="pill-keyboard" aria-haspopup="dialog" aria-expanded="false" aria-label="Keyboard Settings">
                    <span class="peripheral-pill-tag">KB</span>
                    <span class="peripheral-pill-batt" id="kb-pill-batt">${kbBatText}</span>
                    <span class="peripheral-pill-indicator"></span>
                </button>
                <div class="peripheral-popover" id="keyboard-popover" role="dialog" aria-label="Keyboard Quick Configuration">
                    <div class="peripheral-popover-header">
                        <span class="peripheral-popover-title" id="kb-popover-name">${keyboardState.name || 'Keyboard'}</span>
                        <span class="peripheral-popover-badge" id="kb-popover-badge">${keyboardState.isPaired ? 'Paired' : 'Unpaired'}</span>
                    </div>
                    <div class="peripheral-popover-configs" id="kb-popover-configs">
                        ${kbConfigsHtml}
                    </div>
                    <div class="peripheral-popover-stats">
                        <div class="peripheral-stat-item"><span class="peripheral-stat-lbl">Layout</span><span class="peripheral-stat-val" id="kb-stat-layout">${keyboardState.layout || '--'}</span></div>
                        <div class="peripheral-stat-item"><span class="peripheral-stat-lbl">Rate</span><span class="peripheral-stat-val" id="kb-stat-rate">${keyboardState.pollingRate || '--'}</span></div>
                        <div class="peripheral-stat-item"><span class="peripheral-stat-lbl">Battery</span><span class="peripheral-stat-val" id="kb-stat-batt">${kbBattDisplay}</span></div>
                        <div class="peripheral-stat-item"><span class="peripheral-stat-lbl">Latency</span><span class="peripheral-stat-val" id="kb-stat-latency">${keyboardState.latency || '--'}</span></div>
                        <div class="peripheral-stat-item"><span class="peripheral-stat-lbl">Debounce</span><span class="peripheral-stat-val" id="kb-stat-debounce">${keyboardState.debounce || '--'}</span></div>
                        <div class="peripheral-stat-item"><span class="peripheral-stat-lbl">Firmware</span><span class="peripheral-stat-val" id="kb-stat-firmware">${keyboardState.firmware || '--'}</span></div>
                        <div class="peripheral-stat-item"><span class="peripheral-stat-lbl">Link</span><span class="peripheral-stat-val" id="kb-stat-link">${keyboardState.connection || '--'}</span></div>
                        <div class="peripheral-stat-item"><span class="peripheral-stat-lbl">RGB</span><span class="peripheral-stat-val" id="kb-stat-rgb">${keyboardState.rgbMode || '--'}</span></div>
                    </div>
                </div>
            </div>

            <!-- Mouse Micro-Pill & Popover Island -->
            <div class="peripheral-pill-wrap" data-device="mouse">
                <button type="button" class="peripheral-micro-pill" id="pill-mouse" aria-haspopup="dialog" aria-expanded="false" aria-label="Mouse Settings">
                    <span class="peripheral-pill-tag">MS</span>
                    <span class="peripheral-pill-batt" id="mouse-pill-batt">${msBatText}</span>
                    <span class="peripheral-pill-indicator"></span>
                </button>
                <div class="peripheral-popover" id="mouse-popover" role="dialog" aria-label="Mouse Quick Configuration">
                    <div class="peripheral-popover-header">
                        <span class="peripheral-popover-title" id="mouse-popover-name">${mouseState.name || (mouseState.isPaired ? 'ATK Mouse' : 'Mouse')}</span>
                        <span class="peripheral-popover-badge" id="mouse-popover-badge">${mouseState.isPaired ? 'Paired' : 'Unpaired'}</span>
                    </div>
                    <div class="peripheral-popover-configs" id="mouse-popover-configs">
                        ${msConfigsHtml}
                    </div>
                    <div class="peripheral-popover-stats">
                        <div class="peripheral-stat-item"><span class="peripheral-stat-lbl">DPI</span><span class="peripheral-stat-val" id="mouse-stat-dpi">${mouseState.dpi || '--'}</span></div>
                        <div class="peripheral-stat-item"><span class="peripheral-stat-lbl">Rate</span><span class="peripheral-stat-val" id="mouse-stat-rate">${mouseState.pollingRate || '--'}</span></div>
                        <div class="peripheral-stat-item"><span class="peripheral-stat-lbl">Battery</span><span class="peripheral-stat-val" id="mouse-stat-batt">${msBattDisplay}</span></div>
                        <div class="peripheral-stat-item"><span class="peripheral-stat-lbl">Sensor</span><span class="peripheral-stat-val" id="mouse-stat-sensor">${mouseState.sensor || '--'}</span></div>
                        <div class="peripheral-stat-item"><span class="peripheral-stat-lbl">Stage</span><span class="peripheral-stat-val" id="mouse-stat-stage">${mouseState.stage || '--'}</span></div>
                        <div class="peripheral-stat-item"><span class="peripheral-stat-lbl">Debounce</span><span class="peripheral-stat-val" id="mouse-stat-debounce">${mouseState.debounce || '--'}</span></div>
                        <div class="peripheral-stat-item"><span class="peripheral-stat-lbl">MotionSync</span><span class="peripheral-stat-val" id="mouse-stat-motionsync">${mouseState.motionSync !== null ? (mouseState.motionSync ? 'On' : 'Off') : '--'}</span></div>
                        <div class="peripheral-stat-item"><span class="peripheral-stat-lbl">Firmware</span><span class="peripheral-stat-val" id="mouse-stat-firmware">${mouseState.firmware || '--'}</span></div>
                        <div class="peripheral-stat-item"><span class="peripheral-stat-lbl">Link</span><span class="peripheral-stat-val" id="mouse-stat-link">${mouseState.connection || '--'}</span></div>
                    </div>
                </div>
            </div>
        </div>
    `;
}

function updatePeripheralDockUI(container = document) {
    const dockEl = (container && container.id === 'peripheral-dock')
        ? container
        : ((container && container.querySelector && container.querySelector('#peripheral-dock'))
        || (container && container.closest && container.closest('#peripheral-dock'))
        || document.querySelector('#peripheral-dock'));
    if (!dockEl) return;

    // Update Keyboard pill & popover
    const kbPillBatt = dockEl.querySelector('#kb-pill-batt');
    if (kbPillBatt) {
        if (keyboardState.isPaired && keyboardState.battery === 'Wired') {
            kbPillBatt.textContent = 'Wired';
        } else if (keyboardState.isPaired && keyboardState.battery !== null) {
            kbPillBatt.textContent = `${keyboardState.battery}%`;
        } else {
            kbPillBatt.textContent = '--%';
        }
    }
    const kbNameEl = dockEl.querySelector('#kb-popover-name');
    if (kbNameEl) kbNameEl.textContent = keyboardState.name || 'Keyboard';
    const kbBadgeEl = dockEl.querySelector('#kb-popover-badge');
    if (kbBadgeEl) kbBadgeEl.textContent = keyboardState.isPaired ? 'Paired' : 'Unpaired';

    const kbBtns = dockEl.querySelectorAll('#kb-popover-configs .peripheral-config-btn');
    kbBtns.forEach(btn => {
        const cfgId = parseInt(btn.getAttribute('data-config-id'), 10);
        if (cfgId === keyboardState.config) {
            btn.classList.add('active');
        } else {
            btn.classList.remove('active');
        }
    });

    const kbStatLayout = dockEl.querySelector('#kb-stat-layout');
    if (kbStatLayout) kbStatLayout.textContent = keyboardState.layout || '--';
    const kbStatRate = dockEl.querySelector('#kb-stat-rate');
    if (kbStatRate) kbStatRate.textContent = keyboardState.pollingRate || '--';
    const kbStatBatt = dockEl.querySelector('#kb-stat-batt');
    if (kbStatBatt) {
        if (keyboardState.isPaired && keyboardState.battery === 'Wired') {
            kbStatBatt.textContent = 'Wired (USB)';
        } else if (keyboardState.isPaired && keyboardState.battery !== null) {
            kbStatBatt.textContent = `${keyboardState.battery}%${keyboardState.voltage ? ` (${keyboardState.voltage}V)` : ''}`;
        } else {
            kbStatBatt.textContent = '--';
        }
    }
    const kbStatLatency = dockEl.querySelector('#kb-stat-latency');
    if (kbStatLatency) kbStatLatency.textContent = keyboardState.latency || '--';
    const kbStatDebounce = dockEl.querySelector('#kb-stat-debounce');
    if (kbStatDebounce) kbStatDebounce.textContent = keyboardState.debounce || '--';
    const kbStatFirmware = dockEl.querySelector('#kb-stat-firmware');
    if (kbStatFirmware) kbStatFirmware.textContent = keyboardState.firmware || '--';
    const kbStatLink = dockEl.querySelector('#kb-stat-link');
    if (kbStatLink) kbStatLink.textContent = keyboardState.connection || '--';
    const kbStatRgb = dockEl.querySelector('#kb-stat-rgb');
    if (kbStatRgb) kbStatRgb.textContent = keyboardState.rgbMode || '--';

    // Update Mouse pill & popover
    const mousePillBatt = dockEl.querySelector('#mouse-pill-batt');
    if (mousePillBatt) {
        mousePillBatt.textContent = (mouseState.isPaired && mouseState.battery !== null) ? `${mouseState.battery}%` : '--%';
    }
    const mouseNameEl = dockEl.querySelector('#mouse-popover-name');
    if (mouseNameEl) mouseNameEl.textContent = mouseState.name || (mouseState.isPaired ? 'ATK Mouse' : 'Mouse');
    const mouseBadgeEl = dockEl.querySelector('#mouse-popover-badge');
    if (mouseBadgeEl) mouseBadgeEl.textContent = mouseState.isPaired ? 'Paired' : 'Unpaired';

    const mouseBtns = dockEl.querySelectorAll('#mouse-popover-configs .peripheral-config-btn');
    mouseBtns.forEach(btn => {
        const cfgId = parseInt(btn.getAttribute('data-config-id'), 10);
        if (cfgId === mouseState.config) {
            btn.classList.add('active');
        } else {
            btn.classList.remove('active');
        }
    });

    const mouseStatDpi = dockEl.querySelector('#mouse-stat-dpi');
    if (mouseStatDpi) mouseStatDpi.textContent = mouseState.dpi || '--';
    const mouseStatRate = dockEl.querySelector('#mouse-stat-rate');
    if (mouseStatRate) mouseStatRate.textContent = mouseState.pollingRate || '--';
    const mouseStatBatt = dockEl.querySelector('#mouse-stat-batt');
    if (mouseStatBatt) {
        mouseStatBatt.textContent = (mouseState.isPaired && mouseState.battery !== null)
            ? `${mouseState.battery}%${mouseState.voltage ? ` (${mouseState.voltage}V)` : ''}`
            : '--';
    }
    const mouseStatSensor = dockEl.querySelector('#mouse-stat-sensor');
    if (mouseStatSensor) mouseStatSensor.textContent = mouseState.sensor || '--';
    const mouseStatStage = dockEl.querySelector('#mouse-stat-stage');
    if (mouseStatStage) mouseStatStage.textContent = mouseState.stage || '--';
    const mouseStatDebounce = dockEl.querySelector('#mouse-stat-debounce');
    if (mouseStatDebounce) mouseStatDebounce.textContent = mouseState.debounce || '--';
    const mouseStatMotionSync = dockEl.querySelector('#mouse-stat-motionsync');
    if (mouseStatMotionSync) mouseStatMotionSync.textContent = mouseState.motionSync !== null ? (mouseState.motionSync ? 'On' : 'Off') : '--';
    const mouseStatFirmware = dockEl.querySelector('#mouse-stat-firmware');
    if (mouseStatFirmware) mouseStatFirmware.textContent = mouseState.firmware || '--';
    const mouseStatLink = dockEl.querySelector('#mouse-stat-link');
    if (mouseStatLink) mouseStatLink.textContent = mouseState.connection || '--';
}

function attachPeripheralDockListeners(container = document) {
    const dockEl = (container && container.id === 'peripheral-dock')
        ? container
        : ((container && container.querySelector && container.querySelector('#peripheral-dock'))
        || (container && container.closest && container.closest('#peripheral-dock'))
        || document.querySelector('#peripheral-dock'));
    if (!dockEl) return;

    const btns = dockEl.querySelectorAll('.peripheral-config-btn');
    btns.forEach(btn => {
        btn.onclick = (e) => {
            e.preventDefault();
            e.stopPropagation();
            const device = btn.getAttribute('data-device');
            const cfgId = parseInt(btn.getAttribute('data-config-id'), 10);
            if (!isNaN(cfgId)) {
                if (device === 'keyboard') {
                    switchKeyboardConfig(cfgId);
                } else if (device === 'mouse') {
                    switchAtkConfig(cfgId);
                }
            }
        };
    });

    const kbWrap = dockEl.querySelector('.peripheral-pill-wrap[data-device="keyboard"]');
    if (kbWrap) {
        kbWrap.onmouseenter = () => {
            if (!keyboardState.isPaired || Date.now() - lastKeyboardQueryTime >= KEYBOARD_QUERY_COOLDOWN_MS) {
                checkAndQueryKeyboardOnDemand(false);
            }
        };
    }

    const pillKeyboard = dockEl.querySelector('#pill-keyboard');
    if (pillKeyboard) {
        pillKeyboard.onclick = (e) => {
            e.preventDefault();
            if (!pairedKeyboardDevice || !keyboardState.isPaired) {
                requestKeyboardDevicePairing();
            } else {
                checkAndQueryKeyboardOnDemand(true);
            }
        };
    }

    const badgeKeyboard = dockEl.querySelector('#kb-popover-badge');
    if (badgeKeyboard) {
        badgeKeyboard.style.cursor = 'pointer';
        badgeKeyboard.onclick = (e) => {
            e.preventDefault();
            e.stopPropagation();
            if (!pairedKeyboardDevice || !keyboardState.isPaired) {
                requestKeyboardDevicePairing();
            } else {
                checkAndQueryKeyboardOnDemand(true);
            }
        };
    }

    const mouseWrap = dockEl.querySelector('.peripheral-pill-wrap[data-device="mouse"]');
    if (mouseWrap) {
        mouseWrap.onmouseenter = () => {
            if (!mouseState.isPaired || Date.now() - lastMouseQueryTime >= ATK_MOUSE_QUERY_COOLDOWN_MS) {
                checkAndQueryAtkMouseOnDemand(false);
            }
        };
    }

    const pillMouse = dockEl.querySelector('#pill-mouse');
    if (pillMouse) {
        pillMouse.onclick = (e) => {
            e.preventDefault();
            if (!pairedAtkDevice || !mouseState.isPaired) {
                requestAtkDevicePairing();
            } else {
                checkAndQueryAtkMouseOnDemand(true);
            }
        };
    }

    const badgeMouse = dockEl.querySelector('#mouse-popover-badge');
    if (badgeMouse) {
        badgeMouse.style.cursor = 'pointer';
        badgeMouse.onclick = (e) => {
            e.preventDefault();
            e.stopPropagation();
            if (!pairedAtkDevice || !mouseState.isPaired) {
                requestAtkDevicePairing();
            } else {
                checkAndQueryAtkMouseOnDemand(true);
            }
        };
    }
}

function renderMouseControls() {
    if (mouseControlsEl) {
        mouseControlsEl.style.display = 'none';
        mouseControlsEl.innerHTML = '';
    }
    updatePeripheralDockUI();
}

async function initAtkWebHid() {
    if (infoState !== 3 || typeof navigator === 'undefined' || !navigator.hid) return;
    try {
        pairedAtkDevice = await getPairedAtkCommDevice();
        if (pairedAtkDevice) {
            await queryAtkMouseState(pairedAtkDevice, true);
        } else {
            updatePeripheralDockUI();
        }
    } catch {
        updatePeripheralDockUI();
    }
}

async function initKeyboardWebHid() {
    if (infoState !== 3 || typeof navigator === 'undefined' || !navigator.hid) return;
    try {
        pairedKeyboardDevice = await getPairedKeyboardDevice();
        if (pairedKeyboardDevice) {
            await queryKeyboardState(pairedKeyboardDevice, true);
        } else {
            updatePeripheralDockUI();
        }
    } catch {
        updatePeripheralDockUI();
    }
}

if (typeof navigator !== 'undefined' && navigator.hid) {
    navigator.hid.addEventListener('connect', async (event) => {
        if (isAtkCommDevice(event.device)) {
            pairedAtkDevice = event.device;
            if (infoState === 3) {
                checkAndQueryAtkMouseOnDemand(true);
            } else {
                updatePeripheralDockUI();
            }
        }
        if (isMchoseKeyboardDevice(event.device)) {
            pairedKeyboardDevice = event.device;
            if (infoState === 3) {
                checkAndQueryKeyboardOnDemand(true);
            } else {
                updatePeripheralDockUI();
            }
        }
    });
    navigator.hid.addEventListener('disconnect', (event) => {
        if ((pairedAtkDevice && event.device === pairedAtkDevice) || isAtkCommDevice(event.device)) {
            pairedAtkDevice = null;
            mouseState.isPaired = false;
            mouseState.name = null;
            mouseState.sensor = null;
            mouseState.battery = null;
            mouseState.voltage = null;
            mouseState.pollingRate = null;
            mouseState.dpi = null;
            mouseState.stage = null;
            mouseState.debounce = null;
            mouseState.motionSync = null;
            mouseState.firmware = null;
            mouseState.connection = null;
            lastMouseQueryTime = 0;
            updatePeripheralDockUI();
        }
        if ((pairedKeyboardDevice && event.device === pairedKeyboardDevice) || isMchoseKeyboardDevice(event.device)) {
            pairedKeyboardDevice = null;
            keyboardState.isPaired = false;
            keyboardState.name = 'Keyboard';
            keyboardState.layout = null;
            keyboardState.connection = null;
            keyboardState.battery = null;
            keyboardState.voltage = null;
            keyboardState.pollingRate = null;
            keyboardState.latency = null;
            keyboardState.debounce = null;
            keyboardState.firmware = null;
            keyboardState.rgbMode = null;
            lastKeyboardQueryTime = 0;
            updatePeripheralDockUI();
        }
    });
}

initAtkWebHid();
initKeyboardWebHid();

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg.action === 'read_clipboard') {
        const fallbackExec = () => {
            let text = '';
            try {
                const textarea = document.createElement('textarea');
                document.body.appendChild(textarea);
                textarea.focus();
                document.execCommand('paste');
                text = textarea.value;
                textarea.remove();
            } catch {}
            return text;
        };

        if (navigator.clipboard?.readText) {
            navigator.clipboard.readText()
                .then(text => sendResponse(text || fallbackExec()))
                .catch(() => sendResponse(fallbackExec()));
            return true;
        }

        sendResponse(fallbackExec());
        return false;
    }
});

})();
