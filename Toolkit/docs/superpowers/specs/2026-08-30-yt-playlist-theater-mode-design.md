# Design Specification: YouTube Playlist Song Detection & Automated Theater Mode

**Date**: 2026-08-30  
**Author**: Hause & Antigravity  
**Status**: Implemented & Verified

---

## 1. Overview

This feature automatically disables YouTube Theater Mode whenever a song/video is playing within an active playlist (displaying the standard 2-column layout with the playlist panel placed side-by-side next to the player), while automatically enabling Theater Mode (full-bleed wide player) for all other playback scenarios.

Crucially, this is accomplished with an ultra-lightweight, zero-overhead sync engine in [`yt-float-search.js`](file:///c:/Users/Hause/Documents/Code/Toolkit/Toolkit/yt-float-search.js) that hooks into YouTube's SPA navigation lifecycle:
1. **Zero UI modifications** to YouTube's native theme, colors, controls, or typography.
2. **Zero continuous CPU overhead** (no persistent polling or heavy DOM observers during playback).
3. **Flawless player sizing**: Triggers YouTube's native `.ytp-size-button` so YouTube's internal canvas resize observers and DOM node reparenting operate cleanly with zero letterboxing or vanishing player bugs.

---

## 2. Requirements & Behavior

* **Rule 1 (Playlist Active)**: When a video/song is playing as part of a playlist (`location.pathname === '/watch'` and `list=` parameter is present), Theater Mode is toggled OFF so the playlist panel sits side-by-side with the player in a 2-column layout.
* **Rule 2 (Standalone Video / All Other Cases)**: When playing any video outside a playlist, Theater Mode is toggled ON so the player spans full width with metadata and recommendations underneath.
* **Respect In-Video Manual Overrides**: Checks only trigger upon page navigation transitions (`yt-navigate-finish` and initial load), allowing users to manually toggle theater mode during a single video if desired without fighting the script.

---

## 3. Architecture & Implementation

### 3.1 Event-Driven Navigation Sync
Hooks into `document.addEventListener('yt-navigate-finish', syncTheaterMode, { passive: true })`:
```javascript
const syncTheaterMode = () => {
  if (!location.pathname.startsWith('/watch')) return;

  let attempts = 0;
  const maxAttempts = 10;

  const checkAndToggle = () => {
    if (!location.pathname.startsWith('/watch')) return true;
    const watch = document.querySelector('ytd-watch-grid, ytd-watch-flexy');
    const sizeBtn = document.querySelector('.ytp-size-button');
    if (!watch || !sizeBtn) return false;

    const hasPlaylist = Boolean(new URLSearchParams(location.search).get('list'));
    const isTheater = watch.hasAttribute('theater');
    if ((hasPlaylist && isTheater) || (!hasPlaylist && !isTheater)) {
      sizeBtn.click();
    }
    return true;
  };

  if (!checkAndToggle()) {
    const timer = setInterval(() => {
      attempts++;
      if (checkAndToggle() || attempts >= maxAttempts) {
        clearInterval(timer);
      }
    }, 100);
  }
};
```

---

## 4. Verification

1. **Standalone Video Verification**: Open a standard YouTube video (`https://www.youtube.com/watch?v=...`) &rarr; Automatically switches to Theater Mode on load.
2. **Playlist Video Verification**: Open a YouTube video with a playlist (`https://www.youtube.com/watch?v=...&list=...`) &rarr; Automatically switches to 2-column standard view with playlist panel on right.
3. **Rapid SPA Navigation**: Navigating between playlist mixes and standalone videos seamlessly adjusts without race conditions or black bars.
