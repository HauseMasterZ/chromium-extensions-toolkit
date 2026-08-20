localStorage.ytmusic_player_audio_quality = '"HIGH"';
localStorage.ytmusic_player_ambient_mode = 'false'; 
localStorage.ytmusic_player_cinematic_lighting = 'false';
localStorage.ytmusic_cinematic_ui_enabled = 'false';

Object.defineProperty(window, '_lact', {
    get: () => Date.now(),
    set: () => {},
    configurable: true
});

const _fetch = window.fetch;

function processPayload(rawText) {
    try {
        const sanitized = rawText.replace(/"MUSIC_VIDEO_TYPE_\w+"/g, '"MUSIC_VIDEO_TYPE_ATV"');
        const data = JSON.parse(sanitized);
        if (data?.streamingData) {
            data.streamingData.formats = [];
            data.streamingData.adaptiveFormats = data.streamingData.adaptiveFormats?.filter(f => f.mimeType?.includes('audio'));
            data.streamingData.dashManifestUrl = data.streamingData.hlsManifestUrl = '';
        }
        return JSON.stringify(data);
    } catch {
        return rawText;
    }
}

window.fetch = async (req, opts) => {
    const res = await _fetch(req, opts);
    const url = typeof req === 'string' ? req : req?.url || '';
    if (url.includes('/youtubei/v1/')) {
        const text = await res.text();
        return new Response(processPayload(text), { status: res.status, headers: res.headers });
    }
    return res;
};

const style = document.createElement('style');
style.textContent = '#song-video, canvas, ytmusic-cinematic-video-renderer {display:none!important} #song-image {display:block!important;opacity:1!important;z-index:99!important}';
document.documentElement.appendChild(style);

let lastList;

document.addEventListener('loadeddata', () => {
    // 1. Always update background image
    setTimeout(() => {
        const art = navigator.mediaSession?.metadata?.artwork;
        const bg = art?.at(-1)?.src || art?.at(0)?.src;
        if (bg) {
            const imgEl = document.getElementById('song-image');
            if (imgEl) imgEl.style.background = `url('${bg}') center/contain no-repeat #000`;
        }
    }, 150);

    // 2. Repeat logic
    const list = new URLSearchParams(location.search).get('list');
    if (!list || list === lastList) return;
    lastList = list;

    const rep = document.querySelector('.repeat');
    if (rep && !rep.title.includes('one')) {
        rep.click();
        if (!rep.title.includes('one')) setTimeout(() => rep.click(), 50);
    }
}, true);