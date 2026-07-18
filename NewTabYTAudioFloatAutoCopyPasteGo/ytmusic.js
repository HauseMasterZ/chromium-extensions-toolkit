localStorage.ytmusic_player_audio_quality = '"HIGH"';
localStorage.ytmusic_player_ambient_mode = 'false'; 
localStorage.ytmusic_player_cinematic_lighting = 'false';
localStorage.ytmusic_cinematic_ui_enabled = 'false';

Object.defineProperty(window, '_lact', {
    get: () => Date.now(),
    set: () => {},
    configurable: true
});

const _p = JSON.parse, _f = window.fetch;

JSON.parse = (t, r) => {
    let o = _p(typeof t === 'string' ? t.replace(/"MUSIC_VIDEO_TYPE_\w+"/g, '"MUSIC_VIDEO_TYPE_ATV"') : t, r), s = o?.streamingData;
    if (s) {
        s.formats = [];
        s.adaptiveFormats = s.adaptiveFormats?.filter(f => f.mimeType?.includes('audio'));
        s.dashManifestUrl = s.hlsManifestUrl = '';
    }
    return o;
};

window.fetch = async (req, opts) => {
    let res = await _f(req, opts);
    if ((req.url || req).includes('/youtubei/v1/')) {
        let text = await res.text();
        return new Response(JSON.stringify(JSON.parse(text)), {status: res.status, headers: res.headers});
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
        let art = navigator.mediaSession?.metadata?.artwork;
        let bg = art?.at(-1)?.src || art?.at(0)?.src;
        if (bg) document.getElementById('song-image').style.background = `url('${bg}') center/contain no-repeat #000`;
    }, 150);

    // 2. Repeat logic
    let list = new URLSearchParams(location.search).get('list');
    if (!list || list === lastList) return; // Ignores URL flickers and same-playlist tracks
    lastList = list;

    let rep = document.querySelector('.repeat');
    if (rep && !rep.title.includes('one')) {
        rep.click();
        if (!rep.title.includes('one')) setTimeout(() => rep.click(), 50);
    }
}, true);