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
    
    // Optimize: Schedule next update exactly when the minute changes instead of every second
    const msUntilNextMinute = (60 - now.getSeconds()) * 1000 - now.getMilliseconds();
    setTimeout(updateTime, msUntilNextMinute);
}
updateTime();

async function getCoordinates() {
    const geoCacheKey = 'geoCoordsCache';
    const geoCacheTimeKey = 'geoCoordsCacheTime';
    const now = Date.now();
    const cachedCoords = localStorage.getItem(geoCacheKey);
    const cachedTime = localStorage.getItem(geoCacheTimeKey);

    if (cachedCoords && cachedTime && (now - parseInt(cachedTime, 10)) < 24 * 60 * 60 * 1000) {
        try {
            return JSON.parse(cachedCoords);
        } catch {}
    }

    try {
        let lat = null, lon = null;
        try {
            const geoRes = await fetch('https://freeipapi.com/api/json');
            if (geoRes.ok) {
                const geoData = await geoRes.json();
                if (geoData && geoData.latitude && geoData.longitude) {
                    lat = geoData.latitude;
                    lon = geoData.longitude;
                }
            }
        } catch {}

        if (!lat || !lon) {
            const fallbackRes = await fetch('https://ipapi.co/json/');
            if (fallbackRes.ok) {
                const fallbackData = await fallbackRes.json();
                if (fallbackData && fallbackData.latitude && fallbackData.longitude) {
                    lat = fallbackData.latitude;
                    lon = fallbackData.longitude;
                }
            }
        }

        if (lat && lon) {
            const coords = { lat, lon };
            localStorage.setItem(geoCacheKey, JSON.stringify(coords));
            localStorage.setItem(geoCacheTimeKey, now.toString());
            return coords;
        }
    } catch {}

    return null;
}

async function fetchWeather() {
    const cacheKey = 'weatherCache';
    const cacheTimeKey = 'weatherCacheTime';
    const now = Date.now();
    
    // Optimize: Check if we have weather data from the last 30 minutes to prevent API spam
    const cachedData = localStorage.getItem(cacheKey);
    const cachedTime = localStorage.getItem(cacheTimeKey);
    
    if (cachedData && cachedTime && (now - parseInt(cachedTime, 10)) < 30 * 60 * 1000) {
        weatherEl.innerHTML = cachedData;
        return;
    }

    weatherEl.textContent = 'Loading weather...';

    try {
        const coords = await getCoordinates();
        if (!coords) {
            throw new Error('Unable to resolve IP location');
        }

        const res = await fetch(`https://api.open-meteo.com/v1/forecast?latitude=${coords.lat}&longitude=${coords.lon}&current=temperature_2m,wind_speed_10m&hourly=precipitation_probability&timezone=auto&forecast_days=1`);
        const data = await res.json();
        
        const temp = data.current.temperature_2m;
        const wind = data.current.wind_speed_10m;
        const hourIndex = new Date().getHours();
        const rain = data.hourly.precipitation_probability[hourIndex];
        
        const weatherString = `${temp}°C &nbsp;|&nbsp; Rain ${rain}% &nbsp;|&nbsp; Wind ${wind} km/h`;
        weatherEl.innerHTML = weatherString;
        
        localStorage.setItem(cacheKey, weatherString);
        localStorage.setItem(cacheTimeKey, now.toString());
    } catch (e) {
        if (cachedData) {
            weatherEl.innerHTML = cachedData;
        } else {
            weatherEl.textContent = 'Weather unavailable';
        }
    }
}
fetchWeather();

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

function getFeaturesForMonitor(m) {
    if (!m) return DEFAULT_MONITOR_FEATURES;
    const name = (m.name || '').toUpperCase();
    const pnp = (m.pnpId || '').toUpperCase();
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
let currentPanelTopologySignature = null;
let latestMonitors = [];

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

function executeHardwareDispatch(mid, ctrl, numVal) {
    const payload = {
        action: 'set_panel_control',
        monitorId: mid,
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

function scheduleDispatch(mid, ctrl, value, delayMs = 75) {
    const key = `${mid}_${ctrl}`;
    const numVal = Number(value);

    // Grant optimistic lease immediately
    leaseManager.grant(mid, ctrl, numVal);

    // Cancel existing pending dispatch for this register
    cancelPendingDispatch(key);

    if (delayMs <= 0) {
        executeHardwareDispatch(mid, ctrl, numVal);
        return;
    }

    const timerId = setTimeout(() => {
        pendingDispatches.delete(key);
        executeHardwareDispatch(mid, ctrl, numVal);
    }, delayMs);

    pendingDispatches.set(key, { timerId, value: numVal });
}

function flushPendingDispatch(mid, ctrl, fallbackValue = null) {
    const key = `${mid}_${ctrl}`;
    const pending = pendingDispatches.get(key);
    if (pending) {
        clearTimeout(pending.timerId);
        pendingDispatches.delete(key);
        executeHardwareDispatch(mid, ctrl, pending.value);
        return true;
    }
    if (fallbackValue !== null) {
        const numVal = Number(fallbackValue);
        leaseManager.grant(mid, ctrl, numVal);
        executeHardwareDispatch(mid, ctrl, numVal);
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

function syncRgbGainVisibility(table) {
    const tbl = table || (panelControlsEl ? panelControlsEl.querySelector('table') : null);
    if (!tbl) return;

    // Detect which monitors currently have User / Custom color preset active
    const userModeMonitors = new Set();
    const selects = tbl.querySelectorAll('select[data-ctrl="colorPreset"]');
    selects.forEach(sel => {
        const mid = sel.getAttribute('data-mid');
        if (ColorPresetAdapter.isUserMode(sel.value)) {
            userModeMonitors.add(mid);
        }
    });

    const anyUserMode = userModeMonitors.size > 0;

    // Smoothly toggle table row visibility without DOM destruction
    const gainRows = tbl.querySelectorAll('tr[data-requires-user-mode="true"]');
    gainRows.forEach(row => {
        row.style.display = anyUserMode ? '' : 'none';
    });

    // Toggle per-monitor cell content: editable input when in user mode, N/A indicator when not
    const gainCells = tbl.querySelectorAll('td[data-ctrl="gainR"], td[data-ctrl="gainG"], td[data-ctrl="gainB"]');
    gainCells.forEach(cell => {
        const mid = cell.getAttribute('data-mid');
        const isUser = userModeMonitors.has(mid);
        const inputWrap = cell.querySelector('.gain-input-wrap');
        const naWrap = cell.querySelector('.gain-na-wrap');
        if (inputWrap) inputWrap.style.display = isUser ? 'block' : 'none';
        if (naWrap) naWrap.style.display = isUser ? 'none' : 'block';
        if (isUser) {
            cell.classList.remove('panel-cell-na');
            cell.classList.add('panel-cell-numeric');
        } else {
            cell.classList.remove('panel-cell-numeric');
            cell.classList.add('panel-cell-na');
        }
    });
}

function renderPanelControls(monitors) {
    if (!panelControlsEl || !Array.isArray(monitors) || monitors.length === 0) {
        if (panelControlsEl && Array.isArray(monitors) && monitors.length === 0) {
            panelControlsEl.textContent = 'No DDC/CI compatible monitors detected';
        }
        return;
    }

    // Sort monitors consistently: Primary display on left, secondary on right
    const sortedMonitors = [...monitors].sort((a, b) => {
        const aIsAcer = (a.name || '').toLowerCase().includes('acer') || (a.pnpId || '').toLowerCase().startsWith('acr');
        const bIsAcer = (b.name || '').toLowerCase().includes('acer') || (b.pnpId || '').toLowerCase().startsWith('acr');
        if (aIsAcer && !bIsAcer) return -1;
        if (!aIsAcer && bIsAcer) return 1;
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
                const el = existingTable.querySelector(`[data-mid="${m.id}"][data-ctrl="${f.key}"]`);
                if (!el) continue;

                // Reconcile incoming hardware telemetry via anti-rubber-banding lease manager
                let incomingRaw = m[f.key];
                if (f.key === 'colorPreset') incomingRaw = ColorPresetAdapter.normalize(incomingRaw);
                if (f.type === 'volume' && incomingRaw === -1) continue;

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
                    ${sortedMonitors.map((m, mIdx) => `<th style="padding: 2px 14px 4px 14px; font-weight: normal; ${mIdx > 0 ? 'border-left: 1px solid rgba(255, 255, 255, 0.12);' : ''} overflow: hidden; text-overflow: ellipsis;">${m.name}</th>`).join('')}
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
            } else if (f.type === 'volume' && (val === -1 || val === undefined)) {
                cellClass += ' panel-cell-na';
                controlContent = `<span style="color: #666; font-size: 12px; margin-left: 4px;">N/A</span>`;
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
    syncRgbGainVisibility(newTable);
    attachPanelControlListeners(newTable);
}

function attachPanelControlListeners(table) {
    const root = table || panelControlsEl;
    if (!root) return;

    // 1. Numeric Cells: Full-cell hover range & wheel interaction
    const numericInputs = root.querySelectorAll('.panel-input');
    numericInputs.forEach(input => {
        const cell = input.closest('.panel-cell');
        if (!cell) return;

        const mid = input.getAttribute('data-mid');
        const ctrl = input.getAttribute('data-ctrl');
        const minVal = Number(input.getAttribute('data-min') !== null ? input.getAttribute('data-min') : 0);
        const maxVal = Number(input.getAttribute('data-max') !== null ? input.getAttribute('data-max') : 100);
        const cellKey = `${mid}_${ctrl}`;

        // Resilient full-cell wheel scroll listener with physics accumulator
        cell.addEventListener('wheel', (e) => {
            if (cell.classList.contains('panel-cell-na') || cell.classList.contains('panel-cell-empty')) return;
            e.preventDefault();

            const steps = processWheelDelta(cellKey, e);
            if (steps === 0) return;

            const defaultStep = ctrl === 'brightness' ? 2 : 1;
            const multiplier = e.shiftKey ? (ctrl === 'brightness' ? 10 : 5) : defaultStep;
            const current = Math.max(minVal, Math.min(maxVal, parseInt(input.value, 10) || 0));

            if ((steps > 0 && current >= maxVal) || (steps < 0 && current <= minVal)) {
                input.value = steps > 0 ? maxVal : minVal;
                return;
            }

            const next = Math.max(minVal, Math.min(maxVal, current + (steps * multiplier)));
            input.value = next;
            scheduleDispatch(mid, ctrl, next, 75);
        }, { passive: false });

        // Clicking anywhere in the cell focuses the input
        cell.addEventListener('click', (e) => {
            if (cell.classList.contains('panel-cell-na') || cell.classList.contains('panel-cell-empty')) return;
            if (e.target !== input) {
                input.focus();
                input.select();
            }
        });

        input.addEventListener('keydown', (e) => {
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
                scheduleDispatch(mid, ctrl, next, 75);
            } else if (e.key === 'Enter') {
                input.blur();
            }
        });

        input.addEventListener('input', () => {
            const num = parseInt(input.value.replace(/[^0-9]/g, ''), 10);
            if (!isNaN(num)) {
                const clamped = Math.max(minVal, Math.min(maxVal, num));
                scheduleDispatch(mid, ctrl, clamped, 120);
            }
        });

        input.addEventListener('blur', () => {
            let num = parseInt(input.value.replace(/[^0-9]/g, ''), 10);
            if (isNaN(num)) num = minVal;
            const clamped = Math.max(minVal, Math.min(maxVal, num));
            input.value = clamped;
            flushPendingDispatch(mid, ctrl, clamped);
        });
    });

    // 2. Select Cells: Full-cell hover range & wheel interaction
    const selectElements = root.querySelectorAll('.panel-select');
    selectElements.forEach(select => {
        const cell = select.closest('.panel-cell');
        if (!cell) return;

        const mid = select.getAttribute('data-mid');
        const ctrl = select.getAttribute('data-ctrl');
        const cellKey = `${mid}_${ctrl}`;

        // Full-cell wheel scroll listener to cycle options with physics accumulator
        cell.addEventListener('wheel', (e) => {
            if (cell.classList.contains('panel-cell-empty')) return;
            e.preventDefault();
            if (select.options.length <= 1) return;

            const steps = processWheelDelta(cellKey, e);
            if (steps === 0) return;

            // In wheel scrolling, steps > 0 means wheeling up (previous option), steps < 0 means wheeling down (next option)
            const direction = -steps;
            const nextIdx = Math.max(0, Math.min(select.options.length - 1, select.selectedIndex + direction));
            if (nextIdx !== select.selectedIndex) {
                select.selectedIndex = nextIdx;
                const numVal = Number(select.value);

                // Instantly update dependent RGB gain rows if color preset changed
                if (ctrl === 'colorPreset') {
                    syncRgbGainVisibility(root);
                }

                // Debounce rapid wheel flicks on select elements to prevent I2C bus flooding
                scheduleDispatch(mid, ctrl, numVal, 150);
            }
        }, { passive: false });

        select.addEventListener('change', (e) => {
            const val = Number(e.target.value);
            if (ctrl === 'colorPreset') {
                syncRgbGainVisibility(root);
            }
            flushPendingDispatch(mid, ctrl, val);
        });
    });
}

let telemetryCells = null;

function ensureTelemetryTable() {
    if (telemetryCells && hardwareEl.querySelector('table')) return;
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
                    <td id="tc-c1" style="padding: 3px 20px 3px 8px; overflow: hidden;"></td>
                    <td id="tc-g1" style="padding: 3px 20px 3px 20px; border-left: 1px solid rgba(255, 255, 255, 0.12); overflow: hidden;"></td>
                    <td id="tc-o1" style="padding: 3px 8px 3px 20px; border-left: 1px solid rgba(255, 255, 255, 0.12); overflow: hidden;"></td>
                </tr>
                <tr>
                    <td id="tc-c2" style="padding: 3px 20px 3px 8px; overflow: hidden;"></td>
                    <td id="tc-g2" style="padding: 3px 20px 3px 20px; border-left: 1px solid rgba(255, 255, 255, 0.12); overflow: hidden;"></td>
                    <td id="tc-o2" style="padding: 3px 8px 3px 20px; border-left: 1px solid rgba(255, 255, 255, 0.12); overflow: hidden;"></td>
                </tr>
                <tr>
                    <td id="tc-c3" style="padding: 3px 20px 3px 8px; overflow: hidden;"></td>
                    <td id="tc-g3" style="padding: 3px 20px 3px 20px; border-left: 1px solid rgba(255, 255, 255, 0.12); overflow: hidden;"></td>
                    <td id="tc-o3" style="padding: 3px 8px 3px 20px; border-left: 1px solid rgba(255, 255, 255, 0.12); overflow: hidden;"></td>
                </tr>
                <tr>
                    <td id="tc-c4" style="padding: 3px 20px 3px 8px; overflow: hidden;"></td>
                    <td id="tc-g4" style="padding: 3px 20px 3px 20px; border-left: 1px solid rgba(255, 255, 255, 0.12); overflow: hidden;"></td>
                    <td id="tc-o4" style="padding: 3px 8px 3px 20px; border-left: 1px solid rgba(255, 255, 255, 0.12); overflow: hidden;"></td>
                </tr>
            </tbody>
        </table>
    `;
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

    if (Array.isArray(response.monitors) && response.monitors.length > 0) {
        localStorage.setItem('panelControlsCache', JSON.stringify(response.monitors));
        if (infoState === 2) {
            renderPanelControls(response.monitors);
        }
    } else if (infoState === 2 && response.hasProbed === true && Array.isArray(response.monitors) && response.monitors.length === 0) {
        panelControlsEl.textContent = 'No DDC/CI compatible monitors detected';
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

function startTelemetryStream() {
    if (telemetryPort || document.hidden) return;
    if (infoState === 4 && hardwareEl && !hardwareEl.querySelector('table')) {
        hardwareEl.textContent = 'Connecting sensors...';
    } else if (infoState === 2 && panelControlsEl && !panelControlsEl.querySelector('table')) {
        const cached = localStorage.getItem('panelControlsCache');
        if (!cached) {
            panelControlsEl.textContent = 'Searching for DDC/CI displays...';
        }
    }

    try {
        telemetryPort = chrome.runtime.connect({ name: 'telemetry' });

        telemetryPort.onMessage.addListener((data) => {
            renderTelemetry(data);
        });

        telemetryPort.onDisconnect.addListener(() => {
            telemetryPort = null;
            if ((infoState === 2 || infoState === 4) && !document.hidden) {
                // Auto-reconnect after 1 second if service worker was recycled by Chrome
                setTimeout(() => {
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
    if (telemetryPort) {
        try {
            telemetryPort.disconnect();
        } catch (e) {}
        telemetryPort = null;
    }
}

function setInfoState(state) {
    infoState = state;
    if (infoState !== 4) {
        telemetryCells = null;
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
            const cached = localStorage.getItem('panelControlsCache');
            if (cached) {
                try {
                    const parsed = JSON.parse(cached);
                    if (Array.isArray(parsed) && parsed.length > 0 && parsed[0].pnpId) {
                        renderPanelControls(parsed);
                    } else {
                        localStorage.removeItem('panelControlsCache');
                        panelControlsEl.textContent = 'Searching for DDC/CI displays...';
                    }
                } catch (e) {
                    localStorage.removeItem('panelControlsCache');
                    panelControlsEl.textContent = 'Searching for DDC/CI displays...';
                }
            } else {
                panelControlsEl.textContent = 'Searching for DDC/CI displays...';
            }
        }
        startTelemetryStream();
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
    } else if ((infoState === 2 || infoState === 4) && !telemetryPort) {
        startTelemetryStream();
    }
});

// Clean up OS pipe on tab close or navigation
window.addEventListener('beforeunload', () => {
    stopTelemetryStream();
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg.action === 'read_clipboard') {
        let text = '';
        try {
            let textarea = document.createElement('textarea');
            document.body.appendChild(textarea);
            textarea.focus();
            document.execCommand('paste');
            text = textarea.value;
            document.body.removeChild(textarea);
        } catch (e) {
            console.error('Clipboard paste failed', e);
        }
        sendResponse(text);
        return false;
    }
});