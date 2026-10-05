const openTabs = (urls, updateFirst = false) => {
    if (updateFirst) chrome.tabs.update({ url: urls[0] });
    else chrome.tabs.create({ url: urls[0] });
    urls.slice(1).forEach(url => chrome.tabs.create({ url }));
};

document.getElementById('link-l').addEventListener('click', () => openTabs(['https://discord.com/channels/@me', 'https://music.youtube.com/playlist?list=PLK5tc6FSo175xc8zNBMrUZJIY9Q_K9I4w', 'https://photos.google.com/u/1/?pli=1']));
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

async function fetchWeather() {
    const cacheKey = 'weatherCache';
    const cacheTimeKey = 'weatherCacheTime';
    const now = Date.now();
    
    // Optimize: Check if we have weather data from the last 30 minutes to prevent API spam
    const cachedData = localStorage.getItem(cacheKey);
    const cachedTime = localStorage.getItem(cacheTimeKey);
    
    if (cachedData && cachedTime && (now - parseInt(cachedTime)) < 30 * 60 * 1000) {
        weatherEl.innerHTML = cachedData;
        return;
    }

    weatherEl.textContent = 'Loading weather...';

    try {
        const res = await fetch('https://api.open-meteo.com/v1/forecast?latitude=17.3850&longitude=78.4867&current=temperature_2m,wind_speed_10m&hourly=precipitation_probability&timezone=auto&forecast_days=1');
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

// Hardware Telemetry & Info-Panel 3-State Cycle (Streaming 0.5Hz)
const hardwareEl = document.getElementById('hardware');
let infoState = 1; // 1: Weather (Default), 2: Empty / Hidden, 3: Sensors
let telemetryPort = null;

let telemetryCells = null;

function ensureTelemetryTable() {
    if (telemetryCells && hardwareEl.querySelector('table')) return;
    hardwareEl.innerHTML = `
        <table style="table-layout: fixed; width: 750px; margin: 6px auto 0 auto; border-collapse: collapse; font-size: 13px; line-height: 1.6; color: #ccc; text-align: left; font-variant-numeric: tabular-nums; white-space: nowrap;">
            <colgroup>
                <col style="width: 220px;">
                <col style="width: 340px;">
                <col style="width: 190px;">
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
    if (!hardwareEl || infoState !== 3) return;

    if (!response || response.error) {
        const msg = (response && response.message) ? response.message : 'Sensor Read Failed';
        hardwareEl.textContent = `Host Offline (${msg})`;
        telemetryCells = null;
        return;
    }

    ensureTelemetryTable();
    if (!telemetryCells) return;

    const cpuLimitVal = Number(response.cpuLimit);
    const cpuThrottleText = cpuLimitVal < 100 ? `Yes (${cpuLimitVal}%)` : `No (${cpuLimitVal}%)`;
    const isGpuThrottleActive = String(response.hwThermal || '').trim().toLowerCase() === 'active';
    const isVrmActive = String(response.vrmBrake || '').trim().toLowerCase() === 'active';

    telemetryCells.c1.textContent = `Load: ${response.cpuLoad}% \u00A0|\u00A0 ${response.cpuClock} MHz`;
    telemetryCells.g1.textContent = `Load: ${response.gpuLoad}% \u00A0|\u00A0 Core clk: ${response.coreClock} MHz`;
    telemetryCells.o1.textContent = `P-State: ${response.pState}`;

    telemetryCells.c2.textContent = response.peClock;
    telemetryCells.g2.textContent = `Mem clk: ${response.memClock} MHz \u00A0|\u00A0 Temp: ${response.gpuTemp}°C`;
    telemetryCells.o2.textContent = `CPU Throttle: ${cpuThrottleText}`;

    telemetryCells.c3.textContent = `PKG: ${response.cpuPower}W \u00A0|\u00A0 Temp: ${response.cpuTemp}°C`;
    telemetryCells.g3.textContent = `iGPU: ${response.igpuPower}W (${response.igpuRam}) \u00A0|\u00A0 dGPU: ${response.gpuPower}W`;
    telemetryCells.o3.textContent = `GPU Throttle: ${isGpuThrottleActive ? 'Yes' : 'No'}`;

    telemetryCells.c4.textContent = `RAM: ${response.ramUsed}`;
    telemetryCells.g4.textContent = `VRAM: ${response.vramUsed}`;
    telemetryCells.o4.textContent = `VRM Throttle: ${isVrmActive ? 'Yes' : 'No'}`;
}

function startTelemetryStream() {
    if (telemetryPort || document.hidden) return;
    if (hardwareEl && !hardwareEl.querySelector('table')) {
        hardwareEl.textContent = 'Connecting sensors...';
    }

    try {
        telemetryPort = chrome.runtime.connect({ name: 'telemetry' });

        telemetryPort.onMessage.addListener((data) => {
            renderTelemetry(data);
        });

        telemetryPort.onDisconnect.addListener(() => {
            telemetryPort = null;
            if (infoState === 3 && !document.hidden) {
                // Auto-reconnect after 1 second if service worker was recycled by Chrome
                setTimeout(() => {
                    if (infoState === 3 && !document.hidden && !telemetryPort) {
                        startTelemetryStream();
                    }
                }, 1000);
            }
        });
    } catch (e) {
        telemetryPort = null;
        if (hardwareEl) hardwareEl.textContent = 'Connection Error';
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
    if (infoState === 1 || infoState === 2) {
        telemetryCells = null;
    }
    if (infoState === 1) {
        // State 1: Weather
        stopTelemetryStream();
        if (weatherEl) {
            weatherEl.style.display = 'block';
            weatherEl.style.visibility = 'visible';
        }
        if (hardwareEl) hardwareEl.style.display = 'none';
    } else if (infoState === 2) {
        // State 2: Empty (Show Nothing)
        stopTelemetryStream();
        if (weatherEl) weatherEl.style.display = 'none';
        if (hardwareEl) hardwareEl.style.display = 'none';
    } else if (infoState === 3) {
        // State 3: Sensors
        if (weatherEl) weatherEl.style.display = 'none';
        if (hardwareEl) {
            hardwareEl.style.display = 'block';
            startTelemetryStream();
        }
    }
}

const logoEl = document.querySelector('.logo');
if (logoEl) {
    logoEl.addEventListener('click', () => {
        const nextState = (infoState % 3) + 1;
        setInfoState(nextState);
    });
}

// Pause/disconnect telemetry when tab is hidden or minimized; resume when visible
document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
        stopTelemetryStream();
    } else if (infoState === 3 && !telemetryPort) {
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