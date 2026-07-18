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

let initialRepeatSet = false;

document.addEventListener('loadeddata', () => {
    if (!initialRepeatSet) {
        let rep = document.querySelector('ytmusic-player-bar .repeat');
        if (rep) {
            if (!/(one|1)/i.test(rep.title + rep.getAttribute('aria-label')) && !/repeat[-_]one/i.test(rep.innerHTML)) {
                rep.click();
                rep.click();
            }
            initialRepeatSet = true; 
        }
    }
    
    setTimeout(() => {
        let arts = navigator.mediaSession?.metadata?.artwork;
        let bg = arts?.find(a => a.sizes?.includes('512'))?.src || arts?.at(1)?.src || arts?.at(0)?.src;
        if (bg) document.getElementById('song-image').style.background = `url('${bg}') center/contain no-repeat #000`;
    }, 150);
}, true);