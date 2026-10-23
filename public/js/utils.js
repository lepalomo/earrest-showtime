// ============================================================
// Small DOM/format utilities and dynamic style injection.
// Leaf module — depends on nothing else in the app.
// ============================================================

// Escape arbitrary text for safe insertion into innerHTML.
export function esc(str) {
  const el = document.createElement('span');
  el.textContent = str || '';
  return el.innerHTML;
}

// Format seconds as m:ss.
export function formatTime(s) {
  if (!s || isNaN(s)) return '0:00';
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  return `${m}:${sec.toString().padStart(2, '0')}`;
}

// Human-readable byte size.
export function formatBytes(bytes) {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
}

// Transient toast message in the bottom toast container.
export function toast(msg, type = 'info', duration = 3000) {
  const container = document.getElementById('toast-container');
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.textContent = msg;
  container.appendChild(el);
  setTimeout(() => { el.style.opacity = '0'; el.style.transition = 'opacity 0.3s'; setTimeout(() => el.remove(), 300); }, duration);
}

// Mounts a modal overlay. When the app is in element-level fullscreen
// (e.g. the setlist view), the browser only renders nodes inside the
// fullscreen element — anything appended to <body> stays invisible. So we
// append the overlay to the current fullscreen element when there is one,
// falling back to <body> otherwise.
export function mountOverlay(overlay) {
  const host = document.fullscreenElement || document.webkitFullscreenElement || document.body;
  host.appendChild(overlay);
  return overlay;
}

// Inject the app's dynamic styles (modals, key picker, beat-align, pitch gen).
// Called once at startup.
export function injectStyles() {
  const styleEl = document.createElement('style');
  styleEl.textContent = `
    .modal-overlay{position:fixed;inset:0;background:rgba(0,0,0,0.85);z-index:500;display:flex;align-items:center;justify-content:center;padding:1rem}
    .modal-box{background:var(--surface);border-radius:var(--radius);padding:1.5rem;max-width:320px;width:90vw;max-height:85vh;overflow-y:auto}
    .modal-box h3{font-size:1rem;margin-bottom:0.5rem}
    .modal-btn{padding:0.5rem 1rem;border-radius:8px;font-size:0.8rem;font-weight:600;min-height:44px;min-width:44px;display:inline-flex;align-items:center;justify-content:center}
    .modal-btn.confirm{background:var(--accent);color:#fff}
    .modal-btn.cancel{background:var(--surface-2);color:var(--text)}
    .modal-btn:active{opacity:0.7}
    /* Key picker */
    .key-picker-grid{display:grid;grid-template-columns:repeat(4,1fr);gap:0.4rem;margin:0.6rem 0}
    .key-picker-label{font-size:0.7rem;color:var(--text-muted);text-transform:uppercase;letter-spacing:0.04em;margin:0.5rem 0 0.1rem}
    .key-cell{min-height:44px;min-width:44px;display:inline-flex;align-items:center;justify-content:center;border-radius:8px;background:var(--surface-2);color:var(--text);font-size:0.85rem;font-weight:600;cursor:pointer;border:1px solid transparent}
    .key-cell:active{opacity:0.7}
    .key-cell.selected{background:var(--accent);color:#fff;border-color:var(--accent)}
    .np-title.editing{background:var(--surface-2);border-radius:6px;padding:0.2rem 0.5rem;outline:1px solid var(--accent)}
    #song-gain-value.adjusted{color:var(--accent)}
    .mixer-mobile .transport-btn[disabled]{opacity:0.3;pointer-events:none}
    /* Floating keyboard-shortcuts button (desktop only) */
    .kbd-fab{position:fixed;right:16px;bottom:16px;z-index:480;width:44px;height:44px;border-radius:12px;
      background:var(--surface-2);color:var(--text);border:1px solid rgba(255,255,255,0.12);
      display:none;align-items:center;justify-content:center;cursor:pointer;font-size:1.1rem;
      box-shadow:0 4px 14px rgba(0,0,0,0.35);transition:transform 0.12s,background 0.12s}
    .kbd-fab:hover{background:var(--surface);transform:translateY(-2px)}
    .kbd-fab:active{transform:translateY(0);opacity:0.8}
    .kbd-list{display:flex;flex-direction:column;gap:0.25rem}
    .kbd-row{display:flex;align-items:center;justify-content:space-between;gap:1rem;padding:0.35rem 0;border-bottom:1px solid var(--surface-2)}
    .kbd-row:last-child{border-bottom:none}
    .kbd-desc{font-size:0.8rem;color:var(--text)}
    .kbd-keys{display:flex;gap:0.25rem;flex-shrink:0}
    .kbd-key{font-family:ui-monospace,Menlo,Consolas,monospace;font-size:0.7rem;line-height:1;
      background:var(--surface-2);border:1px solid rgba(255,255,255,0.14);border-bottom-width:2px;
      border-radius:6px;padding:0.25rem 0.4rem;min-width:20px;text-align:center;color:var(--text)}
    /* Only show the floating button on desktop-sized screens */
    @media (min-width:1024px){ .kbd-fab{display:flex} }
    /* ===== Beat-align visual (waveform + click overlay) ===== */
    .beat-align-overlay{position:fixed;inset:0;background:rgba(0,0,0,0.92);z-index:600;display:flex;flex-direction:column;align-items:center;justify-content:center;padding:20px}
    .beat-align-header{display:flex;align-items:center;gap:12px;margin-bottom:16px;width:100%;max-width:800px;flex-wrap:wrap}
    .beat-align-header h3{color:var(--accent);font-size:0.95rem;flex:1;margin:0}
    .beat-align-header select{background:var(--surface);border:1px solid rgba(255,255,255,0.1);border-radius:8px;color:var(--text);padding:6px 10px;font-size:0.8rem;min-height:44px}
    .beat-align-header button{background:rgba(255,255,255,0.1);border:none;color:var(--text);padding:8px 14px;border-radius:8px;font-size:0.8rem;cursor:pointer;min-height:44px}
    .beat-align-header .beat-align-save{background:var(--accent);color:#fff}
    .beat-align-header .beat-align-play-btn{background:rgba(139,92,246,0.2);border:1px solid rgba(139,92,246,0.4);color:var(--accent);font-size:1rem;padding:6px 12px;border-radius:50%;width:44px;height:44px;display:flex;align-items:center;justify-content:center;cursor:pointer;transition:background 0.15s}
    .beat-align-header .beat-align-play-btn:active{background:rgba(139,92,246,0.4)}
    .beat-align-header .beat-align-play-btn.metro-on{background:rgba(245,158,11,0.25);border-color:rgba(245,158,11,0.6);color:#f59e0b}
    .beat-align-canvas-wrap{position:relative;width:100%;max-width:800px;min-height:200px;border-radius:8px;overflow:hidden;border:1px solid rgba(255,255,255,0.1);touch-action:none}
    .beat-align-canvas-wrap canvas{display:block;width:100%;height:200px;background:var(--bg)}
    .beat-align-info{display:flex;align-items:center;justify-content:center;gap:16px;margin-top:12px;font-size:0.8rem;color:var(--text-muted)}
    .beat-align-hint{font-size:0.72rem;color:var(--text-muted);opacity:0.7;margin-top:8px;text-align:center}
    @media (max-width:768px) and (orientation:portrait){
      .beat-align-overlay{padding:12px;justify-content:flex-start;padding-top:50px}
      .beat-align-canvas-wrap{flex:1;max-height:55vh;width:100%}
      .beat-align-canvas-wrap canvas{height:100%;width:100%}
      .beat-align-info{flex-wrap:wrap;gap:8px}
    }
    @media (max-width:768px) and (orientation:landscape){
      .beat-align-overlay{padding:10px 16px}
      .beat-align-header{margin-bottom:8px}
      .beat-align-canvas-wrap{max-height:50vh}
    }
    /* ===== Pitch generation control ===== */
    .pitch-gen-row{display:flex;align-items:center;gap:0.3rem;flex-wrap:wrap;padding:0.3rem 0}
    .pitch-gen-btn{min-height:36px;padding:0 0.5rem;border-radius:8px;background:var(--surface-2);color:var(--text);font-size:0.8rem;border:1px dashed var(--surface-3);cursor:pointer}
    .pitch-gen-btn:active{opacity:0.7}
    .pitch-gen-btn[disabled]{opacity:0.4;pointer-events:none}
    .tool-chip.generating{opacity:0.6;position:relative}
    .tool-chip.generating::after{content:'⟳';margin-left:0.25rem;display:inline-block;animation:pitch-spin 1s linear infinite}
    @keyframes pitch-spin{to{transform:rotate(360deg)}}
  `;
  document.head.appendChild(styleEl);
}
