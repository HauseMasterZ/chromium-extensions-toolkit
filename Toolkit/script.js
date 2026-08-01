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