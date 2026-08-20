
(function() {
    console.log("[WA Virtual Cam] Stable Build Active: 30 FPS Text Priority.");
    window.__wa_virtual_cam_refs = [];

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
        const ctx = canvas.getContext('2d', { willReadFrequently: true });
        
        ctx.imageSmoothingEnabled = true;
        ctx.imageSmoothingQuality = 'high';

        window.__wa_virtual_cam_refs.push(video, canvas);

        let active = true;
        const renderFrame = () => {
            if (!active || realVideoTrack.readyState === 'ended') return;
            if (video.videoWidth && video.videoHeight) {
                if (canvas.width !== video.videoWidth) canvas.width = video.videoWidth;
                if (canvas.height !== video.videoHeight) canvas.height = video.videoHeight;
                ctx.clearRect(0, 0, canvas.width, canvas.height);
                ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
            }
            if ('requestVideoFrameCallback' in video) {
                video.requestVideoFrameCallback(renderFrame);
            } else {
                setTimeout(renderFrame, 1000 / 30);
            }
        };

        if ('requestVideoFrameCallback' in video) {
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

        const cleanup = () => {
            active = false;
            realVideoTrack.stop();
            correctedVideoTrack.stop();
        };

        correctedVideoTrack.onended = cleanup;
        realVideoTrack.onended = cleanup;

        return new MediaStream([correctedVideoTrack]);
    };
})();