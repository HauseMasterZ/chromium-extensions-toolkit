# Chromium Toolkit
<p align="center">
  <img width="307" height="472" alt="image" src="https://github.com/user-attachments/assets/2caabf39-e401-491c-aaa0-f59275514db6" />
</p>

Bundles
- [YT Float](https://github.com/HauseMasterZ/youtube_floating_search)
- [NewTab](https://github.com/HauseMasterZ/chromium-newtab-extension)
- [CopyOnSelect](https://github.com/HauseMasterZ/copy-on-select)
- [YTMusicAudio](https://github.com/HauseMasterZ/yt-music-audio)
- [PasteGo](https://github.com/HauseMasterZ/paste-go) Note: Change default shortcuts by going to ```chrome://extensions/shortcuts```
- [Whatsapp Wide Layout](https://github.com/HauseMasterZ/WhatsApp-Web-Style-Tweaks)
- [Whatsapp Virtual Cam](https://github.com/HauseMasterZ/whatsapp-spoof-video)
- [AutoDarkMode](https://github.com/HauseMasterZ/auto-dark-mode) Note: Change default shortcuts by going to ```chrome://extensions/shortcuts```
- Bonus: Add per tab volume controls

Into single bundle


# INSTALLATION
- Download zip by using [this link](https://github.com/HauseMasterZ/chromium-extensions-toolkit/releases/latest/download/Toolkit.zip)
- Extract zip to any folder
- Enable Developer mode in extension setting at ```chrome://extensions```
- Select load Unpacked Extension and select the extracted folder.

# Native Host Registration

To enable hardware telemetry and DDC/CI monitor panel controls on the New Tab page:

1. Navigate to `Toolkit/native-host/`.
2. Run `install-host.bat` (or execute `setup-host.ps1` in PowerShell).

The installer will automatically pair your extension ID, configure the native host manifest with your local path, and register the native messaging host in the Windows Registry for Google Chrome and Chromium.