# YouTube Playlist Song Detection & Automated Theater Mode Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Automatically disable YouTube Theater Mode when a song/video is playing in a playlist (side-by-side 2-column view) and enable Theater Mode for all other scenarios (standalone videos) using an ultra-lightweight event-driven sync engine.

**Architecture:** Event-driven navigation hook (`yt-navigate-finish`) in [`yt-float-search.js`](file:///c:/Users/Hause/Documents/Code/Toolkit/Toolkit/yt-float-search.js) dynamically inspects playlist context and triggers the native YouTube size controller, ensuring full DOM compatibility and seamless player canvas resizing without any visual theme changes.

**Tech Stack:** JavaScript (ES6+, DOM APIs, Custom Events), Chromium Extension Manifest V3.

## Global Constraints

- Zero continuous polling or heavy DOM observers during playback.
- Zero modifications to YouTube frontend colors, icons, controls, or styling.
- Lightweight logic integrated into [`yt-float-search.js`](file:///c:/Users/Hause/Documents/Code/Toolkit/Toolkit/yt-float-search.js).

---

### Task 1: Add Lightweight Navigation Sync to `yt-float-search.js`
- [x] Integrate `syncTheaterMode` with bounded retry and dynamic URL check.

### Task 2: Validate Manifest & Content Script Registration
- [x] Verified `manifest.json` and `bg-service-worker.js` dynamic registration.

### Task 3: Verification & Walkthrough
- [x] Final review clean and documented in walkthrough.
