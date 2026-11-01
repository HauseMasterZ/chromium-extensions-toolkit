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


// Hardware Telemetry & Info-Panel 4-State Cycle (Streaming 0.5Hz)
const hardwareEl = document.getElementById('hardware');
const panelControlsEl = document.getElementById('panel-controls');

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
    // Profile: Secondary Display (Lenovo)
    // -------------------------------------------------------------------------
    'LENOVO': {
        name: 'Secondary Display',
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
                { value: 4, text: 'Level 4' }
            ]},
            { key: 'blackLevel', label: 'Black Level', type: 'number', min: 0, max: 100 },
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
            { key: 'overdrive', label: 'Response Time', type: 'select', options: [
                { value: 0, text: 'Off' },
                { value: 3, text: 'Level 1' },
                { value: 4, text: 'Level 2' },
                { value: 5, text: 'Level 3' },
                { value: 6, text: 'Extreme' }
            ]},
            { key: 'mprt', label: 'MPRT (Strobing)', type: 'select', options: [
                { value: 0, text: 'Off' },
                { value: 1, text: 'On' }
            ]},
            { key: 'freeSync', label: 'Adaptive-Sync', type: 'select', options: [
                { value: 0, text: 'Off' },
                { value: 1, text: 'On' }
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

let infoState = 1; // 1: Weather (Default), 2: Panel Controls, 3: Empty, 4: Sensors
let telemetryPort = null;
let telemetryReconnectTimer = null;
let currentPanelTopologySignature = null;
let latestMonitors = [];
let clientProbeCounter = 0;
let waitingForProbeId = 0;
let probeTimeoutId = null;

// Clean up any legacy persistent monitor cache entries to ensure strictly empirical telemetry
try {
    localStorage.removeItem('lastDetectedMonitors');
    localStorage.removeItem('panelControlsCache');
} catch (e) {}

// Pre-hydrate in-memory latest telemetry from active browser session if available
try {
    if (chrome.storage && chrome.storage.session) {
        chrome.storage.session.get(['latest_telemetry'], (res) => {
            if (res && res.latest_telemetry && !latestTelemetry) {
                latestTelemetry = res.latest_telemetry;
                if (infoState === 4 && hardwareEl) {
                    ensureTelemetryTable();
                    renderTelemetry(latestTelemetry);
                } else if (infoState === 2 && res.latest_telemetry.monitors) {
                    latestMonitors = res.latest_telemetry.monitors;
                    renderPanelControls(latestMonitors);
                }
            }
        });
    }
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
    const pnp = targetMon?.pnpId || mid;
    const gdi = targetMon?.gdiDevice;

    const payload = {
        action: 'set_panel_control',
        monitorId: mid,
        pnpId: pnp,
        gdiDevice: gdi,
        control: ctrl,
        value: numVal
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

function getUnifiedFeatureList(monitors) {
    const seen = new Set();
    const list = [];
    for (const m of monitors) {
        const feats = getFeaturesForMonitor(m);
        for (const f of feats) {
            if (!seen.has(f.key)) {
                seen.add(f.key);
                list.push(f.key);
            }
        }
    }
    const priority = [
        'brightness', 'contrast', 'gamma', 'darkBoost', 'blackBoost', 'blackLevel',
        'colorPreset', 'gainR', 'gainG', 'gainB',
        'overdrive', 'strobing', 'mprt', 'freeSync',
        'superSharpness', 'blueLight',
        'volume', 'inputSource', 'powerMode'
    ];
    list.sort((a, b) => {
        const idxA = priority.indexOf(a);
        const idxB = priority.indexOf(b);
        return (idxA >= 0 ? idxA : 999) - (idxB >= 0 ? idxB : 999);
    });
    return list;
}

const panelElementsMap = new Map();
let panelGainRows = [];
let panelGainCells = [];
let lastUserModeKey = '';

function syncRgbGainVisibility(table) {
    const tbl = table || (panelControlsEl ? panelControlsEl.querySelector('table') : null);
    if (!tbl) return;

    // Detect which monitors currently have User / Custom color preset active via indexed map
    const userModeMonitors = new Set();
    for (let i = 0; i < latestMonitors.length; i++) {
        const m = latestMonitors[i];
        if (m.isInternal) {
            userModeMonitors.add(m.id);
            if (m.pnpId) userModeMonitors.add(m.pnpId);
        } else {
            const sel = panelElementsMap.get(`${m.id}_colorPreset`);
            if (sel && ColorPresetAdapter.isUserMode(sel.value)) {
                userModeMonitors.add(m.id);
            }
        }
    }

    // Fast-path guard: avoid DOM reads and writes if active user-mode set is unchanged
    let userModeKey = '';
    for (const mid of userModeMonitors) {
        userModeKey += mid + ';';
    }
    if (userModeKey === lastUserModeKey && tbl._hasRenderedGains) {
        return;
    }
    lastUserModeKey = userModeKey;
    tbl._hasRenderedGains = true;

    const anyUserMode = userModeMonitors.size > 0;

    // Smoothly toggle table row visibility without DOM destruction
    const gainRows = panelGainRows.length > 0 ? panelGainRows : Array.from(tbl.querySelectorAll('tr[data-requires-user-mode="true"]'));
    for (let i = 0; i < gainRows.length; i++) {
        gainRows[i].style.display = anyUserMode ? '' : 'none';
    }

    // Toggle per-monitor cell content: editable input when in user mode, N/A indicator when not
    const gainCells = panelGainCells.length > 0 ? panelGainCells : Array.from(tbl.querySelectorAll('td[data-ctrl="gainR"], td[data-ctrl="gainG"], td[data-ctrl="gainB"]'));
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
            panelControlsEl.textContent = 'No DDC/CI compatible monitors detected';
        }
        return;
    }

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
    const existingTable = panelControlsEl.querySelector('table');

    // Fine-grained in-place update if table is already mounted for this topology
    if (existingTable && currentPanelTopologySignature === topologySignature) {
        for (const m of sortedMonitors) {
            const rawFeats = getFeaturesForMonitor(m);
            for (const f of rawFeats) {
                let el = panelElementsMap.get(`${m.id}_${f.key}`);
                if (!el) {
                    el = existingTable.querySelector(`[data-mid="${m.id}"][data-ctrl="${f.key}"]`);
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
                            syncRgbGainVisibility(existingTable);
                        }
                    }
                }
            }
        }
        return;
    }

    // Full table creation (only runs once per hardware topology change)
    currentPanelTopologySignature = topologySignature;

    const numMonitors = sortedMonitors.length;
    const monitorWidth = Math.floor(750 / numMonitors);
    const unifiedFeatureKeys = getUnifiedFeatureList(sortedMonitors);

    let html = `
        <table style="table-layout: fixed; width: 750px; margin: 6px auto 0 auto; border-collapse: collapse; font-size: 13px; line-height: 1.6; color: #ccc; text-align: left; font-variant-numeric: tabular-nums; white-space: nowrap;">
            <colgroup>
                ${sortedMonitors.map(() => `<col style="width: ${monitorWidth}px;">`).join('')}
            </colgroup>
            <thead>
                <tr style="color: #fff;">
                    ${sortedMonitors.map((m, mIdx) => {
                        const displayNum = m.windowsDisplayNumber || (mIdx + 1);
                        return `<th title="${m.name || ''}" style="padding: 2px 14px 4px 14px; font-weight: normal; ${mIdx > 0 ? 'border-left: 1px solid rgba(255, 255, 255, 0.12);' : ''} overflow: hidden; text-overflow: ellipsis;">#${displayNum}</th>`;
                    }).join('')}
                </tr>
            </thead>
            <tbody>
    `;

    for (const featKey of unifiedFeatureKeys) {
        // Determine if any monitor profile requires user mode for this feature
        const isUserModeRequired = featKey === 'gainR' || featKey === 'gainG' || featKey === 'gainB';
        const trAttr = isUserModeRequired ? 'data-requires-user-mode="true"' : '';

        html += `<tr ${trAttr}>`;
        for (let mIdx = 0; mIdx < numMonitors; mIdx++) {
            const m = sortedMonitors[mIdx];
            const rawFeats = getFeaturesForMonitor(m);
            const f = rawFeats.find(item => item.key === featKey);
            const borderStyle = mIdx > 0 ? 'border-left: 1px solid rgba(255, 255, 255, 0.12);' : '';

            if (!f) {
                // Monitor does not support this feature row -> graceful empty placeholder
                html += `
                    <td class="panel-cell panel-cell-empty" data-mid="${m.id}" data-ctrl="${featKey}" style="padding: 3px 14px; ${borderStyle}">
                        <div style="display: flex; justify-content: space-between; align-items: center; width: 100%;">
                            <span style="color: #444; overflow: hidden; text-overflow: ellipsis; padding-right: 8px;">--</span>
                            <span style="color: #444; font-size: 12px;">--</span>
                        </div>
                    </td>
                `;
                continue;
            }

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

            html += `
                <td class="${cellClass}" data-mid="${m.id}" data-ctrl="${f.key}" style="padding: 3px 14px; ${borderStyle}">
                    <div style="display: flex; justify-content: space-between; align-items: center; width: 100%;">
                        <span style="color: #888; overflow: hidden; text-overflow: ellipsis; padding-right: 8px;">${f.label}</span>
                        <div>${controlContent}</div>
                    </div>
                </td>
            `;
        }
        html += `</tr>`;
    }

    html += `</tbody></table>`;
    panelControlsEl.innerHTML = html;

    const newTable = panelControlsEl.querySelector('table');

    // Index inputs and gain rows in fast-path lookup maps
    panelElementsMap.clear();
    const inputsAndSelects = newTable.querySelectorAll('.panel-input, .panel-select');
    inputsAndSelects.forEach(el => {
        const mid = el.getAttribute('data-mid');
        const ctrl = el.getAttribute('data-ctrl');
        if (mid && ctrl) {
            panelElementsMap.set(`${mid}_${ctrl}`, el);
        }
    });
    panelGainRows = Array.from(newTable.querySelectorAll('tr[data-requires-user-mode="true"]'));
    panelGainCells = Array.from(newTable.querySelectorAll('td[data-ctrl="gainR"], td[data-ctrl="gainG"], td[data-ctrl="gainB"]'));

    syncRgbGainVisibility(newTable);
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
                    syncRgbGainVisibility(panelControlsEl.querySelector('table'));
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
            syncRgbGainVisibility(panelControlsEl.querySelector('table'));
        }
        flushPendingDispatch(mid, ctrl, val);
    });
}

let telemetryCells = null;
let latestTelemetry = null;

function ensureTelemetryTable() {
    if (telemetryCells && hardwareEl && hardwareEl.querySelector('table')) return;
    if (!hardwareEl) return;
    const existingTable = hardwareEl.querySelector('table');
    if (!existingTable) {
        hardwareEl.innerHTML = `
        <table style="table-layout: fixed; width: 750px; margin: 6px auto 0 auto; border-collapse: collapse; font-size: 13px; line-height: 1.6; color: #ccc; text-align: left; font-variant-numeric: tabular-nums; white-space: nowrap;">
            <colgroup>
                <col style="width: 215px;">
                <col style="width: 315px;">
                <col style="width: 220px;">
            </colgroup>
            <thead>
                <tr style="color: #fff;">
                    <th style="padding: 2px 20px 4px 8px; font-weight: normal;">CPU</th>
                    <th style="padding: 2px 20px 4px 20px; font-weight: normal; border-left: 1px solid rgba(255, 255, 255, 0.12);">GPU</th>
                    <th style="padding: 2px 8px 4px 20px; font-weight: normal; border-left: 1px solid rgba(255, 255, 255, 0.12);">TJMax</th>
                </tr>
            </thead>
            <tbody>
                <tr>
                    <td id="tc-c1" style="padding: 3px 20px 3px 8px; overflow: hidden;">Load: --% &nbsp;|&nbsp; -- MHz</td>
                    <td id="tc-g1" style="padding: 3px 20px 3px 20px; border-left: 1px solid rgba(255, 255, 255, 0.12); overflow: hidden;">Load: --% &nbsp;|&nbsp; Core clk: -- MHz</td>
                    <td id="tc-o1" style="padding: 3px 8px 3px 20px; border-left: 1px solid rgba(255, 255, 255, 0.12); overflow: hidden;">P-State: --</td>
                </tr>
                <tr>
                    <td id="tc-c2" style="padding: 3px 20px 3px 8px; overflow: hidden;">P: -- GHz | E: -- GHz</td>
                    <td id="tc-g2" style="padding: 3px 20px 3px 20px; border-left: 1px solid rgba(255, 255, 255, 0.12); overflow: hidden;">Mem clk: -- MHz &nbsp;|&nbsp; Temp: --&deg;C</td>
                    <td id="tc-o2" style="padding: 3px 8px 3px 20px; border-left: 1px solid rgba(255, 255, 255, 0.12); overflow: hidden;">CPU Throttle: --</td>
                </tr>
                <tr>
                    <td id="tc-c3" style="padding: 3px 20px 3px 8px; overflow: hidden;">PKG: --W &nbsp;|&nbsp; Temp: --&deg;C</td>
                    <td id="tc-g3" style="padding: 3px 20px 3px 20px; border-left: 1px solid rgba(255, 255, 255, 0.12); overflow: hidden;">iGPU: --W (--) &nbsp;|&nbsp; dGPU: --W</td>
                    <td id="tc-o3" style="padding: 3px 8px 3px 20px; border-left: 1px solid rgba(255, 255, 255, 0.12); overflow: hidden;">GPU: -- &nbsp;|&nbsp; VRM: --</td>
                </tr>
                <tr>
                    <td id="tc-c4" style="padding: 3px 20px 3px 8px; overflow: hidden;">RAM: --</td>
                    <td id="tc-g4" style="padding: 3px 20px 3px 20px; border-left: 1px solid rgba(255, 255, 255, 0.12); overflow: hidden;">VRAM: --</td>
                    <td id="tc-o4" style="padding: 3px 8px 3px 20px; border-left: 1px solid rgba(255, 255, 255, 0.12); overflow: hidden;">Page: --</td>
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

function renderTelemetry(response) {
    if (!response || response.error) {
        if (infoState === 4 && hardwareEl) {
            const msg = (response && response.message) ? response.message : 'Sensor Read Failed';
            hardwareEl.textContent = `Host Offline (${msg})`;
            telemetryCells = null;
        } else if (infoState === 2 && panelControlsEl) {
            const hasExistingTable = panelControlsEl.querySelector('table');
            if (!hasExistingTable) {
                const msg = (response && response.message) ? response.message : 'Host Offline';
                panelControlsEl.textContent = `Host Offline (${msg})`;
            }
        }
        return;
    }

    latestTelemetry = response;

    if (infoState === 2) {
        if (waitingForProbeId > 0) {
            const respProbeId = Number(response.probeId || 0);
            if (respProbeId < waitingForProbeId || response.isProbing || !response.hasProbed) {
                if (!panelControlsEl.querySelector('table')) {
                    panelControlsEl.textContent = 'Searching for DDC/CI displays...';
                }
                return;
            }
            waitingForProbeId = 0;
            if (probeTimeoutId) {
                clearTimeout(probeTimeoutId);
                probeTimeoutId = null;
            }
            panelControlsEl.style.opacity = '1';
        }

        if (response.hasProbed === true && Array.isArray(response.monitors) && response.monitors.length > 0) {
            const normalized = response.monitors.map(m => ({
                ...m,
                id: m.pnpId || m.id
            }));
            latestMonitors = normalized;
            renderPanelControls(normalized);
        } else if (response.hasProbed === true && Array.isArray(response.monitors) && response.monitors.length === 0) {
            currentPanelTopologySignature = null;
            panelElementsMap.clear();
            panelGainRows = [];
            panelGainCells = [];
            lastUserModeKey = '';
            panelControlsEl.textContent = 'No DDC/CI compatible monitors detected';
        } else if (!response.hasProbed || !response.monitors) {
            if (!panelControlsEl.querySelector('table')) {
                panelControlsEl.textContent = 'Searching for DDC/CI displays...';
            }
        }
    }

    if (infoState !== 4 || !hardwareEl) return;

    ensureTelemetryTable();
    if (!telemetryCells) return;

    const cpuLimitVal = Number(response.cpuLimit);
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

    setCell(telemetryCells.c1, `Load: ${response.cpuLoad}% \u00A0|\u00A0 ${response.cpuClock} MHz`);
    setCell(telemetryCells.g1, `Load: ${response.gpuLoad}% \u00A0|\u00A0 Core clk: ${response.coreClock} MHz`);
    setCell(telemetryCells.o1, `P-State: ${response.pState}`);

    setCell(telemetryCells.c2, response.peClock);
    setCell(telemetryCells.g2, `Mem clk: ${response.memClock} MHz \u00A0|\u00A0 Temp: ${response.gpuTemp}°C`);
    setCell(telemetryCells.o2, `CPU Throttle: ${cpuThrottleText}`);

    setCell(telemetryCells.c3, `PKG: ${response.cpuPower}W \u00A0|\u00A0 Temp: ${response.cpuTemp}°C`);
    setCell(telemetryCells.g3, `iGPU: ${response.igpuPower}W (${response.igpuRam}) \u00A0|\u00A0 dGPU: ${response.gpuPower}W`);
    setCell(telemetryCells.o3, `GPU: ${gpuThrottleText} \u00A0|\u00A0 VRM: ${vrmThrottleText}`);

    setCell(telemetryCells.c4, `RAM: ${response.ramUsed}`);
    setCell(telemetryCells.g4, `VRAM: ${response.vramUsed}`);
    setCell(telemetryCells.o4, `Page: ${response.pageUsed || 'N/A'}`);
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
            if (panelControlsEl) panelControlsEl.style.opacity = '1';
            if (latestTelemetry && latestTelemetry.monitors && Array.isArray(latestTelemetry.monitors)) {
                renderPanelControls(latestTelemetry.monitors);
            }
        }
        probeTimeoutId = null;
    }, 8000);

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
    if (telemetryPort || document.hidden || (infoState !== 2 && infoState !== 4)) return;
    if (infoState === 4 && hardwareEl) {
        ensureTelemetryTable();
        if (latestTelemetry) {
            renderTelemetry(latestTelemetry);
        }
    } else if (infoState === 2 && panelControlsEl && !panelControlsEl.querySelector('table')) {
        panelControlsEl.textContent = 'Searching for DDC/CI displays...';
    }

    try {
        telemetryPort = chrome.runtime.connect({ name: 'telemetry' });

        telemetryPort.onMessage.addListener((data) => {
            renderTelemetry(data);
        });

        if (infoState === 2) {
            requestEmpiricalMonitorProbe();
        }

        telemetryPort.onDisconnect.addListener(() => {
            telemetryPort = null;
            if ((infoState === 2 || infoState === 4) && !document.hidden) {
                if (telemetryReconnectTimer) clearTimeout(telemetryReconnectTimer);
                telemetryReconnectTimer = setTimeout(() => {
                    telemetryReconnectTimer = null;
                    if ((infoState === 2 || infoState === 4) && !document.hidden && !telemetryPort) {
                        startTelemetryStream();
                    }
                }, 1000);
            }
        });
    } catch (e) {
        telemetryPort = null;
        if (infoState === 4 && hardwareEl) hardwareEl.textContent = 'Connection Error';
        else if (infoState === 2 && panelControlsEl) panelControlsEl.textContent = 'Connection Error';
    }
}

function stopTelemetryStream() {
    if (telemetryReconnectTimer) {
        clearTimeout(telemetryReconnectTimer);
        telemetryReconnectTimer = null;
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
    if (infoState !== 2) {
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
        // State 1: Weather
        stopTelemetryStream();
        if (weatherEl) {
            weatherEl.style.display = 'block';
            weatherEl.style.visibility = 'visible';
        }
        if (panelControlsEl) panelControlsEl.style.display = 'none';
        if (hardwareEl) hardwareEl.style.display = 'none';
    } else if (infoState === 2) {
        // State 2: Panel Controls
        if (weatherEl) weatherEl.style.display = 'none';
        if (hardwareEl) hardwareEl.style.display = 'none';
        if (panelControlsEl) {
            panelControlsEl.style.display = 'block';
            if (!panelControlsEl.querySelector('table')) {
                currentPanelTopologySignature = null;
                panelElementsMap.clear();
                panelGainRows = [];
                panelGainCells = [];
                lastUserModeKey = '';
                panelControlsEl.textContent = 'Searching for DDC/CI displays...';
            } else {
                panelControlsEl.style.opacity = '0.75';
            }
        }
        if (!telemetryPort) {
            startTelemetryStream();
        } else {
            requestEmpiricalMonitorProbe();
        }
    } else if (infoState === 3) {
        // State 3: Empty (Show Nothing)
        stopTelemetryStream();
        if (weatherEl) weatherEl.style.display = 'none';
        if (panelControlsEl) panelControlsEl.style.display = 'none';
        if (hardwareEl) hardwareEl.style.display = 'none';
    } else if (infoState === 4) {
        // State 4: Sensors
        if (weatherEl) weatherEl.style.display = 'none';
        if (panelControlsEl) panelControlsEl.style.display = 'none';
        if (hardwareEl) {
            hardwareEl.style.display = 'block';
            ensureTelemetryTable();
            if (latestTelemetry) {
                renderTelemetry(latestTelemetry);
            }
            startTelemetryStream();
        }
    }
}

const logoEl = document.querySelector('.logo');
if (logoEl) {
    logoEl.addEventListener('click', () => {
        const nextState = (infoState % 4) + 1;
        setInfoState(nextState);
    });
}

// Pause/disconnect telemetry when tab is hidden or minimized; resume when visible
document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
        stopTelemetryStream();
    } else {
        updateTime();
        if ((infoState === 2 || infoState === 4) && !telemetryPort) {
            startTelemetryStream();
        } else if (infoState === 2) {
            if (panelControlsEl && panelControlsEl.querySelector('table')) {
                panelControlsEl.style.opacity = '0.75';
            }
            requestEmpiricalMonitorProbe();
        }
    }
});

// Clean up OS pipe on tab close or navigation
window.addEventListener('beforeunload', () => {
    stopTelemetryStream();
});

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

if (infoState === 2) {
    requestEmpiricalMonitorProbe();
}
})();
