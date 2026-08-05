
(function () {
  const STYLE_ID = 'wa-wide-layout-v7';

  function injectStyles() {
    if (document.getElementById(STYLE_ID)) return;
    
    const el = document.createElement('style');
    el.id = STYLE_ID;
    
    el.textContent = `
      /* 1. Transform Nav Rail into an Invisible Anchor Point */
      .two > header:has([data-testid="navbar-primary-section"]),
      .three > header:has([data-testid="navbar-primary-section"]) {
        position: absolute !important;
        left: 0 !important;
        top: 0 !important;
        width: 0 !important;
        height: 0 !important;
        padding: 0 !important;
        margin: 0 !important;
        border: none !important;
        z-index: 1000 !important;
        pointer-events: none !important;
        overflow: visible !important;
        background: transparent !important;
      }

      /* Hide Top Nav Rail Icons */
      [data-testid="navbar-primary-section"] > div:not([data-testid="navbar-footer-section"]),
      [data-testid="navbar-primary-section"] > hr {
        display: none !important;
      }

      /* Transplant Footer Icons using Left Calc Anchor */
      [data-testid="navbar-footer-section"] {
        position: absolute !important;
        top: 10px !important;
        left: calc(var(--chatlist-width, 300px) - 220px) !important; /* Pushed further left to clear native icons */
        right: auto !important;
        display: flex !important;
        flex-direction: row !important;
        width: auto !important;
        height: 40px !important;
        pointer-events: auto !important; /* Re-enable clicks just for these icons */
      }

      [data-testid="navbar-footer-section"] > div {
        display: flex !important;
        flex-direction: row !important;
        align-items: center !important;
        gap: 8px !important;
        margin: 0 !important;
      }

      /* 2. Force App Container to Full Width */
      #app .two,
      #app .three,
      #app > div > div {
        width: 100% !important;
        max-width: 100% !important;
      }

      /* 3. Strip Native Border from Chat List and Main Panel */
      .two > div:has(#side),
      .three > div:has(#side),
      [data-testid^="drawer-"],
      #side,
      #main {
        border: none !important;
        border-left: none !important;
        border-right: none !important;
        outline: none !important;
        box-shadow: none !important;
      }
      
      /* Hide the phantom absolute-positioned resizer handle that draws the hairline */
      .two > header:has([data-testid="navbar-primary-section"]) + div,
      .three > header:has([data-testid="navbar-primary-section"]) + div {
        display: none !important;
      }

      /* 4. Expand Main Conversation Area and Strip Border */
      .two > div:has(#main),
      .three > div:has(#main),
      [data-testid="intro-panel"] {
        flex: 1 1 auto !important;
        min-width: 0 !important;
        width: 100% !important;
        max-width: 100% !important;
        overflow: visible !important;
        border: none !important;
        outline: none !important;
        box-shadow: none !important;
        margin: 0 !important;
      }

      /* Ensure intermediate wrappers don't clip the left shift */
      .two > div:has(#main) > div,
      .three > div:has(#main) > div,
      .two > div:has(#main) > div > div,
      .three > div:has(#main) > div > div,
      #main {
        overflow: visible !important;
      }

      /* Destroy Flex Gaps in Main Layout */
      .two > div,
      .three > div {
        gap: 0 !important;
      }


      /* 6. Destroy Padding, Max-Width, and Borders on Main Scrollable Chat Body */
      [data-testid="conversation-panel-body"],
      [data-testid="conversation-panel-body"] > div,
      [data-testid="conversation-panel-body"] > div > div,
      [data-testid="conversation-panel-messages"],
      [data-testid="conversation-panel-messages"] > div,
      [data-testid="conversation-panel-messages"] > div > div,
      [data-testid="conversation-panel-messages"] > div > div > div,
      [data-testid="conversation-panel-messages"] > div > div > div > div,
      [data-testid="conversation-panel-messages"] > div > div > div > div > div {
        padding-left: 0 !important;
        padding-right: 0 !important;
        max-width: none !important;
        width: 100% !important;
        border: none !important;
        outline: none !important;
        box-shadow: none !important;
      }

      /* 7. Ensure Individual Message Rows Stretch Fully and Strip Borders/Margins */
      #main [role="row"],
      #main [role="row"] > div,
      #main [role="row"] > div > div,
      #main [role="row"] > div > div > div,
      #main [role="row"] > div > div > div > div {
        padding-left: 0 !important;
        padding-right: 0 !important;
        margin-left: 0 !important;
        margin-right: 0 !important;
        max-width: none !important;
        border: none !important;
        outline: none !important;
        box-shadow: none !important;
      }

      /* 7b. Hide Profile Photos in Group Chats */
      #main [data-testid="group-chat-profile-picture"],
      #main div:has(> [data-testid="group-chat-profile-picture"]) {
        display: none !important;
      }

      /* 8. Cap Message Bubble Width */
      [data-testid="msg-container"] {
        max-width: 50vw !important;
      }

      /* 7. Fix Left Gap on Image Sender / Media Viewer Modals */
      [data-testid="drawer-middle"],
      [data-testid="drawer-fullscreen"],
      [data-testid="media-viewer"] {
        margin-left: 0 !important;
        left: 0 !important;
      }

      /* 9. Obliterate Native Borders globally */
      :root {
        --border-default: transparent !important;
        --border-list: transparent !important;
        --border-panel: transparent !important;
        --border-strong: transparent !important;
        --border-stronger: transparent !important;
        --panel-header-border: transparent !important;
        --conversation-panel-border: transparent !important;
        --drawer-border: transparent !important;
      }

      /* Destroy phantom pseudo-element borders between panes */
      .two > div::after,
      .three > div::after,
      .two > div::before,
      .three > div::before,
      #side::after,
      #side::before {
        display: none !important;
      }

      /* 15. Make Sticky Date Header Divs Transparent */
      div.x3psx0u.x12xbjc7.x1c1uobl.x1yjeaew.xh8yej3.xquzyny.xvc5jky.x11t971q div {
        background: transparent !important;
      }

      /* 16. Pitch Black Background for Specific Parent Div's Children */
      div.x9f619.x1n2onr6.x5yr21d.x17dzmu4.x1i1dayz.x2ipvbc.xjdofhw.x78zum5.xdt5ytf.x12xzxwr.x1plvlek.xryxfnj.x570efc.x18dvir5.xxljpkc.x18pi947.xck4lzl.x1gluznb.xahwd2o.x10fiusa.x1a0bplq.xc995h1 > div,
      .xs1q97v.xh8yej3.x5yr21d.x2b8uid.x67bb7w.x6s0dn4.xl56j7k.x78zum5.xdt5ytf > div,
      .x78zum5.xdt5ytf.x5yr21d.x1o0tod.x6ikm8r.x10wlt62.x67bb7w.x10l6tqk.x13vifvy.xh8yej3.x1280gxy.xnpuxes.copyable-area > div {
        background-color: #000000 !important;
      }

      /* 17. Pitch Black Background directly applied to specific elements */
      .x9f619.x1n2onr6.xupqr0c.x5yr21d.x6ikm8r.x10wlt62.x17dzmu4.x1i1dayz,
      .x78zum5.xdt5ytf.x5yr21d.xyyilfv.xlkovuz.x1q80dvb.x2ipvbc.xjdofhw.x1iyjqo2,
      .x1rjt51p.x1280gxy.x1g83kfv.x3qq2k7.x2x8art.x1qor8vf.xl7twdi.xyo0t3i.xvg22vi.xb0esv5.x98l61r.xviac27.x1ua1l7f.xlese2p.x9f619.xg7h5cd,
      .xs1q97v.xh8yej3.x5yr21d.x2b8uid.x67bb7w.x6s0dn4.xl56j7k.x78zum5.xdt5ytf {
        background-color: #000000 !important;
      }

      /* 18. Force Pitch Black on all Main WhatsApp Containers */
      body, #app, .two, .three, #side, #main, header, footer, 
      [data-testid="conversation-panel-wrapper"],
      [data-testid="conversation-panel-messages"],
      [data-testid="chatlist-header"],
      [data-testid="search-container"] {
        background-color: #000000 !important;
      }

      /* 19. Custom Margin Override */
      .xevlxbw.x9f619.x1n2onr6.x5yr21d.x17dzmu4.x1i1dayz.x2ipvbc.xjdofhw.x78zum5.xdt5ytf.x570efc.x18dvir5.xxljpkc.x6ikm8r.x10wlt62.x1oy9qf3.xck4lzl.x1gluznb.xahwd2o.x10fiusa.x1a0bplq.xc995h1.xpilrb4.x1t7ytsu.x1vb5itz {
        margin-left: 0px !important;
      }

      /* 20. Custom Draggable Sidebar Width */
      :root {
        --custom-sidebar-width: 400px;
      }
      .two > div:has(#side),
      .three > div:has(#side),
      [data-testid="drawer-left"] {
        flex: 0 0 var(--custom-sidebar-width) !important;
        max-width: var(--custom-sidebar-width) !important;
        min-width: var(--custom-sidebar-width) !important;
      }
      #wa-custom-resizer {
        position: fixed;
        top: 0;
        bottom: 0;
        left: calc(var(--custom-sidebar-width) - 3px);
        width: 6px;
        cursor: ew-resize;
        z-index: 999999;
        background-color: transparent;
      }
      #wa-custom-resizer::after {
        content: '';
        position: absolute;
        top: 50%;
        left: 2px;
        width: 3px;
        height: 40px;
        background-color: transparent;
        border-radius: 4px;
        transform: translateY(-50%);
        transition: transform 0.1s, background-color 0.2s, height 0.2s;
      }
      #wa-custom-resizer:hover::after, #wa-custom-resizer.dragging::after {
        background-color: #00a884;
        height: 50px;
        transform: translateY(-50%) scaleX(1.5);
      }

      /* 21. Remove Right Padding from Chat List Rows */
      div.x78zum5.xdl72j9.xdt5ytf.x1iyjqo2.xl56j7k.xeuugli.x1n1b19v {
        padding-right: 0 !important;
      }
    `;
    document.head.appendChild(el);
  }

  function setupResponsiveTracker() {
    // Keep a lightweight poller purely to update the CSS variable for the icons
    setInterval(() => {
      const side = document.getElementById('side');
      if (side && side.parentElement) {
        document.documentElement.style.setProperty('--chatlist-width', side.parentElement.getBoundingClientRect().width + 'px');
      }
    }, 500);
  }

  function setupResizer() {
    if (document.getElementById('wa-custom-resizer')) return;

    const savedWidth = localStorage.getItem('wa-custom-sidebar-width') || '400';
    document.documentElement.style.setProperty('--custom-sidebar-width', savedWidth + 'px');

    const resizer = document.createElement('div');
    resizer.id = 'wa-custom-resizer';
    document.body.appendChild(resizer);

    let isDragging = false;

    resizer.addEventListener('mousedown', (e) => {
      isDragging = true;
      resizer.classList.add('dragging');
      document.body.style.cursor = 'ew-resize';
      document.body.style.userSelect = 'none';
      document.body.style.pointerEvents = 'none';
      e.stopPropagation();
    });

    window.addEventListener('mousemove', (e) => {
      if (!isDragging) return;
      let newWidth = e.clientX;
      if (newWidth < 250) newWidth = 250;
      if (newWidth > 1200) newWidth = 1200;
      document.documentElement.style.setProperty('--custom-sidebar-width', newWidth + 'px');
    }, { capture: true });

    window.addEventListener('mouseup', () => {
      if (isDragging) {
        isDragging = false;
        resizer.classList.remove('dragging');
        document.body.style.cursor = '';
        document.body.style.userSelect = '';
        document.body.style.pointerEvents = '';
        
        const currentWidth = document.documentElement.style.getPropertyValue('--custom-sidebar-width').replace('px', '');
        localStorage.setItem('wa-custom-sidebar-width', currentWidth);
      }
    }, { capture: true });
  }

  function waitForApp() {
    if (document.querySelector('[data-testid="navbar-primary-section"]')) {
      injectStyles();
      setupResponsiveTracker();
      setupResizer();
    } else {
      setTimeout(waitForApp, 500);
    }
  }

  if (document.readyState !== 'loading') {
    waitForApp();
  } else {
    document.addEventListener('DOMContentLoaded', waitForApp);
  }
})();
