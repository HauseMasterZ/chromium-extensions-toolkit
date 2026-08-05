
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

        const drawLoop = setInterval(() => {
            if (realVideoTrack.readyState === 'ended') {
                clearInterval(drawLoop);
                return;
            }
            if (!video.videoWidth || !video.videoHeight) return;
            
            if (canvas.width !== video.videoWidth) canvas.width = video.videoWidth;
            if (canvas.height !== video.videoHeight) canvas.height = video.videoHeight;

            // This canvas pass-through permanently fixes your RTX 4080 upside-down bug
            ctx.clearRect(0, 0, canvas.width, canvas.height);
            ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
        }, 1000 / 30); // Set exact timing for 30 FPS

        // Capture output at exactly 30 FPS
        const correctedStream = canvas.captureStream(30);
        const correctedVideoTrack = correctedStream.getVideoTracks()[0];
        
        // Force WebRTC to prioritize text sharpness
        correctedVideoTrack.contentHint = 'detail'; 

        const originalSettings = realVideoTrack.getSettings();
        correctedVideoTrack.getSettings = () => originalSettings;
        Object.defineProperty(correctedVideoTrack, 'label', { get: () => realVideoTrack.label });

        correctedVideoTrack.onended = () => {
            clearInterval(drawLoop);
            realVideoTrack.stop();
        };
        realVideoTrack.onended = () => {
            clearInterval(drawLoop);
            correctedVideoTrack.stop();
        };

        return new MediaStream([correctedVideoTrack]);
    };
})();