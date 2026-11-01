(function() {
    if (window.__waVirtualCamInjected) return;
    window.__waVirtualCamInjected = true;

    console.log("[WA Virtual Cam] Stable Build Active: 30 FPS Text Priority.");
    window.__wa_virtual_cam_refs = [];

    const trackCleanupMap = new WeakMap();
    if (!MediaStreamTrack.prototype.__waOriginalStop) {
        const originalTrackStop = MediaStreamTrack.prototype.stop;
        MediaStreamTrack.prototype.__waOriginalStop = originalTrackStop;
        MediaStreamTrack.prototype.stop = function() {
            const cleanupFn = trackCleanupMap.get(this);
            if (typeof cleanupFn === 'function') {
                trackCleanupMap.delete(this);
                try { cleanupFn(); } catch (e) {}
            }
            return originalTrackStop.apply(this, arguments);
        };
    }

    // ==========================================
    // 1. HARDWARE CHECK BYPASS
    // ==========================================
    const originalEnumerateDevices = navigator.mediaDevices.enumerateDevices.bind(navigator.mediaDevices);
    navigator.mediaDevices.enumerateDevices = async () => {
        const devices = await originalEnumerateDevices();
        devices.push({
            deviceId: "spoofed-camera-1",
            kind: "videoinput",
            label: "Internal WebRTC Camera",
            groupId: "spoofed-group",
            toJSON: function() { return this; }
        });
        return devices;
    };

    // ==========================================
    // 2. ULTRA-EFFICIENT PURE BLACK CAMERA (1 FPS)
    // ==========================================
    const originalGetUserMedia = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
    navigator.mediaDevices.getUserMedia = async (constraints) => {
        if (constraints && constraints.video) {
            let audioTrack = null;
            if (constraints.audio) {
                try {
                    const stream = await originalGetUserMedia({ audio: true, video: false });
                    audioTrack = stream.getAudioTracks()[0];
                } catch (e) {}
            }

            const canvas = document.createElement('canvas');
            canvas.width = 640; canvas.height = 480;
            const ctx = canvas.getContext('2d');
            ctx.fillStyle = 'black';
            ctx.fillRect(0, 0, canvas.width, canvas.height);

            const fakeStream = canvas.captureStream(1);
            const videoTrack = fakeStream.getVideoTracks()[0];
            const tracks = [videoTrack];
            if (audioTrack) tracks.push(audioTrack);
            
            window.__wa_virtual_cam_refs.push(canvas, fakeStream);
            const cleanupFake = () => {
                const idx = window.__wa_virtual_cam_refs.indexOf(canvas);
                if (idx !== -1) window.__wa_virtual_cam_refs.splice(idx, 1);
                const idx2 = window.__wa_virtual_cam_refs.indexOf(fakeStream);
                if (idx2 !== -1) window.__wa_virtual_cam_refs.splice(idx2, 1);
            };
            videoTrack.onended = cleanupFake;
            trackCleanupMap.set(videoTrack, cleanupFake);
            return new MediaStream(tracks);
        }
        return originalGetUserMedia(constraints);
    };

    // ==========================================
    // 3. 30 FPS SCREEN SHARE (BALANCED TEXT CLARITY)
    // ==========================================
    const originalGetDisplayMedia = navigator.mediaDevices.getDisplayMedia.bind(navigator.mediaDevices);
    navigator.mediaDevices.getDisplayMedia = async (originalConstraints) => {
        
        // Lock capture to 1080p / 30 FPS 
        const strictConstraints = {
            video: {
                width: { ideal: 1920 },
                height: { ideal: 1080 },
                frameRate: { ideal: 30, max: 30 }
            },
            audio: originalConstraints && originalConstraints.audio ? originalConstraints.audio : false
        };

        const realStream = await originalGetDisplayMedia(strictConstraints);
        const realVideoTrack = realStream.getVideoTracks()[0];

        const video = document.createElement('video');
        video.srcObject = new MediaStream([realVideoTrack]);
        video.autoplay = true;
        video.muted = true;
        video.playsInline = true;
        video.play().catch(e => console.warn(e));

        const canvas = document.createElement('canvas');
        const ctx = canvas.getContext('2d');
        
        ctx.imageSmoothingEnabled = true;
        ctx.imageSmoothingQuality = 'high';

        window.__wa_virtual_cam_refs.push(video, canvas);

        let active = true;
        const hasRvfc = 'requestVideoFrameCallback' in video;
        const renderFrame = () => {
            if (!active || realVideoTrack.readyState === 'ended') return;
            if (video.videoWidth && video.videoHeight) {
                if (canvas.width !== video.videoWidth) canvas.width = video.videoWidth;
                if (canvas.height !== video.videoHeight) canvas.height = video.videoHeight;
                ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
            }
            if (hasRvfc) {
                video.requestVideoFrameCallback(renderFrame);
            } else {
                setTimeout(renderFrame, 1000 / 30);
            }
        };

        if (hasRvfc) {
            video.requestVideoFrameCallback(renderFrame);
        } else {
            setTimeout(renderFrame, 1000 / 30);
        }

        // Capture output at 30 FPS
        const correctedStream = canvas.captureStream(30);
        const correctedVideoTrack = correctedStream.getVideoTracks()[0];
        
        // Force WebRTC to prioritize text sharpness
        correctedVideoTrack.contentHint = 'detail'; 

        const originalSettings = realVideoTrack.getSettings();
        correctedVideoTrack.getSettings = () => originalSettings;
        Object.defineProperty(correctedVideoTrack, 'label', { get: () => realVideoTrack.label });

        const returnTracks = [correctedVideoTrack];
        const audioTracks = realStream.getAudioTracks();
        if (audioTracks.length > 0) {
            returnTracks.push(audioTracks[0]);
        }

        const cleanup = () => {
            if (!active) return;
            active = false;
            try { realVideoTrack.stop(); } catch {}
            try { correctedVideoTrack.stop(); } catch {}
            for (let i = 0; i < audioTracks.length; i++) {
                try { audioTracks[i].stop(); } catch {}
            }
            try { video.pause(); } catch {}
            video.srcObject = null;
            window.__wa_virtual_cam_refs = window.__wa_virtual_cam_refs.filter(r => r !== video && r !== canvas);
        };

        correctedVideoTrack.onended = cleanup;
        realVideoTrack.onended = cleanup;
        trackCleanupMap.set(correctedVideoTrack, cleanup);
        trackCleanupMap.set(realVideoTrack, cleanup);
        for (let i = 0; i < audioTracks.length; i++) {
            audioTracks[i].onended = cleanup;
            trackCleanupMap.set(audioTracks[i], cleanup);
        }

        return new MediaStream(returnTracks);
    };
})();
