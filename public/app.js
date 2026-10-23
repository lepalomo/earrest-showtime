// ============================================================
// EarRest Showtime — app.js (entry module)
// Offline-first player/presenter for music practice.
//
// Being migrated from a single IIFE into ES modules. Foundation modules
// (constants, state, utils, idb) are imported below; the remaining logic
// still lives in the IIFE and will be extracted incrementally.
// ============================================================
import {
  ICO, STEM_COLORS, STEM_ORDER, TOOLS_PAGES, KEYS_MAJOR, KEYS_MINOR,
  COLLAPSE_KEY, QUEUE_LS_KEY, SONG_GAIN_MIN, SONG_GAIN_MAX, PITCH_RANGE
} from './js/constants.js';
import { state, tap } from './js/state.js';
import { esc, formatTime, formatBytes, toast, mountOverlay, injectStyles } from './js/utils.js';
import { openDB, idbGetAll, idbPut, idbDelete, idbAdd } from './js/idb.js';

(() => {
  'use strict';

  // Inject dynamic styles (modals, key picker, beat-align, pitch gen).
  injectStyles();

  // ============================================================
  // Pending Edits & Sync
  // ============================================================
  async function addPendingEdit(type, songId, value) {
    await idbAdd('pendingEdits', { type, songId, value, ts: Date.now() });
    if (state.isOnline) flushPendingEdits();
  }

  async function flushPendingEdits() {
    if (!state.isOnline) return;
    let edits;
    try { edits = await idbGetAll('pendingEdits'); } catch { return; }
    if (!edits || edits.length === 0) return;
    try {
      const res = await fetch('/api/sync', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ edits })
      });
      if (res.ok) {
        const tx = state.idb.transaction('pendingEdits', 'readwrite');
        tx.objectStore('pendingEdits').clear();
        await new Promise((resolve, reject) => { tx.oncomplete = resolve; tx.onerror = reject; });
      }
    } catch (e) { console.warn('Sync failed:', e); }
  }

  // ============================================================
  // Setlist notes sync (cross-device)
  // Setlist notes are a Showtime-only concept and are persisted on the
  // server (JSON file in the Stemizer data dir) keyed by playlist. Each note
  // carries a stable `noteId` so it stays consistent across devices even
  // though the local IndexedDB `id` (auto-increment) differs per device.
  // ============================================================
  function genNoteId() {
    if (crypto.randomUUID) return crypto.randomUUID();
    return 'n-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
  }

  // Push the full note set for a playlist to the server. Offline-safe: if the
  // request fails, the local IndexedDB copy is still the source of truth and
  // the push will be retried on the next change / reconnect.
  async function pushSetlistNotes(playlistId) {
    if (!playlistId || !state.isOnline) return;
    const notes = state.setlistNotes
      .filter(n => n.playlist_id === playlistId)
      .map(n => ({ noteId: n.noteId, position: n.position, text: n.text }));
    try {
      await fetch('/api/setlist-notes', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ playlistId, notes })
      });
    } catch (e) { console.warn('Setlist notes push failed:', e); }
  }

  // Pull setlist notes from the server and merge into IndexedDB, keyed by
  // stable noteId. Server is treated as the shared source of truth: notes
  // present on the server are upserted locally; local notes for a synced
  // playlist that no longer exist on the server are removed.
  async function pullSetlistNotes() {
    if (!state.isOnline) return;
    let serverNotes;
    try {
      const res = await fetch('/api/setlist-notes');
      if (!res.ok) return;
      serverNotes = (await res.json()).notes || {};
    } catch { return; }

    for (const playlistId of Object.keys(serverNotes)) {
      const incoming = serverNotes[playlistId] || [];
      const incomingIds = new Set(incoming.map(n => n.noteId));
      const localForPl = state.setlistNotes.filter(n => n.playlist_id === playlistId);

      // Upsert incoming notes
      for (const sn of incoming) {
        if (!sn.noteId) continue;
        const existing = localForPl.find(n => n.noteId === sn.noteId);
        if (existing) {
          existing.text = sn.text;
          existing.position = sn.position;
          await idbPut('setlistNotes', existing);
        } else {
          const note = { playlist_id: playlistId, position: sn.position, text: sn.text, noteId: sn.noteId };
          const id = await idbAdd('setlistNotes', note);
          note.id = id;
          state.setlistNotes.push(note);
        }
      }

      // Remove local notes that were deleted on the server
      for (const ln of localForPl) {
        if (ln.noteId && !incomingIds.has(ln.noteId)) {
          await idbDelete('setlistNotes', ln.id);
          state.setlistNotes = state.setlistNotes.filter(n => n.id !== ln.id);
        }
      }
    }
  }

  // ============================================================
  // Connectivity
  // ============================================================
  async function checkConnection() {
    try {
      const res = await fetch('/api/ping', { cache: 'no-store' });
      const data = await res.json();
      return data.ok === true;
    } catch { return false; }
  }

  function setOnlineStatus(online) {
    state.isOnline = online;
    document.getElementById('offline-badge').classList.toggle('visible', !online);
  }

  // ============================================================
  // Data Loading
  // ============================================================
  async function loadLocalData() {
    state.playlists = await idbGetAll('playlists');
    state.songs = await idbGetAll('songs');
    state.playlistSongs = await idbGetAll('playlistSongs');
    try { state.setlistNotes = await idbGetAll('setlistNotes'); } catch { state.setlistNotes = []; }
    // Backfill stable noteIds on legacy notes created before cross-device sync.
    for (const n of state.setlistNotes) {
      if (!n.noteId) {
        n.noteId = genNoteId();
        try { await idbPut('setlistNotes', n); } catch {}
      }
    }
    state.playlists.sort((a, b) => (a.position || 0) - (b.position || 0));
  }

  // ============================================================
  // Library View
  // ============================================================
  function renderLibrary() {
    const container = document.getElementById('library-content');

    if (state.currentPlaylistId) {
      const pl = state.playlists.find(p => p.id === state.currentPlaylistId);
      const songIds = state.playlistSongs
        .filter(ps => ps.playlist_id === state.currentPlaylistId)
        .sort((a, b) => (a.position || 0) - (b.position || 0))
        .map(ps => ps.song_id);
      const songs = songIds.map(id => state.songs.find(s => s.id === id)).filter(Boolean);

      let html = `<button class="back-btn" id="lib-back">← Voltar</button>`;
      html += `<div class="section-title">${esc(pl?.title || 'Playlist')} (${songs.length})</div>`;
      html += `<div class="playlist-actions">
        <button class="pl-action-btn" id="pl-play-all" title="Tocar em sequência">▶ Tocar</button>
        <button class="pl-action-btn" id="pl-shuffle" title="Tocar em ordem aleatória">🔀 Shuffle</button>
      </div>`;
      html += '<div class="song-list">';
      for (const s of songs) {
        const playing = s.id === state.currentSongId;
        html += `
          <div class="song-item ${playing ? 'now-playing' : ''}" data-song-id="${s.id}">
            <div class="s-info">
              <div class="s-title">${esc(s.title)}</div>
              <div class="s-artist">${esc(s.artist || '')}</div>
            </div>
            ${s.bpm ? `<div class="s-bpm">${s.bpm} bpm</div>` : ''}
            <button class="s-menu" data-song-menu="${s.id}" title="Opções" aria-label="Opções da música">⋯</button>
          </div>`;
      }
      html += '</div>';
      container.innerHTML = html;
      return;
    }

    if (state.playlists.length === 0 && state.songs.length === 0) {
      container.innerHTML = `<div class="empty-state">${ICO.download}<h3>Nenhuma música offline</h3><p>Conecte ao servidor e baixe músicas na aba Sync.</p></div>`;
      return;
    }

    let html = '';
    if (state.playlists.length > 0) {
      html += '<div class="section-title">Setlists / Playlists</div><div class="playlists-grid">';
      for (const pl of state.playlists) {
        const count = state.playlistSongs.filter(ps => ps.playlist_id === pl.id).length;
        html += `
          <div class="playlist-card" data-playlist-id="${pl.id}">
            <div class="pl-icon">${ICO.music}</div>
            <div class="info">
              <div class="name">${esc(pl.title)}</div>
              <div class="count">${count} música${count !== 1 ? 's' : ''}</div>
            </div>
            <button class="s-menu" data-playlist-menu="${pl.id}" title="Opções" aria-label="Opções da playlist">⋯</button>
            <div class="arrow">›</div>
          </div>`;
      }
      html += '</div>';
    }

    if (state.songs.length > 0) {
      html += `<div class="section-title">Todas (${state.songs.length})</div><div class="song-list">`;
      const sorted = [...state.songs].sort((a, b) => (a.title || '').localeCompare(b.title || ''));
      for (const s of sorted) {
        const playing = s.id === state.currentSongId;
        html += `
          <div class="song-item ${playing ? 'now-playing' : ''}" data-song-id="${s.id}">
            <div class="s-info">
              <div class="s-title">${esc(s.title)}</div>
              <div class="s-artist">${esc(s.artist || '')}</div>
            </div>
            ${s.bpm ? `<div class="s-bpm">${s.bpm}</div>` : ''}
            <button class="s-menu" data-song-menu="${s.id}" title="Opções" aria-label="Opções da música">⋯</button>
          </div>`;
      }
      html += '</div>';
    }

    container.innerHTML = html;
  }

  // ============================================================
  // Audio Core
  // ============================================================
  function initAudioCtx() {
    if (state.audioCtx) return;
    state.audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    state.masterGain = state.audioCtx.createGain();
    state.masterGain.connect(state.audioCtx.destination);
  }

  // Resume the AudioContext, retrying briefly. When the screen is off and the
  // OS media controls trigger a track change, a freshly built audio graph can
  // start with a suspended/interrupted context — the <audio> elements advance
  // (Media Session shows progress) but no sound reaches the speakers because
  // the suspended context doesn't process the graph. This is the "playing but
  // muted until I unlock the phone" bug. Retrying resume recovers it without a
  // manual unlock.
  async function resumeAudioCtx(retries = 5) {
    if (!state.audioCtx) return;
    for (let i = 0; i < retries; i++) {
      if (state.audioCtx.state === 'running') return;
      try { await state.audioCtx.resume(); } catch (e) { /* ignore */ }
      if (state.audioCtx.state === 'running') return;
      await new Promise(r => setTimeout(r, 150));
    }
  }

  // Get (or lazily create) a persistent pool entry for a stem name.
  // The MediaElementSource is created only once per element, here — never
  // during a background track change. Subsequent songs just swap audio.src.
  function getPoolEntry(name) {
    let entry = state.audioPool[name];
    if (entry) return entry;
    initAudioCtx();
    const audio = new Audio();
    audio.preload = 'auto';
    audio.crossOrigin = 'anonymous';
    audio.preservesPitch = true;
    const source = state.audioCtx.createMediaElementSource(audio);
    const gain = state.audioCtx.createGain();
    source.connect(gain);
    gain.connect(state.masterGain);
    entry = { audio, source, gain };
    state.audioPool[name] = entry;
    return entry;
  }

  // Pre-build the whole pool up front (foregrounded) so no MediaElementSource
  // has to be created later during a locked-screen track change.
  function warmAudioPool() {
    initAudioCtx();
    for (const name of STEM_ORDER) getPoolEntry(name);
  }

  async function loadSong(songId, opts = {}) {
    const { navigate = true } = opts;
    const loadId = ++state._loadId;
    stopPlayback();
    cleanupAudio();
    state._stemReady = false;

    const song = state.songs.find(s => s.id === songId);
    if (!song) return;

    state.currentSongId = songId;
    state.currentSong = song;
    // Keep the queue index aligned with whatever song is actually loaded so
    // next/prev and the "Tocando agora" highlight stay correct even when a
    // song is started outside the normal next/prev flow.
    {
      const qi = state.queue.indexOf(songId);
      if (qi !== -1) state.queueIndex = qi;
    }
    state.chords = song.chords || [];
    state.notes = song.notes || [];
    state.bpm = song.bpm;
    state.beatOffset = song.beatOffset || 0;
    state.bpmSections = song.bpmSections || [];
    state.originalKey = song.originalKey;
    state.songGain = (typeof song.gain === 'number' && song.gain > 0) ? song.gain : 1;
    state.pitches = song.pitches || [0];
    state.currentPitch = 0;
    state.pausedAt = 0;
    state._lastChordIdx = -1;
    state._lastNoteIdx = -1;
    state._mixerStemIdx = 0;

    loadSongSettings(songId);
    renderPlayer();
    if (navigate) switchView('player-view');

    if (!song.stems || Object.keys(song.stems).length === 0) return;

    initAudioCtx();
    await resumeAudioCtx();
    // Pre-build every stem's graph node now (we're foregrounded during the
    // first load) so a later locked-screen track change never has to create a
    // MediaElementSource in the background.
    if (!state._hidden) warmAudioPool();

    const stemEntries = Object.entries(song.stems).sort((a, b) => {
      const ia = STEM_ORDER.indexOf(a[0]);
      const ib = STEM_ORDER.indexOf(b[0]);
      return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib);
    });

    // Show loading UI
    renderLoadingState(stemEntries.map(([n]) => n));

    state.stems = {};
    // Reuse the persistent audio pool: swap src on existing elements instead of
    // creating new MediaElementSource nodes (unreliable when screen is locked).
    const activeNames = stemEntries.map(([n]) => n);
    for (const [name, url] of stemEntries) {
      if (loadId !== state._loadId) return;
      const entry = getPoolEntry(name);
      const pitchedUrl = getPitchedUrl(url, state.currentPitch);
      // Only reassign src when it actually changed, to avoid a needless reload.
      if (entry.audio.src !== new URL(pitchedUrl, location.href).href) {
        entry.audio.src = pitchedUrl;
      }
      entry.audio.playbackRate = state.speed;
      entry.audio.currentTime = 0;
      // Start muted; updateGains() below applies the real levels once ready.
      entry.gain.gain.value = 0;

      state.audioEls[name] = entry.audio;
      state.gainNodes[name] = entry.gain;
      state.sourceNodes[name] = entry.source;
      state.stems[name] = url;
    }
    // Silence + detach any pooled stems NOT used by this song.
    for (const [name, entry] of Object.entries(state.audioPool)) {
      if (activeNames.indexOf(name) === -1) {
        try { entry.audio.pause(); } catch (e) {}
        entry.gain.gain.value = 0;
        if (entry.audio.src) entry.audio.removeAttribute('src'), entry.audio.load();
      }
    }

    await waitForBufferingWithProgress(loadId, stemEntries.map(([n]) => n));
    if (loadId !== state._loadId) return;

    state.duration = Math.max(0, ...Object.values(state.audioEls).map(a => a.duration || 0));
    // If metadata for duration isn't ready yet, wait briefly for it so the
    // boundary checker doesn't see a bogus (near-zero) duration and skip ahead.
    if (!(state.duration > 1)) {
      state.duration = await waitForDuration(loadId);
      if (loadId !== state._loadId) return;
    }
    document.getElementById('time-total') && (document.getElementById('time-total').textContent = formatTime(state.duration));

    state._stemReady = true;
    updateGains();
    renderMixer();
    updateTimeline();
    renderLoopUI();
    renderTrimUI();
    renderLibrary();
    renderQueue();

    hideLoadingState();

    // Auto-play immediately — never block playback on waveform generation.
    startPlayback();

    // Generate + draw waveforms in the background (non-blocking), but robustly:
    // waits for layout and retries fetch/decode so it reliably appears. A hang
    // or failure here must never prevent the song from playing.
    const wfStatus = document.getElementById('waveform-load-status');
    if (wfStatus) { wfStatus.style.display = 'none'; }
    renderTimelineWaveform(loadId).catch(() => {});
  }

  function renderLoadingState(stemNames) {
    const container = document.getElementById('loading-stems');
    if (!container) return;
    let html = `<div style="padding:0.8rem 1rem">
      <div style="font-size:0.75rem;color:var(--text-muted);margin-bottom:0.5rem;text-transform:uppercase;letter-spacing:0.04em">Carregando stems</div>`;
    for (const name of stemNames) {
      const color = STEM_COLORS[name] || '#666';
      html += `<div class="stem-load-row" data-stem-load="${name}" style="display:flex;align-items:center;gap:0.5rem;margin-bottom:0.3rem">
        <div style="width:4px;height:16px;border-radius:2px;background:${color}"></div>
        <span style="font-size:0.7rem;min-width:55px;text-transform:capitalize;color:var(--text-muted)">${name}</span>
        <div style="flex:1;height:4px;background:var(--surface-2);border-radius:2px;overflow:hidden">
          <div class="stem-load-bar" style="width:0%;height:100%;background:${color};border-radius:2px;transition:width 0.2s"></div>
        </div>
        <span class="stem-load-status" style="font-size:0.6rem;color:var(--text-muted);min-width:40px;text-align:right">0%</span>
      </div>`;
    }
    html += '</div>';
    html += `<div id="waveform-load-status" style="padding:0 1rem 0.6rem;font-size:0.6rem;color:var(--text-muted);display:none"></div>`;
    container.innerHTML = html;
    container.style.display = 'block';

    // Disable play button
    const playBtn = document.getElementById('play-btn');
    if (playBtn) { playBtn.style.opacity = '0.3'; playBtn.style.pointerEvents = 'none'; }
  }

  function updateStemLoadProgress(name, pct, status) {
    const row = document.querySelector(`[data-stem-load="${name}"]`);
    if (!row) return;
    const bar = row.querySelector('.stem-load-bar');
    const label = row.querySelector('.stem-load-status');
    if (bar) bar.style.width = pct + '%';
    if (label) label.textContent = status || (pct + '%');
  }

  function hideLoadingState() {
    const container = document.getElementById('loading-stems');
    if (container) container.style.display = 'none';
    // Enable play button
    const playBtn = document.getElementById('play-btn');
    if (playBtn) { playBtn.style.opacity = '1'; playBtn.style.pointerEvents = 'auto'; }
  }

  // Wait until at least one stem reports a usable duration (metadata loaded),
  // or give up after ~2s and return the best value we have.
  function waitForDuration(loadId, maxWaitMs = 2000) {
    return new Promise(resolve => {
      const start = performance.now();
      const tick = () => {
        if (loadId !== state._loadId) return resolve(0);
        const d = Math.max(0, ...Object.values(state.audioEls).map(a => a.duration || 0));
        if (d > 1 || performance.now() - start > maxWaitMs) return resolve(d);
        setTimeout(tick, 100);
      };
      tick();
    });
  }

  function waitForBufferingWithProgress(loadId, stemNames) {
    return new Promise(resolve => {
      let checks = 0;
      const check = () => {
        if (loadId !== state._loadId) return resolve();

        let allReady = true;
        for (const name of stemNames) {
          const audio = state.audioEls[name];
          if (!audio) continue;
          const rs = audio.readyState;
          if (rs >= 3) {
            // HAVE_FUTURE_DATA or HAVE_ENOUGH_DATA
            updateStemLoadProgress(name, 100, '✓');
          } else if (rs >= 2) {
            // HAVE_CURRENT_DATA
            updateStemLoadProgress(name, 80, '80%');
            allReady = false;
          } else if (audio.buffered.length > 0 && audio.duration > 0) {
            const bufferedEnd = audio.buffered.end(audio.buffered.length - 1);
            const pct = Math.min(95, Math.round((bufferedEnd / audio.duration) * 100));
            updateStemLoadProgress(name, pct, pct + '%');
            allReady = false;
          } else if (audio.error) {
            updateStemLoadProgress(name, 100, 'erro');
          } else {
            // Still loading metadata
            const pct = Math.min(30, checks * 5);
            updateStemLoadProgress(name, pct, 'carregando');
            allReady = false;
          }
        }

        if (allReady || checks > 50) return resolve();
        checks++;
        setTimeout(check, 200);
      };
      check();
    });
  }

  // Map a stem's original URL (/stems/<id>/<file>) to its pitch-shifted variant
  // (/stems/<id>/pitch_+N/<file>). The sign is always included to match the
  // directory names the Stemizer worker creates (pitch_+2, pitch_-3, ...).
  function getPitchedUrl(originalUrl, semitones) {
    const n = parseInt(semitones);
    if (!n || n === 0) return originalUrl;
    const dir = `pitch_${n > 0 ? '+' : ''}${n}`;
    // Insert the pitch dir right before the final filename segment.
    return originalUrl.replace(/\/stems\/([^/]+)\/(?!.*\/)/, `/stems/$1/${dir}/`);
  }

  function cleanupAudio() {
    // Pause the currently-active stems and drop their gain, but KEEP the
    // persistent pool (audio elements + MediaElementSource nodes) alive so the
    // next song can reuse them without rebuilding the graph in the background.
    for (const name of Object.keys(state.audioEls)) {
      const entry = state.audioPool[name];
      if (entry) {
        try { entry.audio.pause(); } catch (e) {}
        entry.gain.gain.value = 0;
      }
    }
    state.audioEls = {};
    state.gainNodes = {};
    state.sourceNodes = {};
    state.stems = {};
    state.muted.clear();
    state.soloed.clear();
    state.volumes = {};
  }

  function startPlayback(offset) {
    if (!state.audioCtx || Object.keys(state.audioEls).length === 0) return;
    // Kick off a robust resume (retries). Critically, resume again AFTER the
    // elements start playing — a context can re-suspend during a background
    // track change, leaving audio silent until the screen is unlocked.
    resumeAudioCtx();

    const t = offset ?? state.pausedAt ?? 0;
    const startT = (state.trimBefore && t < state.trimBefore) ? state.trimBefore : t;

    // Sync all stems to exact same position before playing
    const audios = Object.values(state.audioEls);
    for (const audio of audios) {
      audio.currentTime = startT;
      audio.playbackRate = state.speed;
    }

    // Wait for all seeks to settle, then play simultaneously
    let seeked = 0;
    const total = audios.length;
    const onSeeked = () => {
      seeked++;
      if (seeked >= total) {
        // All at same position — play all at once
        for (const a of audios) a.play().catch(() => {});
        // Ensure the graph is actually running after play() — recovers the
        // "muted in background" case on OS-driven track changes.
        resumeAudioCtx();
        state.isPlaying = true;
        state.pausedAt = startT;
        startAnimLoop();
        startBoundaryChecker();
        if (state.metronome.enabled) startMetronomeTicking();
        updateTransportBtn();
        updateMediaSession();
      }
    };

    for (const audio of audios) {
      audio.addEventListener('seeked', onSeeked, { once: true });
    }

    // Safety: if seeked events don't fire within 500ms, force play anyway
    setTimeout(() => {
      if (!state.isPlaying && seeked < total) {
        for (const a of audios) {
          a.removeEventListener('seeked', onSeeked);
          a.play().catch(() => {});
        }
        resumeAudioCtx();
        state.isPlaying = true;
        state.pausedAt = startT;
        startAnimLoop();
        startBoundaryChecker();
        if (state.metronome.enabled) startMetronomeTicking();
        updateTransportBtn();
        updateMediaSession();
      }
    }, 500);
  }

  function stopPlayback() {
    if (!state.isPlaying) return;
    const ref = Object.values(state.audioEls)[0];
    if (ref) state.pausedAt = ref.currentTime;

    for (const audio of Object.values(state.audioEls)) audio.pause();

    state.isPlaying = false;
    stopAnimLoop();
    stopBoundaryChecker();
    stopMetronome();
    updateTransportBtn();
    updateMediaSession();
  }

  function togglePlay() {
    if (!state._stemReady) return; // stems still loading
    if (state.isPlaying) stopPlayback();
    else startPlayback();
  }

  function seekTo(t) {
    t = Math.max(0, Math.min(t, state.duration));
    state.pausedAt = t;
    state._lastChordIdx = -1;
    state._lastNoteIdx = -1;
    for (const audio of Object.values(state.audioEls)) audio.currentTime = t;
    updateTimeline();
  }

  function getCurrentTime() {
    const ref = Object.values(state.audioEls)[0];
    return ref ? ref.currentTime : state.pausedAt;
  }

  // ============================================================
  // Gains / Mute / Solo
  // ============================================================
  function updateGains() {
    const hasSolo = state.soloed.size > 0;
    const sg = state.songGain;
    const songGain = (typeof sg === 'number' && isFinite(sg) && sg > 0) ? sg : 1;
    const mv = (state.masterMuted ? 0 : state.masterVolume) * songGain;
    for (const [name, gain] of Object.entries(state.gainNodes)) {
      let vol = state.volumes[name] ?? 1;
      if (state.muted.has(name)) vol = 0;
      else if (hasSolo && !state.soloed.has(name) && name !== 'notes') vol = 0;
      gain.gain.value = vol * mv;
    }
  }

  function toggleMute(name) {
    if (state.muted.has(name)) state.muted.delete(name);
    else state.muted.add(name);
    onMixChanged();
  }

  function toggleSolo(name) {
    if (state.soloed.has(name)) state.soloed.delete(name);
    else state.soloed.add(name);
    onMixChanged();
  }

  function setVolume(name, val) {
    state.volumes[name] = val;
    updateGains();
    savePlaylistSettings();
  }

  function setMasterVolume(val) {
    state.masterVolume = val;
    state.masterMuted = false;
    if (state.masterGain) state.masterGain.gain.value = val;
    updateGains();
  }

  function toggleMasterMute() {
    if (state.masterMuted) {
      state.masterMuted = false;
      state.masterVolume = state._lastMasterVol || 1;
    } else {
      state._lastMasterVol = state.masterVolume;
      state.masterMuted = true;
    }
    updateGains();
    const btn = document.getElementById('master-mute-btn');
    if (btn) btn.classList.toggle('active', state.masterMuted);
    const slider = document.getElementById('master-vol-slider');
    if (slider) slider.value = state.masterMuted ? 0 : Math.round(state.masterVolume * 100);
  }

  // Per-song gain: adjust in ±10% steps to level a song that sounds quieter
  // (or louder) than the rest of the playlist. Applied on top of master volume
  // in updateGains(). Persisted per-song and synced to the server so it
  // survives stem reprocessing (stored in chords.json, kept by the worker).
  // SONG_GAIN_MIN / SONG_GAIN_MAX imported from constants.js
  function adjustSongGain(deltaPct) {
    if (!state.currentSongId) return;
    let g = (state.songGain || 1) + deltaPct / 100;
    g = Math.round(g * 100) / 100; // avoid float drift
    g = Math.max(SONG_GAIN_MIN, Math.min(SONG_GAIN_MAX, g));
    state.songGain = g;
    updateGains();
    renderSongGain();
    persistSongGain();
  }

  function resetSongGain() {
    if (!state.currentSongId) return;
    state.songGain = 1;
    updateGains();
    renderSongGain();
    persistSongGain();
  }

  function persistSongGain() {
    saveSongSettings();
    if (state.currentSong) state.currentSong.gain = state.songGain;
    addPendingEdit('gain', state.currentSongId, state.songGain);
  }

  function renderSongGain() {
    const el = document.getElementById('song-gain-value');
    if (el) {
      const pct = Math.round((state.songGain || 1) * 100);
      el.textContent = pct + '%';
      el.classList.toggle('adjusted', pct !== 100);
    }
  }

  // ============================================================
  // Metronome
  // ============================================================
  function createMetronomeClick(time) {
    if (!state.audioCtx) return;
    const ctx = state.audioCtx;
    const osc = ctx.createOscillator();
    const g = ctx.createGain();
    osc.connect(g);
    g.connect(ctx.destination);

    const sound = state.metronome.sound;
    if (sound === 'wood') { osc.frequency.setValueAtTime(600, time); osc.frequency.exponentialRampToValueAtTime(300, time + 0.05); }
    else if (sound === 'cowbell') { osc.frequency.setValueAtTime(800, time); }
    else if (sound === 'beat') { osc.frequency.setValueAtTime(440, time); osc.frequency.exponentialRampToValueAtTime(220, time + 0.06); }
    else { osc.frequency.setValueAtTime(1000, time); osc.frequency.exponentialRampToValueAtTime(500, time + 0.05); }

    g.gain.setValueAtTime(state.metronome.volume, time);
    g.gain.exponentialRampToValueAtTime(0.001, time + 0.08);
    osc.start(time);
    osc.stop(time + 0.1);
  }

  function startMetronomeTicking() {
    stopMetronome();
    if (!state.bpm || !state.audioCtx) return;

    const ctx = state.audioCtx;
    const bpm = getActiveBpm();
    const speed = state.speed || 1;
    // Beat interval in MEDIA time (1x). state.beatOffset and getCurrentTime()
    // are also in media time, so all phase math stays in the same units.
    const beatMedia = 60 / bpm;
    // Same interval expressed in REAL/clock time (AudioContext seconds).
    const beatReal = beatMedia / speed;

    const now = ctx.currentTime;
    const songTime = getCurrentTime();               // media time
    const offset = ((state.beatOffset % beatMedia) + beatMedia) % beatMedia;
    // How far (in media time) until the next beat boundary after songTime.
    let mediaToNext = offset - (songTime % beatMedia);
    if (mediaToNext < 0) mediaToNext += beatMedia;
    // Convert the media-time wait into real time for scheduling.
    state.metronome.nextBeatTime = now + mediaToNext / speed;

    state.metronome.intervalId = setInterval(() => {
      const ctxNow = ctx.currentTime;
      while (state.metronome.nextBeatTime < ctxNow + 0.1) {
        if (state.metronome.nextBeatTime >= ctxNow) {
          createMetronomeClick(state.metronome.nextBeatTime);
        }
        state.metronome.nextBeatTime += beatReal;
      }
    }, 25);
  }

  function stopMetronome() {
    if (state.metronome.intervalId) {
      clearInterval(state.metronome.intervalId);
      state.metronome.intervalId = null;
    }
  }

  function toggleMetronome() {
    state.metronome.enabled = !state.metronome.enabled;
    if (state.metronome.enabled && state.isPlaying) startMetronomeTicking();
    else stopMetronome();
    savePlaylistSettings();
  }

  function getActiveBpm() {
    if (state.bpmSections && state.bpmSections.length > 0) {
      const t = getCurrentTime();
      for (let i = state.bpmSections.length - 1; i >= 0; i--) {
        if (t >= (state.bpmSections[i].from || 0)) return state.bpmSections[i].bpm;
      }
    }
    return state.bpm || 120;
  }

  // ============================================================
  // Tap Tempo
  // ============================================================
  // Convert a performance.now() timestamp into the corresponding song position
  // (in media time, i.e. at 1x). Uses the position sampled at tap time and
  // projects forward by the elapsed real time scaled by playback speed. If the
  // song is paused, the position doesn't advance.
  function songPositionAt(perfTs) {
    if (!tap.posSample) return getCurrentTime();
    const { perf, songPos, playing, speed } = tap.posSample;
    if (!playing) return songPos;
    const elapsedSec = (perfTs - perf) / 1000; // real seconds
    return songPos + elapsedSec * speed;       // media seconds advanced
  }

  function handleTapTempo() {
    const now = performance.now();
    // Sample the song position paired with this exact tap timestamp, so the
    // beat phase can be anchored precisely to when the user tapped.
    tap.posSample = { perf: now, songPos: getCurrentTime(), playing: state.isPlaying, speed: state.speed || 1 };
    tap.times.push(now);
    if (tap.times.length > 5) tap.times.shift();
    clearTimeout(tap.timeout);

    if (tap.times.length >= 2) {
      const intervals = [];
      for (let i = 1; i < tap.times.length; i++) intervals.push(tap.times[i] - tap.times[i - 1]);
      const avg = intervals.reduce((a, b) => a + b, 0) / intervals.length;

      // The user taps along with the audio as it plays. If the song is playing
      // at a reduced/increased speed, the tapped interval is in *playback* time,
      // so we divide by state.speed to recover the song's real BPM. This way the
      // metronome always follows the playback regardless of the configured speed.
      const speed = state.speed || 1;
      const bpm = Math.round(60000 / avg / speed);
      state.bpm = bpm;

      // Anchor the beat phase on the LAST tap: convert the tap's real timestamp
      // to a song position, then reduce it into a single beat interval so the
      // metronome doesn't start "from the middle of the song".
      const beatInterval = 60 / bpm; // in media time (1x)
      const songPosAtTap = songPositionAt(now);
      state.beatOffset = ((songPosAtTap % beatInterval) + beatInterval) % beatInterval;

      updateBpmDisplay();
      if (state.metronome.enabled && state.isPlaying) startMetronomeTicking();
    }

    tap.timeout = setTimeout(() => {
      if (state.bpm && state.currentSongId) {
        state.currentSong.bpm = state.bpm;
        state.currentSong.beatOffset = state.beatOffset;
        idbPut('songs', state.currentSong);
        addPendingEdit('bpm', state.currentSongId, { bpm: state.bpm, beatOffset: state.beatOffset });
        saveSongSettings();
      }
      tap.times.length = 0;
    }, 2000);
  }

  function updateBpmDisplay() {
    const el = document.getElementById('bpm-display');
    if (el) el.textContent = state.bpm ? state.bpm + ' bpm' : '—';
  }

  // ============================================================
  // Beat Alignment Modal — visual waveform + click overlay.
  // Shows the waveform of a chosen stem (drums by default) with the metronome
  // click envelope drawn on each beat, so the user can drag to align the beat
  // grid with the audio's attacks. Works while playing or paused.
  // ============================================================
  function showBeatAlignModal() {
    if (Object.keys(state.audioEls || {}).length === 0) { toast('Nenhuma música carregada'); return; }
    if (!getActiveBpm()) { toast('BPM necessário para alinhar'); return; }

    const overlay = document.createElement('div');
    overlay.className = 'beat-align-overlay';

    const stemNames = Object.keys(state.audioEls || {}).filter(n => n !== 'notes');
    const defaultStem = stemNames.includes('drums') ? 'drums' : (stemNames[0] || '');

    overlay.innerHTML = `
      <div class="beat-align-header">
        <h3>⊿ Alinhar Beat</h3>
        <button id="beatAlignPlay" class="beat-align-play-btn" title="Reproduzir / Pausar">▶</button>
        <button id="beatAlignMetro" class="beat-align-play-btn${state.metronome.enabled ? ' metro-on' : ''}" title="Metrônomo on/off">♩</button>
        <select id="beatAlignStem" aria-label="Stem de referência">
          ${stemNames.map(s => `<option value="${esc(s)}" ${s === defaultStem ? 'selected' : ''}>${esc(s)}</option>`).join('')}
        </select>
        <button id="beatAlignClose">Fechar</button>
        <button id="beatAlignSave" class="beat-align-save">Salvar</button>
      </div>
      <div class="beat-align-canvas-wrap" id="beatAlignWrap">
        <canvas id="beatAlignCanvas"></canvas>
      </div>
      <div class="beat-align-info">
        <span>Offset: <input type="number" id="beatAlignOffset" value="${Math.round(state.beatOffset * 1000)}" step="10" style="width:70px;text-align:center;background:var(--bg);border:1px solid rgba(255,255,255,0.2);border-radius:4px;color:var(--accent);font-family:monospace;font-size:0.8rem;padding:3px 6px">ms</span>
        <span>BPM: <input type="number" id="beatAlignBpm" value="${getActiveBpm()}" min="20" max="300" step="1" style="width:60px;text-align:center;background:var(--bg);border:1px solid rgba(255,255,255,0.2);border-radius:4px;color:var(--accent);font-family:monospace;font-size:0.8rem;padding:3px 6px"></span>
      </div>
      <div class="beat-align-hint">Arraste para alinhar as linhas de beat com os ataques da bateria</div>
    `;
    mountOverlay(overlay);

    let modalPlaying = false; // always start paused so the user aligns visually first
    if (state.isPlaying) {
      state.pausedAt = getCurrentTime();
      stopPlayback();
    }

    const canvas = document.getElementById('beatAlignCanvas');
    const wrap = document.getElementById('beatAlignWrap');
    const ctx = canvas.getContext('2d');
    let waveformData = null;
    let currentOffset = state.beatOffset;
    let viewCenter = getCurrentTime();
    const viewDuration = 8; // seconds visible
    let isPortrait = false;
    let clickWaveform = null;

    function resizeCanvas() {
      const rect = wrap.getBoundingClientRect();
      isPortrait = window.matchMedia('(max-width: 768px) and (orientation: portrait)').matches;
      const w = rect.width || wrap.clientWidth || 600;
      const h = isPortrait ? Math.min(rect.height || wrap.clientHeight || 400, 400) : 200;
      canvas.width = w * window.devicePixelRatio;
      canvas.height = h * window.devicePixelRatio;
      canvas.style.width = `${w}px`;
      canvas.style.height = `${h}px`;
      const hint = overlay.querySelector('.beat-align-hint');
      if (hint) hint.textContent = isPortrait
        ? 'Arraste verticalmente para alinhar os beats com os ataques'
        : 'Arraste horizontalmente para alinhar as linhas de beat com os ataques da bateria';
      draw();
    }

    async function loadWaveform(stemName) {
      const audio = state.audioEls[stemName];
      const url = audio && (audio.currentSrc || audio.src);
      if (!audio || !url) { toast('Stem não disponível'); return; }
      waveformData = null;
      draw();

      const songId = state.currentSongId || '';
      const pitch = state.currentPitch || 0;
      const cacheKey = `showtime_wf_${songId}_${stemName}_${pitch}`;
      try {
        const cached = localStorage.getItem(cacheKey);
        if (cached) {
          const parsed = JSON.parse(cached);
          waveformData = { samples: new Float32Array(parsed.samples), sampleRate: parsed.sampleRate, duration: parsed.duration };
          if (!canvas.width || !canvas.height) resizeCanvas();
          draw();
          return;
        }
      } catch {}

      try {
        const response = await fetch(url);
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const arrayBuf = await response.arrayBuffer();
        const tempCtx = new (window.OfflineAudioContext || window.webkitOfflineAudioContext)(1, 44100, 44100);
        const audioBuf = await tempCtx.decodeAudioData(arrayBuf.slice(0));
        const rawData = audioBuf.getChannelData(0);
        const points = Math.min(Math.ceil(audioBuf.duration * 100), 50000);
        const samplesPerPoint = Math.floor(rawData.length / points);
        waveformData = { samples: new Float32Array(points), sampleRate: audioBuf.sampleRate, duration: audioBuf.duration };
        for (let i = 0; i < points; i++) {
          let max = 0;
          const start = i * samplesPerPoint;
          for (let j = start; j < start + samplesPerPoint && j < rawData.length; j++) {
            const abs = Math.abs(rawData[j]);
            if (abs > max) max = abs;
          }
          waveformData.samples[i] = max;
        }
        try {
          localStorage.setItem(cacheKey, JSON.stringify({
            samples: Array.from(waveformData.samples), sampleRate: waveformData.sampleRate, duration: waveformData.duration
          }));
          // Drop stale caches for this song+stem (other pitch variants)
          for (let i = 0; i < localStorage.length; i++) {
            const k = localStorage.key(i);
            if (k && k.startsWith(`showtime_wf_${songId}_${stemName}_`) && k !== cacheKey) localStorage.removeItem(k);
          }
        } catch {}
        if (!canvas.width || !canvas.height) resizeCanvas();
        draw();
      } catch (e) {
        console.error('Waveform load error:', e);
        toast('Erro ao carregar waveform');
      }
    }

    // Synthetic click envelope matching the metronome sound choices.
    function generateClickWaveform(sound) {
      const sampleRate = 4000;
      let duration, samples;
      if (sound === 'click' || sound === 'wood') {
        duration = 0.08;
        const n = Math.floor(sampleRate * duration); samples = new Float32Array(n);
        const freq = sound === 'click' ? 1000 : 600;
        for (let i = 0; i < n; i++) { const t = i / sampleRate; const env = Math.exp(-t * 50); const f = freq * Math.pow(0.5, t / 0.04); samples[i] = Math.abs(Math.sin(2 * Math.PI * f * t) * env); }
      } else if (sound === 'cowbell') {
        duration = 0.15;
        const n = Math.floor(sampleRate * duration); samples = new Float32Array(n);
        for (let i = 0; i < n; i++) { const t = i / sampleRate; const env = Math.exp(-t * 20); const sig = Math.sin(2 * Math.PI * 800 * t) + Math.sin(2 * Math.PI * 540 * t); samples[i] = Math.abs(sig * 0.5 * env); }
      } else {
        duration = 0.12;
        const n = Math.floor(sampleRate * duration); samples = new Float32Array(n);
        for (let i = 0; i < n; i++) { const t = i / sampleRate; const env = Math.exp(-t * 25); samples[i] = Math.abs(Math.sin(2 * Math.PI * 80 * t) * env); }
      }
      let peak = 0;
      for (let i = 0; i < samples.length; i++) if (samples[i] > peak) peak = samples[i];
      if (peak > 0) for (let i = 0; i < samples.length; i++) samples[i] /= peak;
      return { samples, duration, sound };
    }

    function draw() {
      if (!canvas.width) return;
      const w = canvas.width, h = canvas.height, dpr = window.devicePixelRatio;
      const len = isPortrait ? h : w;
      const breadth = isPortrait ? w : h;
      ctx.clearRect(0, 0, w, h);
      ctx.fillStyle = '#0f1419';
      ctx.fillRect(0, 0, w, h);

      if (waveformData) {
        const startTime = viewCenter - viewDuration / 2;
        const endTime = viewCenter + viewDuration / 2;
        const startIdx = Math.max(0, Math.floor((startTime / waveformData.duration) * waveformData.samples.length));
        const endIdx = Math.min(waveformData.samples.length, Math.ceil((endTime / waveformData.duration) * waveformData.samples.length));
        const visibleSamples = endIdx - startIdx;
        if (visibleSamples > 0) {
          ctx.fillStyle = 'rgba(139, 92, 246, 0.35)';
          ctx.strokeStyle = 'rgba(139, 92, 246, 0.8)';
          ctx.lineWidth = dpr;
          ctx.beginPath();
          if (isPortrait) {
            for (let i = 0; i <= visibleSamples; i++) { const pos = (i / visibleSamples) * len; const amp = i < visibleSamples ? waveformData.samples[startIdx + i] : 0; const x = w / 2 + amp * (w / 2) * 0.85; if (i === 0) ctx.moveTo(x, pos); else ctx.lineTo(x, pos); }
            for (let i = visibleSamples; i >= 0; i--) { const pos = (i / visibleSamples) * len; const amp = i < visibleSamples ? waveformData.samples[startIdx + i] : 0; const x = w / 2 - amp * (w / 2) * 0.85; ctx.lineTo(x, pos); }
          } else {
            for (let i = 0; i <= visibleSamples; i++) { const pos = (i / visibleSamples) * len; const amp = i < visibleSamples ? waveformData.samples[startIdx + i] : 0; const y = h / 2 - amp * (h / 2) * 0.85; if (i === 0) ctx.moveTo(pos, y); else ctx.lineTo(pos, y); }
            for (let i = visibleSamples; i >= 0; i--) { const pos = (i / visibleSamples) * len; const amp = i < visibleSamples ? waveformData.samples[startIdx + i] : 0; const y = h / 2 + amp * (h / 2) * 0.85; ctx.lineTo(pos, y); }
          }
          ctx.closePath();
          ctx.fill();
          ctx.stroke();
        }
      }

      const bpm = getActiveBpm();
      if (bpm) {
        const interval = 60.0 / bpm;
        const startTime = viewCenter - viewDuration / 2;
        const endTime = viewCenter + viewDuration / 2;
        let firstBeat;
        if (currentOffset <= startTime) { const n = Math.ceil((startTime - currentOffset) / interval); firstBeat = currentOffset + n * interval; }
        else firstBeat = currentOffset;
        if (!clickWaveform || clickWaveform.sound !== state.metronome.sound) clickWaveform = generateClickWaveform(state.metronome.sound);
        const clickSamples = clickWaveform.samples;
        const pixelsPerSec = len / viewDuration;
        const clickWidthPx = clickWaveform.duration * pixelsPerSec;
        for (let beat = firstBeat; beat <= endTime; beat += interval) {
          const beatPos = ((beat - startTime) / viewDuration) * len;
          const isDownbeat = Math.abs(beat - currentOffset) < 0.001 || (beat >= currentOffset && Math.abs(((beat - currentOffset) / interval) % 4) < 0.01);
          const alpha = isDownbeat ? 1.0 : 0.7;
          ctx.strokeStyle = `rgba(245, 158, 11, ${alpha})`;
          ctx.lineWidth = (isDownbeat ? 1.5 : 1) * dpr;
          ctx.beginPath();
          const numPoints = Math.max(Math.floor(clickWidthPx), 8);
          for (let i = 0; i < numPoints; i++) {
            const sampleIdx = Math.floor((i / numPoints) * clickSamples.length);
            const amp = clickSamples[sampleIdx];
            const barSize = amp * breadth * 0.35;
            const pos = beatPos + (i / numPoints) * clickWidthPx;
            if (pos < 0 || pos > len) continue;
            if (isPortrait) { ctx.moveTo(w / 2 - barSize / 2, pos); ctx.lineTo(w / 2 + barSize / 2, pos); }
            else { ctx.moveTo(pos, h / 2 - barSize / 2); ctx.lineTo(pos, h / 2 + barSize / 2); }
          }
          ctx.stroke();
          ctx.strokeStyle = `rgba(245, 158, 11, ${isDownbeat ? 0.5 : 0.25})`;
          ctx.lineWidth = (isDownbeat ? 2 : 1) * dpr;
          ctx.beginPath();
          if (isPortrait) { ctx.moveTo(0, beatPos); ctx.lineTo(w * 0.15, beatPos); ctx.moveTo(w * 0.85, beatPos); ctx.lineTo(w, beatPos); }
          else { ctx.moveTo(beatPos, 0); ctx.lineTo(beatPos, h * 0.15); ctx.moveTo(beatPos, h * 0.85); ctx.lineTo(beatPos, h); }
          ctx.stroke();
        }
      }

      ctx.strokeStyle = 'rgba(255,255,255,0.3)';
      ctx.lineWidth = 1 * dpr;
      ctx.setLineDash([4 * dpr, 4 * dpr]);
      ctx.beginPath();
      if (isPortrait) { ctx.moveTo(0, h / 2); ctx.lineTo(w, h / 2); }
      else { ctx.moveTo(w / 2, 0); ctx.lineTo(w / 2, h); }
      ctx.stroke();
      ctx.setLineDash([]);
    }

    // --- Drag to align ---
    let dragStartPos = null, dragStartOffset = null;
    function onDragStart(x, y) { dragStartPos = isPortrait ? y : x; dragStartOffset = currentOffset; }
    function onDragMove(x, y) {
      if (dragStartPos == null) return;
      const rect = wrap.getBoundingClientRect();
      const pos = isPortrait ? y : x;
      const size = isPortrait ? rect.height : rect.width;
      const timeDelta = ((pos - dragStartPos) / size) * viewDuration;
      currentOffset = dragStartOffset + timeDelta;
      const maxOffset = getActiveBpm() ? 60.0 / getActiveBpm() : 3;
      currentOffset = ((currentOffset % maxOffset) + maxOffset) % maxOffset;
      document.getElementById('beatAlignOffset').value = Math.round(currentOffset * 1000);
      state.beatOffset = currentOffset;
      if (state.metronome.intervalId) startMetronomeTicking();
      draw();
    }
    function onDragEnd() { dragStartPos = null; }
    const mouseMoveHandler = (e) => { if (dragStartPos != null) onDragMove(e.clientX, e.clientY); };
    const touchMoveHandler = (e) => { if (dragStartPos != null) onDragMove(e.touches[0].clientX, e.touches[0].clientY); };
    wrap.addEventListener('mousedown', (e) => { onDragStart(e.clientX, e.clientY); e.preventDefault(); });
    document.addEventListener('mousemove', mouseMoveHandler);
    document.addEventListener('mouseup', onDragEnd);
    wrap.addEventListener('touchstart', (e) => { onDragStart(e.touches[0].clientX, e.touches[0].clientY); e.preventDefault(); }, { passive: false });
    document.addEventListener('touchmove', touchMoveHandler);
    document.addEventListener('touchend', onDragEnd);

    document.getElementById('beatAlignStem').addEventListener('change', (e) => loadWaveform(e.target.value));

    // Play/pause inside the modal
    const playBtn = document.getElementById('beatAlignPlay');
    const updatePlayBtn = () => { playBtn.textContent = modalPlaying ? '⏸' : '▶'; };
    playBtn.addEventListener('click', () => {
      if (modalPlaying) { state.pausedAt = getCurrentTime(); stopPlayback(); modalPlaying = false; }
      else { startPlayback(state.pausedAt || getCurrentTime()); modalPlaying = true; }
      updatePlayBtn();
    });

    // Metronome toggle inside the modal
    const metroBtn = document.getElementById('beatAlignMetro');
    metroBtn.addEventListener('click', () => {
      state.metronome.enabled = !state.metronome.enabled;
      if (state.metronome.enabled && state.isPlaying) startMetronomeTicking();
      else stopMetronome();
      savePlaylistSettings();
      metroBtn.classList.toggle('metro-on', state.metronome.enabled);
      document.querySelectorAll('[data-tool="metronome"]').forEach(b => b.classList.toggle('active', state.metronome.enabled));
    });

    // Manual offset input
    document.getElementById('beatAlignOffset').addEventListener('change', (e) => {
      const ms = parseInt(e.target.value);
      if (isNaN(ms)) return;
      currentOffset = ms / 1000;
      const maxOffset = getActiveBpm() ? 60.0 / getActiveBpm() : 3;
      currentOffset = Math.max(0, Math.min(currentOffset, maxOffset));
      e.target.value = Math.round(currentOffset * 1000);
      state.beatOffset = currentOffset;
      if (state.metronome.intervalId) startMetronomeTicking();
      draw();
    });

    // BPM input (edit / wheel / vertical drag)
    const bpmEl = document.getElementById('beatAlignBpm');
    function modalBpmUpdate(val) {
      val = Math.max(20, Math.min(300, val));
      state.bpm = val;
      bpmEl.value = val;
      updateBpmDisplay();
      clickWaveform = null;
      if (state.metronome.enabled && state.isPlaying) startMetronomeTicking();
      draw();
    }
    bpmEl.addEventListener('change', (e) => {
      const val = parseInt(e.target.value);
      if (!val || val < 20 || val > 300) { e.target.value = getActiveBpm() || 120; return; }
      modalBpmUpdate(val);
    });
    bpmEl.addEventListener('wheel', (e) => { e.preventDefault(); modalBpmUpdate((state.bpm || 120) + (e.deltaY < 0 ? 1 : -1)); }, { passive: false });
    let bpmTouchStartY = null, bpmTouchStartVal = null, bpmAccumulated = 0;
    bpmEl.addEventListener('touchstart', (e) => { if (document.activeElement === bpmEl) return; bpmTouchStartY = e.touches[0].clientY; bpmTouchStartVal = state.bpm || 120; bpmAccumulated = 0; e.preventDefault(); }, { passive: false });
    bpmEl.addEventListener('touchmove', (e) => {
      if (bpmTouchStartY == null) return; e.preventDefault();
      const dy = bpmTouchStartY - e.touches[0].clientY;
      const steps = Math.round(dy / 3);
      if (steps !== bpmAccumulated) { bpmAccumulated = steps; modalBpmUpdate(bpmTouchStartVal + steps); }
    }, { passive: false });
    bpmEl.addEventListener('touchend', () => { bpmTouchStartY = null; });

    function persistAlignState() {
      state.beatOffset = currentOffset;
      if (state.currentSong) {
        state.currentSong.beatOffset = currentOffset;
        state.currentSong.bpm = state.bpm;
        idbPut('songs', state.currentSong);
      }
      if (state.currentSongId) {
        addPendingEdit('beatOffset', state.currentSongId, { beatOffset: currentOffset });
        addPendingEdit('bpm', state.currentSongId, { bpm: state.bpm, beatOffset: currentOffset });
        saveSongSettings();
      }
      if (state.metronome.intervalId) startMetronomeTicking();
    }

    const close = () => {
      document.removeEventListener('mousemove', mouseMoveHandler);
      document.removeEventListener('mouseup', onDragEnd);
      document.removeEventListener('touchmove', touchMoveHandler);
      document.removeEventListener('touchend', onDragEnd);
      window.removeEventListener('resize', resizeCanvas);
      document.removeEventListener('keydown', keyHandler);
      persistAlignState();
      overlay.remove();
      // Respect the modal's play/pause state when closing.
      if (modalPlaying && !state.isPlaying) startPlayback(getCurrentTime());
      else if (!modalPlaying && state.isPlaying) { state.pausedAt = getCurrentTime(); stopPlayback(); }
    };

    document.getElementById('beatAlignClose').addEventListener('click', close);
    overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
    document.getElementById('beatAlignSave').addEventListener('click', () => {
      persistAlignState();
      toast(`Salvo: ${state.bpm} BPM · offset ${(currentOffset * 1000).toFixed(0)}ms`, 'success', 2000);
      close();
    });
    const keyHandler = (e) => { if (e.key === 'Escape') close(); };
    document.addEventListener('keydown', keyHandler);

    const initCanvas = () => {
      const rect = wrap.getBoundingClientRect();
      if (rect.width > 0 && rect.height > 0) { resizeCanvas(); loadWaveform(defaultStem); }
      else requestAnimationFrame(initCanvas);
    };
    requestAnimationFrame(() => requestAnimationFrame(initCanvas));
    window.addEventListener('resize', resizeCanvas);

    // Keep the view centered on the playhead; redraw continuously.
    const updateView = () => {
      if (!document.body.contains(overlay) && !overlay.isConnected) return;
      const newCenter = getCurrentTime();
      if (state.isPlaying || newCenter !== viewCenter) { viewCenter = newCenter; draw(); }
      requestAnimationFrame(updateView);
    };
    requestAnimationFrame(updateView);
  }

  // ============================================================
  // BPM Editor (inline)
  // ============================================================
  function initBpmEditor() {
    const el = document.getElementById('bpm-display');
    if (!el) return;

    el.addEventListener('click', () => {
      if (el.querySelector('input')) return;
      const current = state.bpm || 120;
      el.innerHTML = `<input type="number" min="20" max="300" value="${current}"
        style="width:60px;background:var(--surface-2);color:var(--text);border:1px solid var(--accent);
        border-radius:6px;padding:0.2rem 0.4rem;font-size:0.85rem;text-align:center" id="bpm-input">`;
      const input = document.getElementById('bpm-input');
      input.focus();
      input.select();

      let touchStartY = 0;
      let touchBpm = current;

      input.addEventListener('wheel', (e) => {
        e.preventDefault();
        const newBpm = Math.max(20, Math.min(300, parseInt(input.value) + (e.deltaY < 0 ? 1 : -1)));
        input.value = newBpm;
      }, { passive: false });

      input.addEventListener('touchstart', (e) => {
        touchStartY = e.touches[0].clientY;
        touchBpm = parseInt(input.value);
      });

      input.addEventListener('touchmove', (e) => {
        const dy = touchStartY - e.touches[0].clientY;
        const delta = Math.round(dy / 3);
        const newBpm = Math.max(20, Math.min(300, touchBpm + delta));
        input.value = newBpm;
      });

      const save = () => {
        const newBpm = parseInt(input.value) || current;
        state.bpm = newBpm;
        state.currentSong.bpm = newBpm;
        idbPut('songs', state.currentSong);
        addPendingEdit('bpm', state.currentSongId, { bpm: newBpm });
        el.textContent = newBpm + ' bpm';
        if (state.metronome.enabled && state.isPlaying) startMetronomeTicking();
      };

      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); save(); }
        if (e.key === 'Escape') { el.textContent = (state.bpm || '—') + ' bpm'; }
      });
      input.addEventListener('blur', save);
    });
  }

  // ============================================================
  // BPM Sections Modal
  // ============================================================
  function showBpmSectionsModal() {
    const sections = JSON.parse(JSON.stringify(state.bpmSections || []));

    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';

    function renderContent() {
      let rows = '';
      for (let i = 0; i < sections.length; i++) {
        rows += `<div class="bpm-section-row" style="display:flex;align-items:center;gap:0.5rem;margin:0.4rem 0">
          <span style="font-size:0.75rem;color:var(--text-muted);min-width:50px">${formatTime(sections[i].from)}</span>
          <input type="number" min="20" max="300" value="${sections[i].bpm}" data-section-idx="${i}"
            style="width:55px;background:var(--surface-2);color:var(--text);border:1px solid var(--surface-3);
            border-radius:6px;padding:0.3rem;font-size:0.8rem;text-align:center">
          <button data-del-section="${i}" style="width:32px;height:32px;border-radius:6px;background:var(--danger);
            color:#fff;font-size:0.8rem;display:flex;align-items:center;justify-content:center">✕</button>
        </div>`;
      }

      overlay.innerHTML = `
        <div class="modal-box" style="max-height:80vh;overflow-y:auto">
          <h3>Seções de BPM</h3>
          <div id="bpm-sections-list">${rows || '<p style="font-size:0.8rem;color:var(--text-muted)">Nenhuma seção.</p>'}</div>
          <button id="bpm-section-add" class="modal-btn confirm" style="margin-top:0.8rem;width:100%">
            + Adicionar no tempo atual (${formatTime(getCurrentTime())})
          </button>
          <div style="display:flex;gap:0.5rem;justify-content:flex-end;margin-top:1rem">
            <button class="modal-btn cancel" id="bpm-sections-cancel">Cancelar</button>
            <button class="modal-btn confirm" id="bpm-sections-save">Salvar</button>
          </div>
        </div>`;
    }

    renderContent();
    mountOverlay(overlay);

    overlay.addEventListener('click', (e) => {
      const del = e.target.closest('[data-del-section]');
      if (del) { sections.splice(parseInt(del.dataset.delSection), 1); renderContent(); return; }
      if (e.target.id === 'bpm-section-add') {
        sections.push({ from: getCurrentTime(), bpm: state.bpm || 120 });
        sections.sort((a, b) => a.from - b.from);
        renderContent();
        return;
      }
      if (e.target.id === 'bpm-sections-cancel') { overlay.remove(); return; }
      if (e.target.id === 'bpm-sections-save') {
        // Read edited BPMs from inputs
        overlay.querySelectorAll('[data-section-idx]').forEach(inp => {
          const idx = parseInt(inp.dataset.sectionIdx);
          sections[idx].bpm = parseInt(inp.value) || 120;
        });
        state.bpmSections = sections;
        state.currentSong.bpmSections = sections;
        idbPut('songs', state.currentSong);
        addPendingEdit('bpmSections', state.currentSongId, { bpmSections: sections });
        if (state.metronome.enabled && state.isPlaying) startMetronomeTicking();
        overlay.remove();
      }
    });
  }

  // ============================================================
  // Pitch Selection & Generation
  // ============================================================
  // PITCH_RANGE imported from constants.js

  function renderPitchSelector() {
    const pitches = (state.pitches && state.pitches.length) ? state.pitches : [0];
    let html = '<div class="pitch-selector" style="display:flex;gap:0.3rem;flex-wrap:wrap;padding:0.3rem 0;align-items:center">';
    // Available tones (always switchable)
    for (const p of pitches.slice().sort((a, b) => a - b)) {
      const label = p === 0 ? 'Original' : (p > 0 ? '+' + p : '' + p);
      const active = p === state.currentPitch ? 'active' : '';
      const generating = state._pitchGenerating === p ? 'generating' : '';
      html += `<button class="tool-chip ${active} ${generating}" data-pitch="${p}">${label}</button>`;
    }
    // Generation trigger: a "+ tom" button that reveals the semitone picker.
    html += `<button class="pitch-gen-btn" data-pitch-gen-toggle title="Gerar um novo tom">+ tom</button>`;
    html += '</div>';
    // Hidden picker row with the tones not yet generated.
    const missing = PITCH_RANGE.filter(n => !pitches.includes(n));
    html += `<div class="pitch-gen-row" id="pitch-gen-row" style="display:none">`;
    if (missing.length === 0) {
      html += `<span style="font-size:0.75rem;color:var(--text-muted)">Todos os tons já gerados</span>`;
    } else {
      for (const n of missing) {
        const label = n > 0 ? '+' + n : '' + n;
        html += `<button class="pitch-gen-btn" data-pitch-gen="${n}">${label}</button>`;
      }
    }
    html += `</div>`;
    return html;
  }

  // Request the Stemizer to render a pitch-shifted variant of the current song,
  // poll until it finishes, then make it available in the player. Requires the
  // Stemizer to be reachable (same host, port 7000 — same pattern as TTS).
  async function requestPitchGeneration(semitones) {
    const n = parseInt(semitones);
    if (!n || !state.currentSongId) return;
    if (!state.isOnline) { toast('Precisa estar conectado ao servidor para gerar tons', 'info'); return; }
    if (state.pitches && state.pitches.includes(n)) { switchPitch(n); return; }
    if (state._pitchGenerating != null) { toast('Já existe uma geração em andamento', 'info'); return; }

    const song = state.currentSong;
    const base = `https://${location.hostname}:7000`;
    state._pitchGenerating = n;
    renderPlayer();
    toast(`Gerando tom ${n > 0 ? '+' : ''}${n}… pode levar alguns minutos`, 'info', 4000);

    try {
      const res = await fetch(`${base}/api/songs/${song.id}/pitch`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ semitones: n })
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || `HTTP ${res.status}`);
      }

      // Poll the background task status until it clears.
      await new Promise((resolve, reject) => {
        let misses = 0;
        const timer = setInterval(async () => {
          try {
            const st = await fetch(`${base}/api/task-status`, { cache: 'no-store' }).then(r => r.json());
            if (st.current) {
              misses = 0;
              if (st.total) toast(`Gerando tom: ${st.message || ''} (${st.progress}/${st.total})`, 'info', 1500);
            } else {
              // No active task → done. Allow a couple of empty polls to avoid
              // a race right after POST before the task registers.
              if (++misses >= 2) { clearInterval(timer); resolve(); }
            }
          } catch (e) { clearInterval(timer); reject(e); }
        }, 2000);
        // Safety timeout: 10 minutes.
        setTimeout(() => { clearInterval(timer); resolve(); }, 600000);
      });

      // Confirm the variant is really available on the server before we expose
      // it. The pitch files live in the shared Stemizer data dir, so the
      // Showtime origin serves them at the same /stems/<id>/pitch_±N/ path the
      // player will request — pre-cache those local URLs so playback is instant
      // and works offline afterwards.
      const info = await fetch(`${base}/api/songs/${song.id}/stems?pitch=${n}`).then(r => r.json()).catch(() => null);
      const available = info && info.pitches && info.pitches.includes(n);
      if (!available) throw new Error('variante não ficou disponível');
      const localUrls = Object.values(state.stems || {}).map(u => getPitchedUrl(u, n));
      if (localUrls.length && navigator.serviceWorker && navigator.serviceWorker.controller) {
        navigator.serviceWorker.controller.postMessage({ type: 'CACHE_STEMS', urls: localUrls });
      }

      // Register the new pitch locally and persist on the song record.
      if (!state.pitches.includes(n)) state.pitches.push(n);
      state.pitches.sort((a, b) => a - b);
      if (state.currentSong) {
        state.currentSong.pitches = state.pitches;
        idbPut('songs', state.currentSong);
      }
      toast(`Tom ${n > 0 ? '+' : ''}${n} pronto!`, 'success', 2500);
    } catch (e) {
      console.error('Pitch generation failed:', e);
      toast('Falha ao gerar tom: ' + e.message, 'error', 4000);
    } finally {
      state._pitchGenerating = null;
      renderPlayer();
    }
  }

  async function switchPitch(semitones) {
    if (semitones === state.currentPitch) return;
    const wasPlaying = state.isPlaying;
    const currentTime = getCurrentTime();
    stopPlayback();

    state.currentPitch = semitones;
    const loadId = state._loadId;

    // Swap the src of the existing pooled elements to the pitched variant.
    for (const [name, originalUrl] of Object.entries(state.stems)) {
      const entry = getPoolEntry(name);
      const url = getPitchedUrl(originalUrl, semitones);
      entry.audio.src = url;
      entry.audio.playbackRate = state.speed;
      state.audioEls[name] = entry.audio;
      state.gainNodes[name] = entry.gain;
      state.sourceNodes[name] = entry.source;
    }

    await waitForBuffering(loadId);
    updateGains();

    if (wasPlaying) startPlayback(currentTime);
    else { state.pausedAt = currentTime; seekTo(currentTime); }

    renderMixer();
  }

  // ============================================================
  // Title/Artist Inline Editing
  // ============================================================
  function initTitleEditor() {
    const el = document.getElementById('np-title');
    if (!el) return;

    el.addEventListener('click', () => {
      if (el.contentEditable === 'true') return;
      const original = state.currentSong.title || '';
      el.contentEditable = 'true';
      el.classList.add('editing');
      el.focus();
      // Select all
      const range = document.createRange();
      range.selectNodeContents(el);
      const sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(range);

      const save = () => {
        el.contentEditable = 'false';
        el.classList.remove('editing');
        const newTitle = el.textContent.trim() || original;
        el.textContent = newTitle;
        if (newTitle !== original) {
          state.currentSong.title = newTitle;
          idbPut('songs', state.currentSong);
          addPendingEdit('title', state.currentSongId, { title: newTitle });
        }
      };

      el.addEventListener('blur', save, { once: true });
      el.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); el.blur(); }
        if (e.key === 'Escape') { el.textContent = original; el.blur(); }
      });
    });
  }

  // ============================================================
  // Loop A/B
  // ============================================================
  function cycleRepeat() {
    const modes = ['off', 'all', 'one'];
    const idx = modes.indexOf(state.repeatMode);
    state.repeatMode = modes[(idx + 1) % modes.length];
    savePlaylistSettings();
    updateRepeatBtn();
  }

  function updateRepeatBtn() {
    const btn = document.querySelector('[data-action="repeat"]');
    if (!btn) return;
    if (state.repeatMode === 'off') { btn.innerHTML = ICO.repeat; btn.classList.remove('active'); btn.style.opacity = '0.5'; }
    else if (state.repeatMode === 'all') { btn.innerHTML = ICO.repeat; btn.classList.add('active'); btn.style.opacity = '1'; }
    else if (state.repeatMode === 'one') { btn.innerHTML = ICO.repeatOne; btn.classList.add('active'); btn.style.opacity = '1'; }
  }

  function setLoopA() { state.loopA = getCurrentTime(); renderLoopUI(); saveSongSettings(); }
  function setLoopB() { state.loopB = getCurrentTime(); renderLoopUI(); saveSongSettings(); }
  function clearLoop() { state.loopA = null; state.loopB = null; renderLoopUI(); saveSongSettings(); }

  function renderLoopUI() {
    const loop = document.getElementById('tl-loop');
    if (!loop) return;
    if (state.loopA != null && state.loopB != null && state.duration > 0) {
      const left = (state.loopA / state.duration) * 100;
      const width = ((state.loopB - state.loopA) / state.duration) * 100;
      loop.style.left = left + '%';
      loop.style.width = width + '%';
      loop.style.display = 'block';
    } else {
      loop.style.display = 'none';
    }
    // Update tool chip states
    document.querySelectorAll('[data-tool="loop-a"]').forEach(b => b.classList.toggle('active', state.loopA != null));
    document.querySelectorAll('[data-tool="loop-b"]').forEach(b => b.classList.toggle('active', state.loopB != null));
  }

  // ============================================================
  // Trim
  // ============================================================
  function setTrimBefore() { state.trimBefore = getCurrentTime(); renderTrimUI(); saveSongSettings(); }
  function setTrimAfter() { state.trimAfter = getCurrentTime(); renderTrimUI(); saveSongSettings(); }
  function clearTrim() { state.trimBefore = null; state.trimAfter = null; renderTrimUI(); saveSongSettings(); }

  function renderTrimUI() {
    const trimL = document.getElementById('tl-trim-left');
    const trimR = document.getElementById('tl-trim-right');
    if (!trimL || !trimR || !state.duration) return;
    trimL.style.width = state.trimBefore ? ((state.trimBefore / state.duration) * 100) + '%' : '0';
    trimR.style.width = state.trimAfter ? (((state.duration - state.trimAfter) / state.duration) * 100) + '%' : '0';
  }

  // ============================================================
  // Speed Control
  // ============================================================
  function setSpeed(val) {
    val = Math.max(0.25, Math.min(2.0, Math.round(val * 100) / 100));
    state.speed = val;
    for (const audio of Object.values(state.audioEls)) {
      audio.playbackRate = val;
      audio.preservesPitch = true;
    }
    const display = document.getElementById('speed-value');
    if (display) display.textContent = val.toFixed(2) + 'x';
    const range = document.getElementById('speed-range');
    if (range) range.value = Math.round(val * 100);
    if (state.metronome.enabled && state.isPlaying) startMetronomeTicking();
    savePlaylistSettings();
  }

  // ============================================================
  // Presets
  // ============================================================
  function getPresets() {
    if (!state.currentSongId) return [];
    try { return JSON.parse(localStorage.getItem(`presets_${state.currentSongId}`) || '[]'); }
    catch { return []; }
  }

  function savePreset(name) {
    if (!state.currentSongId) return;
    const presets = getPresets();
    presets.push({
      name: name || `Preset ${presets.length + 1}`,
      volumes: { ...state.volumes },
      muted: [...state.muted],
      soloed: [...state.soloed]
    });
    localStorage.setItem(`presets_${state.currentSongId}`, JSON.stringify(presets));
  }

  function loadPreset(idx) {
    const presets = getPresets();
    if (!presets[idx]) return;
    const p = presets[idx];
    state.volumes = { ...p.volumes };
    state.muted = new Set(p.muted || []);
    state.soloed = new Set(p.soloed || []);
    updateGains();
    renderMixer();
  }

  function deletePreset(idx) {
    const presets = getPresets();
    presets.splice(idx, 1);
    localStorage.setItem(`presets_${state.currentSongId}`, JSON.stringify(presets));
  }

  function renderPresetsUI() {
    const presets = getPresets();
    let html = '<div class="presets-wrap" style="padding:0.3rem 0">';
    if (presets.length > 0) {
      html += '<div style="display:flex;flex-wrap:wrap;gap:0.3rem;margin-bottom:0.4rem">';
      for (let i = 0; i < presets.length; i++) {
        html += `<button class="tool-chip" data-load-preset="${i}" title="${esc(presets[i].name)}">${esc(presets[i].name)}</button>`;
        html += `<button class="tool-chip" data-del-preset="${i}" style="padding:0.2rem 0.4rem;font-size:0.6rem">✕</button>`;
      }
      html += '</div>';
    }
    html += `<div style="display:flex;gap:0.3rem;align-items:center;margin-top:0.3rem">
      <input type="text" placeholder="Nome do preset" id="preset-name-input"
        style="flex:1;background:var(--surface-2);border:none;border-radius:6px;padding:0.35rem 0.6rem;
        color:var(--text);font-size:0.75rem;min-height:36px">
      <button class="tool-chip" data-tool="save-preset">+ Salvar</button>
    </div></div>`;
    return html;
  }

  // ============================================================
  // Animation & Boundary Checker
  // ============================================================
  // Re-align all stems to a single reference position in one pass.
  // Used on return-from-background and by the throttled drift check. Doing it
  // once (rather than per-tick on every stem) avoids seek storms that glitch.
  function resyncStems(referenceTime) {
    const audios = Object.values(state.audioEls);
    if (audios.length < 2) return;
    const ref = (typeof referenceTime === 'number' && referenceTime >= 0)
      ? referenceTime
      : audios[0].currentTime;
    for (const a of audios) {
      if (Math.abs(a.currentTime - ref) > 0.05) a.currentTime = ref;
    }
  }

  function startAnimLoop() {
    stopAnimLoop();
    const loop = () => {
      // Skip visual work while hidden — rAF is paused by the browser anyway,
      // but guard defensively so a stray frame doesn't do layout work.
      if (!state._hidden) {
        updateTimeline();
        updateChordBar();
      }
      state._animFrame = requestAnimationFrame(loop);
    };
    state._animFrame = requestAnimationFrame(loop);
  }

  function stopAnimLoop() {
    if (state._animFrame) cancelAnimationFrame(state._animFrame);
    state._animFrame = null;
  }

  function startBoundaryChecker() {
    stopBoundaryChecker();
    state._lastBoundaryTs = performance.now();
    state._boundaryInterval = setInterval(() => {
      if (!state.isPlaying) return;

      // Detect a throttled/bursted tick: while the screen is off the browser
      // slows this interval down, so the real elapsed time between ticks can be
      // far larger than 200ms. When that happens we must NOT run drift
      // correction or aggressive checks that would seek all stems at once.
      const now = performance.now();
      const gap = now - state._lastBoundaryTs;
      state._lastBoundaryTs = now;
      const wasThrottled = gap > 1000; // interval was heavily delayed

      const t = getCurrentTime();

      // If duration wasn't known yet when playback started (metadata not loaded),
      // recover it now instead of falsely treating the song as ended.
      if (!(state.duration > 1)) {
        const d = Math.max(0, ...Object.values(state.audioEls).map(a => a.duration || 0));
        if (d > 1) {
          state.duration = d;
          const totalEl = document.getElementById('time-total');
          if (totalEl) totalEl.textContent = formatTime(d);
        } else {
          // Still unknown — don't run end/loop/trim checks against a bogus duration.
          return;
        }
      }

      // Loop enforcement
      if (state.loopA != null && state.loopB != null && t >= state.loopB) {
        seekTo(state.loopA);
        return;
      }
      // Trim after
      if (state.trimAfter && t >= state.trimAfter) {
        stopPlayback();
        return;
      }
      // Song end
      if (t >= state.duration - 0.2) {
        if (state.repeatMode === 'one') {
          seekTo(state.trimBefore || 0);
          return;
        } else if (state.repeatMode === 'all') {
          playNextSong();
          return;
        }
        stopPlayback();
        state.pausedAt = 0;
        return;
      }

      // Drift correction: keep stems in sync — but never while the page is
      // hidden or right after a throttled tick. In the background the audio
      // elements keep playing on their own; forcing currentTime on all of them
      // (especially in a burst on resume) is exactly what caused the glitches.
      if (!state._hidden && !wasThrottled) {
        const audios = Object.values(state.audioEls);
        if (audios.length > 1) {
          const ref = audios[0].currentTime;
          // Correct only the single worst-drifting stem per tick, with a small
          // hysteresis, so we nudge back into sync gently instead of yanking
          // every stem simultaneously.
          let worstIdx = -1, worstDrift = 0.08; // ignore <80ms
          for (let i = 1; i < audios.length; i++) {
            const drift = Math.abs(audios[i].currentTime - ref);
            if (drift > worstDrift) { worstDrift = drift; worstIdx = i; }
          }
          if (worstIdx !== -1) audios[worstIdx].currentTime = ref;
        }
      }

      // Notes (skip while hidden — no visual note display is useful off-screen)
      if (!state._hidden) checkNotes(t);

      // Keep the OS media controls' position in sync (cheap, no-op if unsupported).
      updatePositionState();
    }, 200);
  }

  function stopBoundaryChecker() {
    if (state._boundaryInterval) clearInterval(state._boundaryInterval);
    state._boundaryInterval = null;
  }

  // ============================================================
  // Waveform (timeline seek bar)
  // ============================================================
  if (!state._waveformSamples) state._waveformSamples = {};

  async function renderTimelineWaveform(loadId) {
    const canvas = document.getElementById('timeline-waveform');
    if (!canvas || !state.currentSong) return;

    // Wait for the timeline to actually be laid out. When loadSong runs right
    // after switchView, the flex layout may not be measured yet and
    // getBoundingClientRect().width returns 0 — which previously caused the
    // waveform to silently never render. Retry across a few animation frames.
    const timeline = document.getElementById('timeline');
    if (!timeline) return;
    let rect = timeline.getBoundingClientRect();
    let layoutTries = 0;
    while (!rect.width && layoutTries < 30) {
      if (loadId != null && loadId !== state._loadId) return;
      await new Promise(r => requestAnimationFrame(r));
      rect = timeline.getBoundingClientRect();
      layoutTries++;
    }
    if (!rect.width) return;

    const dpr = window.devicePixelRatio || 1;
    const waveformHeight = 200; // CSS pixels — must be larger than seek bar (24px)
    const w = Math.round(rect.width * dpr);
    const h = Math.round(waveformHeight * dpr);
    canvas.width = w;
    canvas.height = h;
    // Force CSS dimensions to override any attribute-based sizing
    canvas.style.width = rect.width + 'px';
    canvas.style.height = waveformHeight + 'px';
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, w, h);

    state._waveformSamples = {};
    const stemNames = Object.keys(state.audioEls).filter(n => n !== 'notes');

    for (const stemName of stemNames) {
      if (loadId != null && loadId !== state._loadId) return;
      const audio = state.audioEls[stemName];
      const url = audio?.src || audio?.currentSrc;
      if (!url) continue;

      const cacheKey = `showtime_wf_${state.currentSongId}_${stemName}`;
      let samples = null;

      // Try localStorage cache
      try {
        const cached = localStorage.getItem(cacheKey);
        if (cached) samples = new Float32Array(JSON.parse(cached));
      } catch {}

      if (!samples) {
        samples = await computeStemSamples(url, loadId);
        if (loadId != null && loadId !== state._loadId) return;
        if (samples) {
          try { localStorage.setItem(cacheKey, JSON.stringify(Array.from(samples))); } catch {}
        }
      }

      if (!samples || !samples.length) continue;
      state._waveformSamples[stemName] = samples;

      // Draw
      drawStemWaveform(ctx, samples, stemName, w, h);
    }

    // Also render note markers
    renderNoteMarkers();
  }

  // Fetch + decode a stem into downsampled peak samples, with retries.
  // On this hardware/LAN a single fetch or decode can fail transiently; a
  // couple of retries make the waveform reliably appear.
  async function computeStemSamples(url, loadId, attempts = 3) {
    for (let attempt = 0; attempt < attempts; attempt++) {
      if (loadId != null && loadId !== state._loadId) return null;
      let timer = null;
      try {
        // Abort a stuck fetch so it never hangs the (background) waveform work.
        const ctrl = new AbortController();
        timer = setTimeout(() => ctrl.abort(), 15000);
        const response = await fetch(url, { signal: ctrl.signal });
        if (!response.ok) throw new Error('HTTP ' + response.status);
        const arrayBuf = await response.arrayBuffer();
        clearTimeout(timer); timer = null;
        const tempCtx = new (window.OfflineAudioContext || window.webkitOfflineAudioContext)(1, 44100, 44100);
        const audioBuf = await tempCtx.decodeAudioData(arrayBuf.slice(0));
        const rawData = audioBuf.getChannelData(0);

        // Downsample to 500 points
        const points = Math.min(500, Math.ceil(audioBuf.duration * 10));
        const samplesPerPoint = Math.max(1, Math.floor(rawData.length / points));
        const samples = new Float32Array(points);
        for (let i = 0; i < points; i++) {
          let max = 0;
          const start = i * samplesPerPoint;
          for (let j = start; j < start + samplesPerPoint && j < rawData.length; j++) {
            const abs = Math.abs(rawData[j]);
            if (abs > max) max = abs;
          }
          samples[i] = max;
        }
        return samples;
      } catch {
        if (timer) { clearTimeout(timer); timer = null; }
        // brief backoff before retrying
        if (attempt < attempts - 1) await new Promise(r => setTimeout(r, 300));
      }
    }
    return null;
  }

  function drawStemWaveform(ctx, samples, stemName, w, h) {
    const hex = STEM_COLORS[stemName] || '#888888';
    const r = parseInt(hex.slice(1, 3), 16);
    const g = parseInt(hex.slice(3, 5), 16);
    const b = parseInt(hex.slice(5, 7), 16);
    ctx.fillStyle = `rgba(${r}, ${g}, ${b}, 0.15)`;
    ctx.beginPath();
    ctx.moveTo(0, h / 2);
    for (let i = 0; i < samples.length; i++) {
      const x = (i / samples.length) * w;
      const amp = samples[i] * (h / 2) * 0.85;
      ctx.lineTo(x, h / 2 - amp);
    }
    ctx.lineTo(w, h / 2);
    for (let i = samples.length - 1; i >= 0; i--) {
      const x = (i / samples.length) * w;
      const amp = samples[i] * (h / 2) * 0.85;
      ctx.lineTo(x, h / 2 + amp);
    }
    ctx.closePath();
    ctx.fill();
  }

  function redrawTimelineWaveform() {
    const canvas = document.getElementById('timeline-waveform');
    if (!canvas || !state.currentSong) return;
    const timeline = document.getElementById('timeline');
    const rect = timeline.getBoundingClientRect();
    if (!rect.width) return;
    const dpr = window.devicePixelRatio || 1;
    const waveformHeight = 200;
    const w = Math.round(rect.width * dpr);
    const h = Math.round(waveformHeight * dpr);
    canvas.width = w;
    canvas.height = h;
    canvas.style.width = rect.width + 'px';
    canvas.style.height = waveformHeight + 'px';
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, w, h);

    const hasSolo = state.soloed.size > 0;
    for (const [stemName, samples] of Object.entries(state._waveformSamples)) {
      if (state.muted.has(stemName)) continue;
      if (hasSolo && !state.soloed.has(stemName)) continue;
      drawStemWaveform(ctx, samples, stemName, w, h);
    }
  }

  function renderNoteMarkers() {
    const row = document.getElementById('timeline-notes');
    if (!row) return;
    row.innerHTML = '';
    if (!state.notesEnabled || !state.notes.length || state.duration <= 0) return;
    for (const note of state.notes) {
      if (!note.text) continue;
      const pct = (note.time / state.duration) * 100;
      const bubble = document.createElement('span');
      bubble.style.cssText = `position:absolute;left:${pct}%;top:-2px;transform:translateX(-50%);
        font-size:0.55rem;color:var(--text);background:var(--surface-3);padding:1px 4px;
        border-radius:4px;white-space:nowrap;pointer-events:none;max-width:60px;overflow:hidden;text-overflow:ellipsis`;
      bubble.textContent = note.text;
      bubble.title = `${formatTime(note.time)}: ${note.text}`;
      row.appendChild(bubble);
    }
  }

  // Redraw on mute/solo change
  function onMixChanged() {
    updateGains();
    renderMixer();
    redrawTimelineWaveform();
    savePlaylistSettings();
  }

  // Resize handler
  window.addEventListener('resize', () => { if (state.currentSong) redrawTimelineWaveform(); });

  // ============================================================
  // Notes
  // ============================================================
  function checkNotes(t) {
    if (!state.notesEnabled || !state.notes.length) return;
    for (let i = 0; i < state.notes.length; i++) {
      if (i === state._lastNoteIdx) continue;
      const n = state.notes[i];
      const diff = t - n.time;
      if (diff >= -0.3 && diff <= 0.4) {
        state._lastNoteIdx = i;
        showNoteDisplay(n.text);
        break;
      }
    }
  }

  function showNoteDisplay(text) {
    if (!text) return;
    const el = document.getElementById('notes-display');
    if (!el) return;
    el.textContent = text;
    el.classList.add('visible');
    clearTimeout(el._timeout);
    el._timeout = setTimeout(() => el.classList.remove('visible'), 3000);
  }

  function showAddNoteModal() {
    const t = getCurrentTime();
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    overlay.innerHTML = `<div class="modal-box">
      <h3>Adicionar nota</h3>
      <p style="font-size:0.75rem;color:var(--text-muted);margin-bottom:0.5rem">Tempo: ${formatTime(t)}</p>
      <textarea id="note-text-input" placeholder="Texto da nota..." rows="3"
        style="width:100%;background:var(--surface-2);border:none;border-radius:8px;padding:0.5rem;
        color:var(--text);font-size:0.85rem;resize:vertical;min-height:60px;margin-bottom:0.8rem"></textarea>
      <div style="display:flex;gap:0.5rem;justify-content:flex-end">
        <button class="modal-btn cancel" data-modal-close>Cancelar</button>
        <button class="modal-btn confirm" data-modal-save>Salvar</button>
      </div>
    </div>`;
    mountOverlay(overlay);
    overlay.querySelector('#note-text-input').focus();
    overlay.addEventListener('click', (e) => {
      if (e.target.matches('[data-modal-close]') || e.target === overlay) { overlay.remove(); return; }
      if (e.target.matches('[data-modal-save]')) {
        const text = overlay.querySelector('#note-text-input').value.trim();
        if (text) {
          state.notes.push({ time: parseFloat(t.toFixed(2)), text });
          state.notes.sort((a, b) => a.time - b.time);
          // Save to IDB
          if (state.currentSong) {
            state.currentSong.notes = state.notes;
            idbPut('songs', state.currentSong);
            addPendingEdit('notes', state.currentSongId, state.notes);
          }
        }
        overlay.remove();
      }
    });
  }

  function showNotesListModal() {
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    let listHtml = '';
    if (state.notes.length === 0) {
      listHtml = '<p style="color:var(--text-muted);font-size:0.8rem;text-align:center;padding:1rem">Nenhuma nota</p>';
    } else {
      listHtml = '<div style="max-height:50vh;overflow-y:auto">';
      for (let i = 0; i < state.notes.length; i++) {
        const n = state.notes[i];
        listHtml += `<div style="display:flex;align-items:center;gap:0.5rem;padding:0.4rem 0;border-bottom:1px solid var(--surface-2)">
          <span style="font-size:0.7rem;color:var(--accent);font-weight:600;min-width:40px">${formatTime(n.time)}</span>
          <span style="flex:1;font-size:0.8rem;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(n.text || n.audio || '')}</span>
          <button class="tool-chip" data-del-note="${i}" style="padding:0.2rem 0.4rem;font-size:0.6rem">✕</button>
        </div>`;
      }
      listHtml += '</div>';
    }
    overlay.innerHTML = `<div class="modal-box">
      <h3>Notas de execução</h3>
      ${listHtml}
      <div style="display:flex;justify-content:flex-end;margin-top:0.8rem">
        <button class="modal-btn cancel" data-modal-close>Fechar</button>
      </div>
    </div>`;
    mountOverlay(overlay);
    overlay.addEventListener('click', (e) => {
      if (e.target.matches('[data-modal-close]') || e.target === overlay) { overlay.remove(); return; }
      const delBtn = e.target.closest('[data-del-note]');
      if (delBtn) {
        const idx = parseInt(delBtn.dataset.delNote);
        state.notes.splice(idx, 1);
        if (state.currentSong) {
          state.currentSong.notes = state.notes;
          idbPut('songs', state.currentSong);
          addPendingEdit('notes', state.currentSongId, state.notes);
        }
        overlay.remove();
        showNotesListModal(); // re-render
      }
    });
  }

  async function requestNotesTTS() {
    if (!state.isOnline || !state.currentSongId) return;
    const textNotes = state.notes.filter(n => n.text);
    if (textNotes.length === 0) { showNoteDisplay('Nenhuma nota de texto'); return; }
    try {
      // Push notes to server first
      await fetch('/api/sync', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ edits: [{ type: 'notes', songId: state.currentSongId, value: state.notes }] })
      });
      // Trigger TTS generation on Stemizer
      const song = state.currentSong;
      const stemsUrl = `https://${location.hostname}:7000/api/songs/${song.id}/notes`;
      await fetch(stemsUrl.replace(':7001', ':7000'), {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ notes: state.notes, lang: 'pt-br' })
      }).catch(() => {});
      showNoteDisplay('TTS solicitado ao Stemizer');
    } catch (e) {
      showNoteDisplay('Erro ao solicitar TTS');
    }
  }

  // ============================================================
  // Timeline & Chords
  // ============================================================
  function updateTimeline() {
    const t = getCurrentTime();
    const pct = state.duration > 0 ? (t / state.duration) * 100 : 0;
    const progress = document.getElementById('tl-progress');
    const cursor = document.getElementById('tl-cursor');
    const timeNow = document.getElementById('time-now');
    if (progress) progress.style.width = pct + '%';
    if (cursor) cursor.style.left = pct + '%';
    if (timeNow) timeNow.textContent = formatTime(t);
  }

  function updateChordBar() {
    if (!state.chords || state.chords.length === 0) return;
    const t = getCurrentTime();
    let idx = -1;
    for (let i = state.chords.length - 1; i >= 0; i--) {
      if (t >= state.chords[i].time) { idx = i; break; }
    }
    if (idx === state._lastChordIdx) return;
    state._lastChordIdx = idx;

    const bar = document.getElementById('chord-bar');
    if (!bar) return;

    const start = Math.max(0, idx - 2);
    const end = Math.min(state.chords.length, idx + 6);
    let html = '';
    for (let i = start; i < end; i++) {
      const cls = i === idx ? 'active' : (i < idx ? 'past' : '');
      html += `<span class="chord-item ${cls}">${esc(state.chords[i].chord)}</span>`;
    }
    bar.innerHTML = html;
    // Scroll chord bar horizontally only (don't affect page vertical scroll)
    const active = bar.querySelector('.active');
    if (active) {
      const barRect = bar.getBoundingClientRect();
      const activeRect = active.getBoundingClientRect();
      const scrollTarget = bar.scrollLeft + (activeRect.left - barRect.left) - (barRect.width / 2) + (activeRect.width / 2);
      bar.scrollTo({ left: scrollTarget, behavior: 'smooth' });
    }
  }

  // ============================================================
  // Media Session API
  // ============================================================
  function updateMediaSession() {
    if (!('mediaSession' in navigator) || !state.currentSong) return;
    navigator.mediaSession.metadata = new MediaMetadata({
      title: state.currentSong.title || 'Unknown',
      artist: state.currentSong.artist || 'EarRest Showtime',
      album: 'EarRest'
    });
    navigator.mediaSession.setActionHandler('play', () => { resumeAudioCtx(); startPlayback(); });
    navigator.mediaSession.setActionHandler('pause', () => stopPlayback());
    navigator.mediaSession.setActionHandler('previoustrack', () => { resumeAudioCtx(); playPrevSong(); });
    navigator.mediaSession.setActionHandler('nexttrack', () => { resumeAudioCtx(); playNextSong(); });
    navigator.mediaSession.setActionHandler('seekbackward', () => seekTo(getCurrentTime() - 10));
    navigator.mediaSession.setActionHandler('seekforward', () => seekTo(getCurrentTime() + 10));
    try { navigator.mediaSession.playbackState = state.isPlaying ? 'playing' : 'paused'; } catch (e) {}
    updatePositionState();
  }

  // Report playback position to the OS so lock-screen / notification controls
  // stay accurate without relying on our (throttled-in-background) timers.
  function updatePositionState() {
    if (!('mediaSession' in navigator) || typeof navigator.mediaSession.setPositionState !== 'function') return;
    if (!(state.duration > 0)) return;
    try {
      const pos = Math.min(Math.max(0, getCurrentTime()), state.duration);
      navigator.mediaSession.setPositionState({
        duration: state.duration,
        playbackRate: state.speed || 1,
        position: pos
      });
    } catch (e) { /* invalid state values — ignore */ }
  }

  // Visibility handling: the root cause of background glitches.
  // While hidden we pause visual work; on return we resume the AudioContext
  // (it can be auto-suspended) and do ONE gentle re-sync instead of letting the
  // boundary checker fire a burst of per-stem seeks.
  function handleVisibilityChange() {
    if (document.hidden) {
      state._hidden = true;
      // Stop the rAF loop cleanly; the browser pauses it anyway.
      stopAnimLoop();
      return;
    }

    state._hidden = false;
    // Reset the throttle detector so the first post-resume tick is treated as
    // "was throttled" and skips drift correction.
    state._lastBoundaryTs = 0;

    if (!state.isPlaying) {
      // Not playing: just refresh the UI once.
      updateTimeline();
      updateChordBar();
      return;
    }

    // Resume the audio graph if the browser suspended it in the background.
    if (state.audioCtx && state.audioCtx.state === 'suspended') {
      state.audioCtx.resume().catch(() => {});
    }

    // One gentle re-sync to the leading stem, then restart visual updates.
    resyncStems();
    startAnimLoop();
    updateTimeline();
    updateChordBar();
    updateMediaSession();
  }

  // ============================================================
  // Player UI Rendering
  // ============================================================
  function renderMasterVolume() {
    const vol = Math.round(state.masterVolume * 100);
    const gainPct = Math.round((state.songGain || 1) * 100);
    return `<div class="master-vol-row" style="display:flex;align-items:center;gap:0.5rem;padding:0.4rem 1rem">
      <span style="font-size:0.75rem;color:var(--text-muted);min-width:48px">Master</span>
      <input type="range" class="h-slider" id="master-vol-slider" min="0" max="150" value="${state.masterMuted ? 0 : vol}">
      <button class="stem-btn mute ${state.masterMuted ? 'active' : ''}" id="master-mute-btn" data-action="master-mute"
        style="width:32px;height:32px">${ICO.x}</button>
    </div>
    <div class="song-gain-row" style="display:flex;align-items:center;gap:0.5rem;padding:0.2rem 1rem 0.5rem">
      <span style="font-size:0.75rem;color:var(--text-muted);min-width:48px">Ganho</span>
      <button class="stem-btn" data-action="gain-down" title="Reduzir 10%" aria-label="Reduzir ganho 10%" style="width:36px;height:36px;font-size:1rem">−</button>
      <span id="song-gain-value" title="Toque para redefinir" data-action="gain-reset"
        style="min-width:52px;text-align:center;font-size:0.8rem;font-weight:600;cursor:pointer">${gainPct}%</span>
      <button class="stem-btn" data-action="gain-up" title="Aumentar 10%" aria-label="Aumentar ganho 10%" style="width:36px;height:36px;font-size:1rem">+</button>
      <span style="font-size:0.65rem;color:var(--text-muted);flex:1">volume desta música</span>
    </div>`;
  }

  function renderToolsSection() {
    const isMobile = window.innerWidth < 600;

    const pitchHtml = renderPitchSelector();
    const speedHtml = `<div class="speed-control">
      <span class="speed-label">Veloc.</span>
      <input type="range" class="h-slider" id="speed-range" min="25" max="200" step="5" value="${Math.round(state.speed * 100)}">
      <span class="speed-value" id="speed-value">${state.speed.toFixed(2)}x</span>
    </div>`;

    const loopTrimHtml = `<div class="tools-bar-inner" style="display:flex;flex-wrap:wrap;gap:0.3rem;padding:0.3rem 0">
      <button class="tool-chip ${state.loopA != null ? 'active' : ''}" data-tool="loop-a">A</button>
      <button class="tool-chip ${state.loopB != null ? 'active' : ''}" data-tool="loop-b">B</button>
      <button class="tool-chip" data-tool="loop-clear">✕ Loop</button>
      <button class="tool-chip" data-tool="trim-before">✂ Ini</button>
      <button class="tool-chip" data-tool="trim-after">✂ Fim</button>
      <button class="tool-chip" data-tool="trim-clear">✕ Trim</button>
    </div>`;

    const metroHtml = `<div class="tools-bar-inner" style="display:flex;flex-wrap:wrap;gap:0.3rem;padding:0.3rem 0;align-items:center">
      <button class="tool-chip ${state.metronome.enabled ? 'active' : ''}" data-tool="metronome">${ICO.metro} Metro</button>
      <button class="tool-chip" data-tool="tap-tempo">Tap</button>
      <button class="tool-chip" data-tool="beat-align">↔ Beat</button>
      <button class="tool-chip" data-tool="bpm-sections">${ICO.music} Seções</button>
      <span class="bpm-display" id="bpm-display" style="font-size:0.8rem;font-weight:700;color:var(--accent);
        cursor:pointer;padding:0.3rem 0.5rem;min-width:60px;text-align:center">${state.bpm ? state.bpm + ' bpm' : '—'}</span>
    </div>`;

    const notesPresetsHtml = `<div class="tools-bar-inner" style="padding:0.3rem 0">
      <div style="margin-bottom:0.5rem">
        <span style="font-size:0.7rem;color:var(--text-muted);text-transform:uppercase;letter-spacing:0.04em">Notas</span>
      </div>
      <div style="display:flex;flex-wrap:wrap;gap:0.3rem;margin-bottom:0.5rem">
        <button class="tool-chip ${state.notesEnabled ? 'active' : ''}" data-tool="notes">${ICO.notes} Texto</button>
        <button class="tool-chip ${state.notesAudioEnabled ? 'active' : ''}" data-tool="notes-audio">♪ Áudio</button>
        <button class="tool-chip" data-tool="notes-add">+ Nota</button>
        <button class="tool-chip" data-tool="notes-list">☰ Lista</button>
        ${state.isOnline ? `<button class="tool-chip" data-tool="notes-gen-tts">↻ Gerar TTS</button>` : ''}
      </div>
      <div style="margin-top:0.5rem">
        <span style="font-size:0.7rem;color:var(--text-muted);text-transform:uppercase;letter-spacing:0.04em">Presets de mix</span>
      </div>
      ${renderPresetsUI()}
    </div>`;

    if (isMobile) {
      const pages = [pitchHtml + speedHtml, loopTrimHtml, metroHtml, notesPresetsHtml];
      let dotsHtml = '';
      for (let i = 0; i < pages.length; i++) {
        dotsHtml += `<span class="tools-dot ${i === state._toolsPage ? 'active' : ''}" data-tools-page="${i}"
          style="width:12px;height:12px;border-radius:50%;background:${i === state._toolsPage ? 'var(--accent)' : 'var(--surface-3)'};
          display:inline-block;cursor:pointer;min-width:12px;min-height:12px;padding:4px;box-sizing:content-box"></span>`;
      }
      return `<div class="tools-carousel" style="overflow:hidden;position:relative">
        <div class="tools-pages" id="tools-pages" style="display:flex;transition:transform 0.3s;
          transform:translateX(-${state._toolsPage * 100}%);width:100%">
          ${pages.map((p, i) => `<div class="tools-page" style="flex:0 0 100%;padding:0.4rem 1rem;box-sizing:border-box">${p}</div>`).join('')}
        </div>
        <div class="tools-dots" style="display:flex;justify-content:center;gap:0.6rem;padding:0.5rem 0">
          ${dotsHtml}
        </div>
      </div>`;
    }

    // Desktop: all visible
    return `<div class="tools-all" style="padding:0.4rem 1rem;display:flex;flex-direction:column;gap:0.3rem">
      ${pitchHtml}
      ${speedHtml}
      ${loopTrimHtml}
      ${metroHtml}
      ${notesPresetsHtml}
    </div>`;
  }

  function renderMixer() {
    const mixer = document.getElementById('mixer');
    if (!mixer) return;
    const names = Object.keys(state.audioEls).sort((a, b) => {
      const ia = STEM_ORDER.indexOf(a);
      const ib = STEM_ORDER.indexOf(b);
      return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib);
    });
    if (names.length === 0) { mixer.innerHTML = ''; return; }

    const isMobile = window.innerWidth < 600;

    if (isMobile) {
      state._mixerStemIdx = Math.max(0, Math.min(state._mixerStemIdx, names.length - 1));
      const name = names[state._mixerStemIdx];
      const color = STEM_COLORS[name] || '#666';
      const vol = Math.round((state.volumes[name] ?? 1) * 100);
      const isMuted = state.muted.has(name);
      const isSoloed = state.soloed.has(name);

      mixer.innerHTML = `
        <div class="mixer-mobile" style="display:flex;flex-direction:column;align-items:center;gap:0.5rem;padding:0.5rem">
          <div style="display:flex;align-items:center;gap:1rem;width:100%;justify-content:center">
            <button class="transport-btn" data-mixer-nav="prev" style="width:36px;height:36px"
              ${state._mixerStemIdx === 0 ? 'disabled style="opacity:0.3;width:36px;height:36px"' : ''}>${ICO.prev}</button>
            <span style="font-size:0.9rem;font-weight:700;color:${color};text-transform:capitalize;min-width:80px;text-align:center">
              ${name} <span style="font-size:0.7rem;color:var(--text-muted)">(${state._mixerStemIdx + 1}/${names.length})</span>
            </span>
            <button class="transport-btn" data-mixer-nav="next" style="width:36px;height:36px"
              ${state._mixerStemIdx === names.length - 1 ? 'disabled style="opacity:0.3;width:36px;height:36px"' : ''}>${ICO.next}</button>
          </div>
          <div style="display:flex;align-items:center;gap:0.8rem;width:100%;padding:0 1rem">
            <input type="range" class="stem-vol" min="0" max="150" value="${vol}" data-stem-vol="${name}" style="flex:1">
            <span style="font-size:0.75rem;min-width:35px;text-align:right">${vol}%</span>
          </div>
          <div style="display:flex;gap:0.5rem">
            <button class="stem-btn mute ${isMuted ? 'active' : ''}" data-mute="${name}"
              style="width:44px;height:44px;font-size:0.8rem;border-radius:8px">M</button>
            <button class="stem-btn solo ${isSoloed ? 'active' : ''}" data-solo="${name}"
              style="width:44px;height:44px;font-size:0.8rem;border-radius:8px">S</button>
          </div>
        </div>`;
    } else {
      let html = '';
      for (const name of names) {
        const color = STEM_COLORS[name] || '#666';
        const vol = Math.round((state.volumes[name] ?? 1) * 100);
        const isMuted = state.muted.has(name);
        const isSoloed = state.soloed.has(name);
        html += `
          <div class="stem-row" data-stem="${name}">
            <div class="stem-color" style="background:${color}"></div>
            <span class="stem-name">${name}</span>
            <input type="range" class="stem-vol" min="0" max="150" value="${vol}" data-stem-vol="${name}" orient="vertical">
            <div class="stem-btns">
              <button class="stem-btn mute ${isMuted ? 'active' : ''}" data-mute="${name}">M</button>
              <button class="stem-btn solo ${isSoloed ? 'active' : ''}" data-solo="${name}">S</button>
            </div>
          </div>`;
      }
      mixer.innerHTML = html;
    }
  }

  function renderPlayer() {
    const container = document.getElementById('player-container');
    if (!state.currentSong) {
      container.innerHTML = `<div class="empty-state">${ICO.play}<h3>Nenhuma música selecionada</h3><p>Escolha uma música na biblioteca.</p></div>`;
      return;
    }

    const s = state.currentSong;
    const thumbUrl = s.thumbnail || (s.youtube_id ? `https://i.ytimg.com/vi/${s.youtube_id}/hqdefault.jpg` : '');
    container.innerHTML = `
      ${thumbUrl ? `<div class="player-bg-thumb" style="background-image:url('${thumbUrl}')"></div>` : ''}
      <div class="now-playing-bar">
        <div class="np-title" id="np-title">${esc(s.title)}</div>
        <div class="np-artist" id="np-artist">${esc(s.artist || '')}</div>
        <div class="np-key" id="np-key" data-edit-key="${s.id}" title="${s.originalKey ? 'Editar o tom' : 'Definir o tom'}">🎼 ${s.originalKey ? esc(s.originalKey) : 'Definir tom'}</div>
      </div>

      <div class="chord-bar" id="chord-bar"></div>

      <div class="timeline-wrap">
        <div class="timeline" id="timeline">
          <canvas id="timeline-waveform"></canvas>
          <div class="timeline-trim-left" id="tl-trim-left"></div>
          <div class="timeline-trim-right" id="tl-trim-right"></div>
          <div class="timeline-loop" id="tl-loop"></div>
          <div class="timeline-progress" id="tl-progress"></div>
          <div class="timeline-cursor" id="tl-cursor"></div>
          <div class="timeline-notes-row" id="timeline-notes"></div>
        </div>
        <div class="time-labels">
          <span id="time-now">0:00</span>
          <span id="time-total">${formatTime(state.duration)}</span>
        </div>
      </div>

      <div id="loading-stems" style="display:none"></div>

      ${renderToolsSection()}
      ${renderMasterVolume()}

      <div class="mixer" id="mixer"></div>`;

    // Render transport as sibling of player-container (fixed at bottom of player-view)
    let transport = document.getElementById('transport');
    if (!transport) {
      transport = document.createElement('div');
      transport.className = 'transport';
      transport.id = 'transport';
      container.parentElement.appendChild(transport);
    }
    transport.innerHTML = `
      <button class="transport-btn ${state.repeatMode !== 'off' ? 'active' : ''}" data-action="repeat" style="opacity:${state.repeatMode === 'off' ? '0.5' : '1'}">${state.repeatMode === 'one' ? ICO.repeatOne : ICO.repeat}</button>
      <button class="transport-btn" data-action="prev">${ICO.prev}</button>
      <button class="transport-btn" data-action="back10">${ICO.skipBack}</button>
      <button class="transport-btn play" data-action="toggle" id="play-btn">${state.isPlaying ? ICO.pause : ICO.play}</button>
      <button class="transport-btn" data-action="fwd10">${ICO.skipFwd}</button>
      <button class="transport-btn" data-action="next">${ICO.next}</button>`;

    renderMixer();
    renderLoopUI();
    renderTrimUI();
    initTitleEditor();
    initBpmEditor();
  }

  function updateTransportBtn() {
    const btn = document.getElementById('play-btn');
    if (btn) btn.innerHTML = state.isPlaying ? ICO.pause : ICO.play;
    // Keep the queue's play/pause icon in sync when that view is visible.
    if (state.currentView === 'queue-view') renderQueue();
  }

  // ============================================================
  // Setlist View
  // ============================================================
  function renderSetlistSelector() {
    const select = document.getElementById('setlist-select');
    let html = '<option value="">Selecione uma setlist</option>';
    for (const pl of state.playlists) {
      html += `<option value="${pl.id}">${esc(pl.title)}</option>`;
    }
    select.innerHTML = html;
  }

  // ===== SETLIST NOTES =====

  function showSetlistNoteModal(playlistId, position, existingNote = null) {
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    overlay.innerHTML = `
      <div class="modal-box">
        <h3>${existingNote ? '✎ Editar anotação' : '📝 Nova anotação'}</h3>
        <input type="text" id="sl-note-input" placeholder="Ex: Música extra, avisos..." value="${existingNote ? esc(existingNote.text) : ''}" autocomplete="off" style="width:100%;padding:0.5rem;border-radius:6px;border:1px solid var(--surface-3);background:var(--surface-2);color:var(--text);font-size:0.9rem;margin:0.75rem 0">
        <div style="display:flex;gap:0.5rem;justify-content:flex-end">
          <button class="modal-btn cancel" id="sl-note-cancel">Cancelar</button>
          <button class="modal-btn confirm" id="sl-note-save">${existingNote ? 'Salvar' : 'Adicionar'}</button>
        </div>
      </div>`;
    mountOverlay(overlay);
    const input = overlay.querySelector('#sl-note-input');
    input.focus();
    input.select();

    const close = () => overlay.remove();
    overlay.querySelector('#sl-note-cancel').addEventListener('click', close);
    overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });

    const save = async () => {
      const text = input.value.trim();
      if (!text) { input.focus(); return; }
      if (existingNote) {
        existingNote.text = text;
        await idbPut('setlistNotes', existingNote);
        const idx = state.setlistNotes.findIndex(n => n.id === existingNote.id);
        if (idx >= 0) state.setlistNotes[idx] = existingNote;
      } else {
        const note = { playlist_id: playlistId, position, text, noteId: genNoteId() };
        const id = await idbAdd('setlistNotes', note);
        note.id = id;
        state.setlistNotes.push(note);
      }
      close();
      pushSetlistNotes(playlistId);
      renderSetlist(playlistId);
    };

    overlay.querySelector('#sl-note-save').addEventListener('click', save);
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') save(); if (e.key === 'Escape') close(); });
  }

  async function deleteSetlistNote(noteId) {
    await idbDelete('setlistNotes', noteId);
    state.setlistNotes = state.setlistNotes.filter(n => n.id !== noteId);
    const playlistId = document.getElementById('setlist-select').value;
    if (playlistId) { pushSetlistNotes(playlistId); renderSetlist(playlistId); }
  }

  // ===== SETLIST COLLAPSE (visual-only) =====
  // Esconde visualmente uma música da setlist sem alterar playlist/setlist.
  // Persistido por playlist em localStorage. COLLAPSE_KEY from constants.js

  function loadCollapsedSetlist(playlistId) {
    state.collapsedSetlist = new Set();
    if (!playlistId) return;
    try {
      const all = JSON.parse(localStorage.getItem(COLLAPSE_KEY) || '{}');
      (all[playlistId] || []).forEach(id => state.collapsedSetlist.add(id));
    } catch {}
  }

  function saveCollapsedSetlist(playlistId) {
    if (!playlistId) return;
    try {
      const all = JSON.parse(localStorage.getItem(COLLAPSE_KEY) || '{}');
      const ids = [...state.collapsedSetlist];
      if (ids.length) all[playlistId] = ids;
      else delete all[playlistId];
      localStorage.setItem(COLLAPSE_KEY, JSON.stringify(all));
    } catch {}
  }

  function toggleCollapsedSong(playlistId, songId) {
    if (state.collapsedSetlist.has(songId)) state.collapsedSetlist.delete(songId);
    else state.collapsedSetlist.add(songId);
    saveCollapsedSetlist(playlistId);
    renderSetlist(playlistId);
  }

  // ============================================================
  // Key (tom) editing — shared between player and setlist.
  // Offline-first: writes to IndexedDB immediately and queues a pending
  // edit that syncs to the backend (chords.json) once the server is reachable.
  // ============================================================
  function saveOriginalKey(songId, newKey) {
    const value = newKey || null; // null clears the key
    // Update the catalog/local song object so every view reflects it right away.
    const song = state.songs.find(s => s.id === songId);
    if (song) {
      song.originalKey = value;
      idbPut('songs', song);
    }
    if (state.currentSongId === songId) {
      state.originalKey = value;
      if (state.currentSong) state.currentSong.originalKey = value;
    }
    // Queue for server sync (server accepts edit.type === 'originalKey').
    addPendingEdit('originalKey', songId, value);
  }

  // Opens the fixed key picker (12 major + 12 minor + "limpar").
  // onSaved(newKey) is called after the value is persisted.
  function showKeyPickerModal(song, onSaved) {
    const current = song.originalKey || '';
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    const cell = (k) => `<div class="key-cell ${k === current ? 'selected' : ''}" data-key-cell="${k}">${k}</div>`;
    overlay.innerHTML = `
      <div class="modal-box">
        <h3>🎼 Tom — ${esc(song.title)}</h3>
        <div class="key-picker-label">Maiores</div>
        <div class="key-picker-grid">${KEYS_MAJOR.map(cell).join('')}</div>
        <div class="key-picker-label">Menores</div>
        <div class="key-picker-grid">${KEYS_MINOR.map(cell).join('')}</div>
        <div style="display:flex;gap:0.5rem;justify-content:flex-end;margin-top:0.6rem">
          ${current ? '<button class="modal-btn cancel" id="sl-key-clear" style="margin-right:auto">Limpar</button>' : ''}
          <button class="modal-btn cancel" id="sl-key-cancel">Cancelar</button>
        </div>
      </div>`;
    mountOverlay(overlay);

    const close = () => overlay.remove();
    const apply = (val) => {
      saveOriginalKey(song.id, val);
      close();
      if (typeof onSaved === 'function') onSaved(val);
    };

    overlay.addEventListener('click', (ev) => {
      if (ev.target === overlay) return close();
      const clearBtn = ev.target.closest('#sl-key-clear');
      if (clearBtn) return apply(null);
      const cancelBtn = ev.target.closest('#sl-key-cancel');
      if (cancelBtn) return close();
      const keyCell = ev.target.closest('[data-key-cell]');
      if (keyCell) return apply(keyCell.dataset.keyCell);
    });
  }

  function renderSetlist(playlistId) {
    const container = document.getElementById('setlist-songs');
    if (!playlistId) {
      container.innerHTML = `<div class="empty-state">${ICO.music}<h3>Selecione uma setlist</h3></div>`;
      return;
    }

    loadCollapsedSetlist(playlistId);

    const songIds = state.playlistSongs
      .filter(ps => ps.playlist_id === playlistId)
      .sort((a, b) => (a.position || 0) - (b.position || 0))
      .map(ps => ps.song_id);
    const songs = songIds.map(id => state.songs.find(s => s.id === id)).filter(Boolean);

    // Get notes for this playlist, sorted by position
    const notes = state.setlistNotes
      .filter(n => n.playlist_id === playlistId)
      .sort((a, b) => a.position - b.position);

    // Build ordered items: merge songs (with integer positions) and notes (with fractional positions between songs)
    // Songs have positions 0, 1, 2, ... Notes have positions like 0.5 (between 0 and 1), 1.5, etc.
    // We'll build a unified list sorted by position
    const items = [];
    songs.forEach((s, idx) => {
      items.push({ type: 'song', song: s, position: idx });
    });
    notes.forEach(n => {
      items.push({ type: 'note', note: n, position: n.position });
    });
    items.sort((a, b) => a.position - b.position);

    let html = '';
    html += `<button class="sl-add-note-btn" data-add-note-pos="-0.5" title="Adicionar anotação aqui">+ nota</button>`;
    let songIdx = 0;
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      if (item.type === 'song') {
        const s = item.song;
        const isPlaying = s.id === state.currentSongId;
        const isCollapsed = state.collapsedSetlist.has(s.id);
        html += `
        <div class="setlist-item ${isPlaying ? 'active' : ''} ${isCollapsed ? 'sl-collapsed' : ''}" data-song-id="${s.id}" data-sl-idx="${i}">
          <span class="sl-drag-handle">☰</span>
          <button class="sl-collapse-btn" data-sl-collapse="${s.id}" title="${isCollapsed ? 'Mostrar' : 'Esconder'} música" aria-label="${isCollapsed ? 'Mostrar' : 'Esconder'} música" aria-expanded="${isCollapsed ? 'false' : 'true'}">${isCollapsed ? '▸' : '▾'}</button>
          <div class="sl-info">
            <div class="sl-title">${esc(s.title)}</div>
            <div class="sl-artist">${esc(s.artist || '')}</div>
          </div>
          ${s.originalKey ? `<div class="sl-key" data-edit-key="${s.id}" title="Clique para editar o tom">${esc(s.originalKey)}</div>` : `<div class="sl-key sl-key--empty" data-edit-key="${s.id}" title="Definir o tom">—</div>`}
          <div class="sl-bpm" data-edit-bpm="${s.id}" title="Clique para editar BPM">${s.bpm ? s.bpm : '—'}</div>
          <div class="sl-actions">
            <button class="sl-btn ${isPlaying && state.isPlaying ? 'playing' : ''}" data-sl-play="${s.id}">
              ${isPlaying && state.isPlaying ? ICO.pause : ICO.play}
            </button>
            <button class="sl-btn" data-sl-metro="${s.id}" title="Metrônomo">${ICO.metro}</button>
          </div>
        </div>`;
        html += `<button class="sl-add-note-btn" data-add-note-pos="${songIdx + 0.5}" title="Adicionar anotação aqui">+ nota</button>`;
        songIdx++;
      } else {
        const n = item.note;
        html += `
        <div class="setlist-note" data-note-id="${n.id}" data-sl-idx="${i}">
          <span class="sl-drag-handle">☰</span>
          <span class="sl-note-icon">📝</span>
          <span class="sl-note-text">${esc(n.text)}</span>
          <button class="sl-note-del" data-del-note="${n.id}" title="Remover">×</button>
        </div>`;
      }
    }
    container.innerHTML = html;
    state._setlistItems = items;
    state._setlistPlaylistId = playlistId;
    if (!container._dragInited) {
      initSetlistDragDrop(container);
      container._dragInited = true;
    }
  }

  // ===== SETLIST DRAG & DROP =====

  function initSetlistDragDrop(container) {
    const getReorderEls = () => [...container.querySelectorAll('[data-sl-idx]')];
    let dragEl = null, dragClone = null, startY = 0, dragTimeout = null;

    function startDrag(el, clientY) {
      dragEl = el;
      if (navigator.vibrate) navigator.vibrate(30);
      const rect = el.getBoundingClientRect();
      dragClone = el.cloneNode(true);
      dragClone.className = (el.className || '') + ' sl-drag-clone';
      dragClone.style.cssText = `position:fixed;left:${rect.left}px;top:${rect.top}px;width:${rect.width}px;z-index:99999;opacity:0.85;pointer-events:none;box-shadow:0 4px 20px rgba(0,0,0,0.5);border-radius:10px;`;
      document.body.appendChild(dragClone);
      el.style.opacity = '0.3';
    }

    function moveDrag(clientY) {
      if (!dragEl) return;
      if (dragClone) dragClone.style.top = `${clientY - 24}px`;
      getReorderEls().forEach(item => {
        if (item === dragEl) return;
        const rect = item.getBoundingClientRect();
        item.classList.toggle('sl-drag-over', clientY > rect.top && clientY < rect.bottom);
      });
    }

    function endDrag() {
      clearTimeout(dragTimeout);
      if (!dragEl) return;
      const target = getReorderEls().find(item => item.classList.contains('sl-drag-over'));
      getReorderEls().forEach(item => item.classList.remove('sl-drag-over'));
      if (target && target !== dragEl) {
        const fromIdx = parseInt(dragEl.dataset.slIdx);
        const toIdx = parseInt(target.dataset.slIdx);
        applySetlistReorder(state._setlistPlaylistId, state._setlistItems, fromIdx, toIdx);
      } else {
        if (dragEl) dragEl.style.opacity = '';
      }
      if (dragClone) { dragClone.remove(); dragClone = null; }
      dragEl = null;
    }

    // --- Desktop: mousedown on handle starts drag immediately on move ---
    container.addEventListener('mousedown', (e) => {
      const handle = e.target.closest('.sl-drag-handle');
      if (!handle) return;
      const el = handle.closest('[data-sl-idx]');
      if (!el) return;
      e.preventDefault();
      startY = e.clientY;
      startDrag(el, e.clientY);

      const onMouseMove = (ev) => { moveDrag(ev.clientY); };
      const onMouseUp = () => {
        document.removeEventListener('mousemove', onMouseMove);
        document.removeEventListener('mouseup', onMouseUp);
        endDrag();
      };
      document.addEventListener('mousemove', onMouseMove);
      document.addEventListener('mouseup', onMouseUp);
    });

    // --- Mobile: long-press anywhere on item starts drag ---
    container.addEventListener('touchstart', (e) => {
      const el = e.target.closest('[data-sl-idx]');
      if (!el || e.target.closest('.sl-actions') || e.target.closest('.sl-note-del') || e.target.closest('.sl-add-note-btn') || e.target.closest('.sl-collapse-btn')) return;
      startY = e.touches[0].clientY;
      dragTimeout = setTimeout(() => { startDrag(el, e.touches[0].clientY); }, 400);
    }, { passive: true });

    container.addEventListener('touchmove', (e) => {
      if (!dragEl) {
        if (Math.abs(e.touches[0].clientY - startY) > 10) clearTimeout(dragTimeout);
        return;
      }
      e.preventDefault();
      moveDrag(e.touches[0].clientY);
    }, { passive: false });

    container.addEventListener('touchend', () => { clearTimeout(dragTimeout); endDrag(); });
    container.addEventListener('touchcancel', () => { clearTimeout(dragTimeout); endDrag(); });
  }

  async function applySetlistReorder(playlistId, items, fromIdx, toIdx) {
    // Move item in the array
    const moved = items.splice(fromIdx, 1)[0];
    items.splice(toIdx, 0, moved);

    // Reassign positions: songs get sequential integers, notes get fractional positions
    let songPos = 0;
    let noteCount = 0; // notes before the first song or between same songs
    const songOrder = [];
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      if (item.type === 'song') {
        const ps = state.playlistSongs.find(p => p.playlist_id === playlistId && p.song_id === item.song.id);
        if (ps) {
          ps.position = songPos;
          await idbPut('playlistSongs', ps);
        }
        songOrder.push(item.song.id);
        songPos++;
        noteCount = 0;
      } else {
        // Note: position relative to surrounding songs, with sub-ordering
        noteCount++;
        const basePos = songPos > 0 ? (songPos - 1) : -1;
        const notePos = basePos + (noteCount / 10); // e.g. -0.9, -0.8, ... or 0.1, 0.2, ...
        item.note.position = notePos;
        await idbPut('setlistNotes', item.note);
        const idx = state.setlistNotes.findIndex(n => n.id === item.note.id);
        if (idx >= 0) state.setlistNotes[idx] = item.note;
      }
    }

    // Sync song order to Stemizer server
    addPendingEdit('playlistOrder', null, { playlistId, songIds: songOrder });

    // Sync note positions to the server
    pushSetlistNotes(playlistId);

    // Re-render immediately
    renderSetlist(playlistId);
  }

  // ============================================================
  // Sync View
  // ============================================================
  async function refreshCatalog() {
    try {
      const res = await fetch('/api/catalog');
      state._catalog = await res.json();
    } catch {}
  }

  async function renderCatalog() {
    const container = document.getElementById('catalog-content');

    if (!state.isOnline) {
      container.innerHTML = `<div class="empty-state">${ICO.download}<h3>Sem conexão</h3><p>Conecte ao servidor para ver o catálogo.</p></div>`;
      return;
    }

    container.innerHTML = '<p style="text-align:center;color:var(--text-muted);padding:2rem">Carregando...</p>';

    let catalog;
    try {
      const res = await fetch('/api/catalog');
      catalog = await res.json();
    } catch (e) {
      container.innerHTML = `<div class="empty-state">${ICO.x}<h3>Erro</h3><p>${esc(e.message)}</p></div>`;
      return;
    }

    let html = '';
    if (catalog.playlists && catalog.playlists.length > 0) {
      html += '<div class="section-title">Playlists no servidor</div><div class="catalog-list">';
      for (const pl of catalog.playlists) {
        const isLocal = state.playlists.some(lp => lp.id === pl.id);
        const songIds = (catalog.playlistSongs || []).filter(ps => ps.playlist_id === pl.id).map(ps => ps.song_id);
        const songs = (catalog.songs || []).filter(s => songIds.includes(s.id));
        const totalSize = songs.reduce((a, s) => a + (s.size || 0), 0);
        html += `
          <div class="catalog-item">
            <div class="info">
              <div class="title">${esc(pl.title)}</div>
              <div class="meta">${songs.length} músicas · ${formatBytes(totalSize)}</div>
            </div>
            <div class="actions">
              ${isLocal
                ? `<span class="cached-badge">✓</span>
                   <button class="btn-sm btn-secondary" data-action="update-playlist" data-id="${pl.id}" title="Atualizar playlist">↻</button>
                   <button class="btn-sm btn-danger" data-action="remove-playlist" data-id="${pl.id}" title="Remover do dispositivo">✕</button>`
                : `<button class="btn-sm btn-primary" data-action="download-playlist" data-id="${pl.id}" title="Baixar para o dispositivo">${ICO.download} Baixar</button>`}
            </div>
          </div>`;
      }
      html += '</div>';
    }

    const inPlaylist = new Set((catalog.playlistSongs || []).map(ps => ps.song_id));
    const loose = (catalog.songs || []).filter(s => !inPlaylist.has(s.id));
    if (loose.length > 0) {
      html += '<div class="section-title">Músicas avulsas</div><div class="catalog-list">';
      for (const s of loose) {
        const isLocal = state.songs.some(ls => ls.id === s.id);
        html += `
          <div class="catalog-item">
            <div class="info">
              <div class="title">${esc(s.title)}</div>
              <div class="meta">${formatBytes(s.size || 0)}</div>
            </div>
            <div class="actions">
              ${isLocal
                ? `<span class="cached-badge">✓</span><button class="btn-sm btn-danger" data-action="remove-song" data-id="${s.id}" title="Remover do dispositivo">✕</button>`
                : `<button class="btn-sm btn-primary" data-action="download-song" data-id="${s.id}" title="Baixar para o dispositivo">${ICO.download}</button>`}
            </div>
          </div>`;
      }
      html += '</div>';
    }

    if (!html) html = `<div class="empty-state">${ICO.check}<h3>Catálogo vazio</h3></div>`;
    container.innerHTML = html;
    state._catalog = catalog;
  }

  // ============================================================
  // Download / Remove
  // ============================================================
  async function downloadPlaylist(playlistId) {
    const catalog = state._catalog;
    if (!catalog) return;
    const pl = catalog.playlists.find(p => p.id === playlistId);
    if (!pl) return;

    const songIds = (catalog.playlistSongs || []).filter(ps => ps.playlist_id === playlistId).map(ps => ps.song_id);
    const songs = (catalog.songs || []).filter(s => songIds.includes(s.id));

    const allUrls = [];
    for (const song of songs) {
      if (song.stems) allUrls.push(...Object.values(song.stems));
    }

    toast(`Baixando "${pl.title}" (${songs.length} músicas)...`, 'info', 4000);
    startDownloadBatch(pl.title, allUrls);

    await idbPut('playlists', { id: pl.id, title: pl.title, url: pl.url, position: pl.position || 0 });
    for (const ps of (catalog.playlistSongs || []).filter(ps => ps.playlist_id === playlistId)) {
      await idbPut('playlistSongs', ps);
    }
    for (const song of songs) {
      await idbPut('songs', {
        id: song.id, youtube_id: song.youtube_id, title: song.title, artist: song.artist,
        duration: song.duration, bpm: song.bpm, beatOffset: song.beatOffset,
        chords: song.chords, notes: song.notes, originalKey: song.originalKey,
        bpmSections: song.bpmSections, pitches: song.pitches, stems: song.stems,
        size: song.size, thumbnail: song.thumbnail || '', syncedAt: Date.now()
      });
    }

    await loadLocalData();
    renderLibrary();
    renderSetlistSelector();
  }

  // Verifica se a setlist local está desatualizada em relação ao servidor
  // (músicas adicionadas, removidas, reordenadas ou com metadados alterados)
  // e aplica as mudanças. Mantém no dispositivo apenas o que o servidor tem.
  async function syncSetlist(playlistId) {
    if (!playlistId) return;
    if (!state.isOnline) { toast('Sem conexão com o servidor', 'error'); return; }

    toast('Verificando alterações...', 'info', 2000);

    let catalog;
    try {
      const res = await fetch('/api/catalog');
      catalog = await res.json();
      state._catalog = catalog;
    } catch (e) {
      toast('Falha ao verificar: ' + e.message, 'error');
      return;
    }

    const pl = (catalog.playlists || []).find(p => p.id === playlistId);
    if (!pl) {
      toast('Setlist não existe mais no servidor', 'error');
      return;
    }

    const serverPS = (catalog.playlistSongs || []).filter(ps => ps.playlist_id === playlistId);
    const serverSongIds = serverPS.map(ps => ps.song_id);
    const serverSongs = (catalog.songs || []).filter(s => serverSongIds.includes(s.id));
    const serverSongById = new Map(serverSongs.map(s => [s.id, s]));

    const localPS = state.playlistSongs.filter(ps => ps.playlist_id === playlistId);
    const localSongIds = new Set(localPS.map(ps => ps.song_id));

    // Detectar diferenças
    const added = serverSongIds.filter(id => !localSongIds.has(id));
    const removed = [...localSongIds].filter(id => !serverSongIds.includes(id));

    // Reordenação / metadados alterados
    const localPSById = new Map(localPS.map(ps => [ps.song_id, ps]));
    let reordered = false;
    for (const ps of serverPS) {
      const lp = localPSById.get(ps.song_id);
      if (lp && (lp.position || 0) !== (ps.position || 0)) { reordered = true; break; }
    }
    let metaChanged = false;
    for (const s of serverSongs) {
      if (!localSongIds.has(s.id)) continue;
      const ls = state.songs.find(x => x.id === s.id);
      if (!ls) continue;
      if ((ls.title !== s.title) || (ls.bpm !== s.bpm) || (ls.originalKey !== s.originalKey)
        || JSON.stringify(ls.stems || {}) !== JSON.stringify(s.stems || {})
        || JSON.stringify(ls.pitches || [0]) !== JSON.stringify(s.pitches || [0])) {
        metaChanged = true;
      }
    }
    const titleChanged = (pl.title !== (state.playlists.find(p => p.id === playlistId) || {}).title);

    if (added.length === 0 && removed.length === 0 && !reordered && !metaChanged && !titleChanged) {
      toast('Setlist já está atualizada ✓', 'success');
      renderSetlist(playlistId);
      return;
    }

    // Aplicar mudanças ---------------------------------------------------

    // 1) Atualizar metadados da playlist (título, posição)
    await idbPut('playlists', { id: pl.id, title: pl.title, url: pl.url, position: pl.position || 0 });

    // 2) Remover músicas que saíram da setlist no servidor
    for (const songId of removed) {
      await idbDelete('playlistSongs', [playlistId, songId]);
      const inOther = state.playlistSongs.some(ps => ps.song_id === songId && ps.playlist_id !== playlistId);
      if (!inOther) {
        const song = state.songs.find(s => s.id === songId);
        if (song && navigator.serviceWorker && navigator.serviceWorker.controller) {
          navigator.serviceWorker.controller.postMessage({ type: 'PURGE_STEMS', youtubeId: song.youtube_id });
        }
        await idbDelete('songs', songId);
      }
    }

    // 3) Upsert vínculos playlist_songs (posições atualizadas) e músicas
    for (const ps of serverPS) {
      await idbPut('playlistSongs', ps);
    }

    const newUrls = [];
    for (const s of serverSongs) {
      await idbPut('songs', {
        id: s.id, youtube_id: s.youtube_id, title: s.title, artist: s.artist,
        duration: s.duration, bpm: s.bpm, beatOffset: s.beatOffset,
        chords: s.chords, notes: s.notes, originalKey: s.originalKey,
        bpmSections: s.bpmSections, pitches: s.pitches, stems: s.stems,
        size: s.size, thumbnail: s.thumbnail || '', syncedAt: Date.now()
      });
      // Baixar stems das músicas novas
      if (added.includes(s.id) && s.stems) newUrls.push(...Object.values(s.stems));
    }

    if (newUrls.length > 0 && navigator.serviceWorker && navigator.serviceWorker.controller) {
      showProgress(`Baixando ${added.length} música(s)`, 0, newUrls.length);
      navigator.serviceWorker.controller.postMessage({ type: 'CACHE_STEMS', urls: newUrls });
    }

    await loadLocalData();
    renderLibrary();
    renderSetlistSelector();
    // Manter a setlist selecionada após recarregar o seletor
    const sel = document.getElementById('setlist-select');
    if (sel) sel.value = playlistId;
    renderSetlist(playlistId);

    const parts = [];
    if (added.length) parts.push(`${added.length} adicionada(s)`);
    if (removed.length) parts.push(`${removed.length} removida(s)`);
    if (reordered) parts.push('reordenada');
    if (metaChanged) parts.push('metadados atualizados');
    toast('Setlist sincronizada: ' + parts.join(', '), 'success', 4000);
  }

  async function downloadSong(songId) {
    const catalog = state._catalog;
    if (!catalog) return;
    const song = (catalog.songs || []).find(s => s.id === songId);
    if (!song) return;

    const urls = song.stems ? Object.values(song.stems) : [];
    toast(`Baixando "${song.title}"...`, 'info', 3000);
    startDownloadBatch(song.title, urls);

    await idbPut('songs', {
      id: song.id, youtube_id: song.youtube_id, title: song.title, artist: song.artist,
      duration: song.duration, bpm: song.bpm, beatOffset: song.beatOffset,
      chords: song.chords, notes: song.notes, originalKey: song.originalKey,
      bpmSections: song.bpmSections, pitches: song.pitches, stems: song.stems,
      size: song.size, thumbnail: song.thumbnail || '', syncedAt: Date.now()
    });

    await loadLocalData();
    renderLibrary();
  }

  async function removePlaylist(playlistId) {
    const songIds = state.playlistSongs.filter(ps => ps.playlist_id === playlistId).map(ps => ps.song_id);

    for (const ps of state.playlistSongs.filter(ps => ps.playlist_id === playlistId)) {
      await idbDelete('playlistSongs', [ps.playlist_id, ps.song_id]);
    }
    for (const songId of songIds) {
      const inOther = state.playlistSongs.some(ps => ps.song_id === songId && ps.playlist_id !== playlistId);
      if (!inOther) {
        const song = state.songs.find(s => s.id === songId);
        if (song && navigator.serviceWorker && navigator.serviceWorker.controller) {
          navigator.serviceWorker.controller.postMessage({ type: 'PURGE_STEMS', youtubeId: song.youtube_id });
        }
        await idbDelete('songs', songId);
      }
    }
    // Remove associated setlist notes
    for (const note of state.setlistNotes.filter(n => n.playlist_id === playlistId)) {
      await idbDelete('setlistNotes', note.id);
    }
    await idbDelete('playlists', playlistId);
    await loadLocalData();
    renderLibrary();
    renderSetlistSelector();
    renderCatalog();
  }

  async function removeSong(songId) {
    const song = state.songs.find(s => s.id === songId);
    if (song && navigator.serviceWorker && navigator.serviceWorker.controller) {
      navigator.serviceWorker.controller.postMessage({ type: 'PURGE_STEMS', youtubeId: song.youtube_id });
    }
    for (const ps of state.playlistSongs.filter(ps => ps.song_id === songId)) {
      await idbDelete('playlistSongs', [ps.playlist_id, ps.song_id]);
    }
    await idbDelete('songs', songId);
    await loadLocalData();
    renderLibrary();
    renderCatalog();
  }

  // ============================================================
  // Song Settings (localStorage)
  // ============================================================
  function loadSongSettings(songId) {
    const key = `showtime_song_${songId}`;
    const legacyKey = `showtime_${songId}`;
    try {
      let raw = localStorage.getItem(key);
      if (!raw) raw = localStorage.getItem(legacyKey); // fallback to old format
      const saved = JSON.parse(raw || '{}');
      state.loopA = saved.loopA ?? null;
      state.loopB = saved.loopB ?? null;
      state.trimBefore = saved.trimBefore ?? null;
      state.trimAfter = saved.trimAfter ?? null;
      if (saved.bpm != null) state.bpm = saved.bpm;
      if (saved.beatOffset != null) state.beatOffset = saved.beatOffset;
      if (saved.songGain != null) state.songGain = saved.songGain;
    } catch {
      state.loopA = null;
      state.loopB = null;
      state.trimBefore = null;
      state.trimAfter = null;
    }

    // Load playlist-scoped settings
    loadPlaylistSettings();
  }

  function saveSongSettings() {
    if (!state.currentSongId) return;
    const key = `showtime_song_${state.currentSongId}`;
    localStorage.setItem(key, JSON.stringify({
      loopA: state.loopA,
      loopB: state.loopB,
      trimBefore: state.trimBefore,
      trimAfter: state.trimAfter,
      bpm: state.bpm,
      beatOffset: state.beatOffset,
      songGain: state.songGain,
    }));
  }

  function getActivePlaylistId() {
    return state.currentPlaylistId || state._selectedSetlist || '_global';
  }

  function loadPlaylistSettings() {
    const key = `showtime_pl_${getActivePlaylistId()}`;
    try {
      const saved = JSON.parse(localStorage.getItem(key) || '{}');
      state.metronome.enabled = saved.metronomeEnabled ?? false;
      state.metronome.sound = saved.metronomeSound || 'click';
      state.metronome.volume = saved.metronomeVolume ?? 0.6;
      state.notesEnabled = saved.notesEnabled ?? true;
      state.notesAudioEnabled = saved.notesAudioEnabled ?? true;
      state.repeatMode = saved.repeatMode || 'off';
      state.speed = saved.speed ?? 1;
      state.masterVolume = saved.masterVolume ?? 1;
      state.masterMuted = false;
      // Mixer state
      state.muted = new Set(saved.muted || []);
      state.soloed = new Set(saved.soloed || []);
      state.volumes = saved.volumes || {};
    } catch {
      state.metronome.enabled = false;
      state.notesEnabled = true;
      state.notesAudioEnabled = true;
      state.repeatMode = 'off';
      state.speed = 1;
      state.masterVolume = 1;
      state.muted = new Set();
      state.soloed = new Set();
      state.volumes = {};
    }
    // Sync UI
    const metroSel = document.getElementById('metro-sound-select');
    if (metroSel) metroSel.value = state.metronome.sound;
  }

  function savePlaylistSettings() {
    const key = `showtime_pl_${getActivePlaylistId()}`;
    localStorage.setItem(key, JSON.stringify({
      metronomeEnabled: state.metronome.enabled,
      metronomeSound: state.metronome.sound,
      metronomeVolume: state.metronome.volume,
      notesEnabled: state.notesEnabled,
      notesAudioEnabled: state.notesAudioEnabled,
      repeatMode: state.repeatMode,
      speed: state.speed,
      masterVolume: state.masterVolume,
      muted: [...state.muted],
      soloed: [...state.soloed],
      volumes: state.volumes,
    }));
  }

  // ============================================================
  // Navigation
  // ============================================================
  function switchView(viewId) {
    document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
    document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
    document.getElementById(viewId)?.classList.add('active');
    document.querySelector(`[data-view="${viewId}"]`)?.classList.add('active');
    state.currentView = viewId;

    if (viewId === 'sync-view') { renderCatalog(); requestCacheSize(); }
    if (viewId === 'queue-view') { renderQueue(); }
    if (viewId === 'setlist-view') {
      renderSetlistSelector();
      const sel = document.getElementById('setlist-select');
      // Restore previous selection
      if (state._selectedSetlist) sel.value = state._selectedSetlist;
      if (sel.value) renderSetlist(sel.value);
    }
  }

  // ============================================================
  // Playback Queue ("Tocando agora")
  // ============================================================
  // QUEUE_LS_KEY imported from constants.js

  function saveQueue() {
    try {
      localStorage.setItem(QUEUE_LS_KEY, JSON.stringify({
        queue: state.queue,
        queueIndex: state.queueIndex,
        queueContext: state.queueContext,
      }));
    } catch (e) { /* storage full / unavailable — non-fatal */ }
  }

  function loadQueue() {
    try {
      const raw = localStorage.getItem(QUEUE_LS_KEY);
      if (!raw) return;
      const data = JSON.parse(raw);
      if (Array.isArray(data.queue)) {
        // Drop any songs no longer available locally.
        const valid = new Set(state.songs.map(s => s.id));
        state.queue = data.queue.filter(id => valid.has(id));
        state.queueIndex = Math.min(Math.max(-1, data.queueIndex ?? -1), state.queue.length - 1);
        state.queueContext = data.queueContext || null;
      }
    } catch (e) { /* ignore corrupt data */ }
  }

  // Replace the whole queue (e.g. when starting a playlist or a single song).
  function setQueue(ids, startIndex = 0, context = null) {
    state.queue = Array.isArray(ids) ? [...ids] : [];
    state.queueIndex = state.queue.length ? Math.min(Math.max(0, startIndex), state.queue.length - 1) : -1;
    state.queueContext = context;
    saveQueue();
    renderQueue();
  }

  // Insert songs right after the currently-playing one ("Tocar a seguir").
  function queuePlayNext(ids) {
    const list = Array.isArray(ids) ? ids : [ids];
    if (!list.length) return;
    const at = state.queueIndex >= 0 ? state.queueIndex + 1 : state.queue.length;
    state.queue.splice(at, 0, ...list);
    if (state.queueIndex < 0 && state.queue.length) state.queueIndex = -1; // nothing playing yet
    saveQueue();
    renderQueue();
  }

  // Append songs to the end of the queue ("Adicionar ao final").
  function queueAppend(ids) {
    const list = Array.isArray(ids) ? ids : [ids];
    if (!list.length) return;
    state.queue.push(...list);
    saveQueue();
    renderQueue();
  }

  // Remove one entry (by queue position) without touching any saved playlist.
  function queueRemoveAt(index) {
    if (index < 0 || index >= state.queue.length) return;
    state.queue.splice(index, 1);
    if (index < state.queueIndex) state.queueIndex--;
    else if (index === state.queueIndex) {
      // Removed the current song: clamp index so next/prev still make sense.
      state.queueIndex = Math.min(state.queueIndex, state.queue.length - 1);
    }
    saveQueue();
    renderQueue();
  }

  function clearQueue() {
    state.queue = [];
    state.queueIndex = -1;
    state.queueContext = null;
    saveQueue();
    renderQueue();
  }

  // Move a queue item from one index to another (drag reorder).
  function queueMove(fromIdx, toIdx) {
    if (fromIdx === toIdx || fromIdx < 0 || toIdx < 0) return;
    if (fromIdx >= state.queue.length || toIdx >= state.queue.length) return;
    const moved = state.queue.splice(fromIdx, 1)[0];
    state.queue.splice(toIdx, 0, moved);
    // Keep queueIndex pointing at the same currently-playing song.
    const curId = state.currentSongId;
    const newIdx = state.queue.indexOf(curId);
    if (newIdx !== -1) state.queueIndex = newIdx;
    saveQueue();
    renderQueue();
  }

  // Play a specific position in the queue.
  function playQueueAt(index) {
    if (index < 0 || index >= state.queue.length) return;
    state.queueIndex = index;
    saveQueue();
    loadSong(state.queue[index], { navigate: false }).then(() => startPlayback());
  }

  // Rendered by the "Tocando agora" view (defined later). Safe no-op if the
  // view container isn't present yet.
  function renderQueue() {
    const container = document.getElementById('queue-content');
    if (!container) return;
    renderQueueInto(container);
  }

  function renderQueueInto(container) {
    if (!state.queue.length) {
      container.innerHTML = `<div class="empty-state">${ICO.music}<h3>Fila vazia</h3><p>Toque uma música ou uma setlist para começar.</p></div>`;
      return;
    }
    let html = '';
    if (state.queueContext) {
      html += `<div class="q-context-label">De: ${esc(state.queueContext)}</div>`;
    }
    state.queue.forEach((songId, i) => {
      const song = state.songs.find(s => s.id === songId);
      if (!song) return;
      const isCurrent = i === state.queueIndex;
      const isPlayed = i < state.queueIndex;
      const isNext = i === state.queueIndex + 1;
      const cls = isCurrent ? 'playing' : (isPlayed ? 'q-played' : 'q-up-next');
      const badge = isCurrent ? '<span class="q-badge">Tocando</span>'
        : (isNext ? '<span class="q-badge">A seguir</span>' : '');
      const icon = (isCurrent && state.isPlaying) ? ICO.pause : ICO.play;
      html += `
        <div class="queue-item ${cls}" data-q-idx="${i}" data-song-id="${songId}">
          <span class="q-drag-handle" data-q-drag>☰</span>
          <div class="q-info">
            <div class="q-title">${esc(song.title)}</div>
            <div class="q-artist">${esc(song.artist || '')}</div>
          </div>
          ${badge}
          <button class="q-play" data-q-play="${i}" title="Tocar">${icon}</button>
          <button class="q-remove" data-q-remove="${i}" title="Remover da fila" aria-label="Remover da fila">×</button>
        </div>`;
    });
    container.innerHTML = html;
    if (!container._dragInited) {
      initQueueDragDrop(container);
      container._dragInited = true;
    }
  }

  // Long-press / handle drag to reorder the queue (touch + mouse).
  function initQueueDragDrop(container) {
    let dragEl = null, dragClone = null, dragTimeout = null, startY = 0;

    function itemsList() { return [...container.querySelectorAll('[data-q-idx]')]; }

    function startDrag(el, clientY) {
      dragEl = el;
      if (navigator.vibrate) navigator.vibrate(20);
      const rect = el.getBoundingClientRect();
      dragClone = el.cloneNode(true);
      dragClone.classList.add('q-drag-clone');
      dragClone.style.cssText += `position:fixed;left:${rect.left}px;top:${rect.top}px;width:${rect.width}px;`;
      document.body.appendChild(dragClone);
      el.style.opacity = '0.3';
    }
    function moveDrag(clientY) {
      if (!dragEl) return;
      if (dragClone) dragClone.style.top = `${clientY - 24}px`;
      itemsList().forEach(item => {
        if (item === dragEl) return;
        const r = item.getBoundingClientRect();
        if (clientY > r.top && clientY < r.bottom) {
          const mid = r.top + r.height / 2;
          if (clientY < mid) item.parentNode.insertBefore(dragEl, item);
          else item.parentNode.insertBefore(dragEl, item.nextSibling);
        }
      });
    }
    function endDrag() {
      if (dragClone) { dragClone.remove(); dragClone = null; }
      if (!dragEl) return;
      dragEl.style.opacity = '';
      const from = parseInt(dragEl.dataset.qIdx);
      const to = itemsList().indexOf(dragEl);
      dragEl = null;
      if (!isNaN(from) && to !== -1 && from !== to) queueMove(from, to);
      else renderQueue();
    }

    // Touch: long-press on handle or item body starts drag.
    container.addEventListener('touchstart', (e) => {
      const el = e.target.closest('[data-q-idx]');
      if (!el || e.target.closest('.q-play') || e.target.closest('.q-remove')) return;
      startY = e.touches[0].clientY;
      dragTimeout = setTimeout(() => startDrag(el, e.touches[0].clientY), 350);
    }, { passive: true });
    container.addEventListener('touchmove', (e) => {
      if (!dragEl) { if (Math.abs(e.touches[0].clientY - startY) > 10) clearTimeout(dragTimeout); return; }
      e.preventDefault();
      moveDrag(e.touches[0].clientY);
    }, { passive: false });
    container.addEventListener('touchend', () => { clearTimeout(dragTimeout); endDrag(); });
    container.addEventListener('touchcancel', () => { clearTimeout(dragTimeout); endDrag(); });

    // Mouse: drag from the handle only.
    container.addEventListener('pointerdown', (e) => {
      if (e.pointerType !== 'mouse') return;
      const handle = e.target.closest('[data-q-drag]');
      if (!handle) return;
      const el = handle.closest('[data-q-idx]');
      if (!el) return;
      e.preventDefault();
      startDrag(el, e.clientY);
      const onMove = (ev) => moveDrag(ev.clientY);
      const onUp = () => { document.removeEventListener('pointermove', onMove); document.removeEventListener('pointerup', onUp); endDrag(); };
      document.addEventListener('pointermove', onMove);
      document.addEventListener('pointerup', onUp);
    });
  }

  // Generic bottom action sheet. items: [{ label, icon?, danger?, onClick }]
  function showActionSheet(title, items) {
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    overlay.innerHTML = `
      <div class="modal-box">
        <h3>${esc(title)}</h3>
        <div class="action-sheet-items">
          ${items.map((it, i) => `<button class="action-sheet-item ${it.danger ? 'danger' : ''}" data-as-idx="${i}">${it.icon ? it.icon + ' ' : ''}${esc(it.label)}</button>`).join('')}
        </div>
        <div style="display:flex;justify-content:flex-end;margin-top:0.4rem">
          <button class="modal-btn cancel" data-as-cancel>Fechar</button>
        </div>
      </div>`;
    mountOverlay(overlay);
    const close = () => overlay.remove();
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay || e.target.closest('[data-as-cancel]')) return close();
      const btn = e.target.closest('[data-as-idx]');
      if (btn) {
        const idx = parseInt(btn.dataset.asIdx);
        close();
        items[idx]?.onClick?.();
      }
    });
  }

  function showSongActions(songId) {
    const song = state.songs.find(s => s.id === songId);
    if (!song) return;
    showActionSheet(song.title, [
      { label: 'Tocar a seguir', icon: '⏭', onClick: () => { queuePlayNext(songId); toast('Adicionada para tocar a seguir', 'success'); } },
      { label: 'Adicionar ao final da fila', icon: '➕', onClick: () => { queueAppend(songId); toast('Adicionada ao final da fila', 'success'); } },
    ]);
  }

  function showPlaylistActions(playlistId) {
    const pl = state.playlists.find(p => p.id === playlistId);
    if (!pl) return;
    const ids = state.playlistSongs
      .filter(ps => ps.playlist_id === playlistId)
      .sort((a, b) => (a.position || 0) - (b.position || 0))
      .map(ps => ps.song_id)
      .filter(id => state.songs.some(s => s.id === id));
    showActionSheet(pl.title, [
      { label: 'Tocar a seguir', icon: '⏭', onClick: () => { queuePlayNext(ids); toast(`${ids.length} músicas para tocar a seguir`, 'success'); } },
      { label: 'Adicionar ao final da fila', icon: '➕', onClick: () => { queueAppend(ids); toast(`${ids.length} músicas adicionadas à fila`, 'success'); } },
    ]);
  }

  // ============================================================
  // Prev / Next Song
  // ============================================================
  function getPlaylistSongIds() {    if (state.currentPlaylistId) {
      return state.playlistSongs
        .filter(ps => ps.playlist_id === state.currentPlaylistId)
        .sort((a, b) => (a.position || 0) - (b.position || 0))
        .map(ps => ps.song_id);
    }
    return state.songs.map(s => s.id);
  }

  function playPlaylist(shuffle = false) {
    if (!state.currentPlaylistId) return;
    const ids = getPlaylistSongIds();
    if (ids.length === 0) return;
    const pl = state.playlists.find(p => p.id === state.currentPlaylistId);
    let order = ids;
    if (shuffle) {
      // Fisher-Yates shuffle
      order = [...ids];
      for (let i = order.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [order[i], order[j]] = [order[j], order[i]];
      }
    }
    // Starting a playlist REPLACES the queue with this context.
    setQueue(order, 0, pl ? pl.title : null);
    loadSong(order[0]).then(() => startPlayback());
  }

  function playNextSong() {
    if (state.repeatMode === 'one') { seekTo(state.trimBefore || 0); startPlayback(); return; }
    if (!state.queue.length) return;
    let next = state.queueIndex + 1;
    if (next >= state.queue.length) {
      if (state.repeatMode === 'all') next = 0;
      else return; // end of queue
    }
    state.queueIndex = next;
    saveQueue();
    loadSong(state.queue[next]);
    renderQueue();
  }

  function playPrevSong() {
    if (!state.queue.length) return;
    let prev = state.queueIndex - 1;
    if (prev < 0) {
      if (state.repeatMode === 'all') prev = state.queue.length - 1;
      else return;
    }
    state.queueIndex = prev;
    saveQueue();
    loadSong(state.queue[prev]);
    renderQueue();
  }

  // ============================================================
  // Progress & Storage
  // ============================================================
  // Aggregated download manager. Several downloads (e.g. multiple setlists)
  // can run concurrently; each is a "batch". We sum their totals/progress into
  // a single banner instead of letting each overwrite the other (which caused
  // a jumpy count and progress bar, and an early hide on the first complete).
  const _dl = { batches: new Map(), seq: 0 };

  // Register a new download batch and tell the SW to cache its URLs. Returns
  // the batchId. If urls is empty, nothing is shown.
  function startDownloadBatch(title, urls) {
    if (!urls || urls.length === 0) return null;
    const batchId = `dl-${Date.now()}-${++_dl.seq}`;
    _dl.batches.set(batchId, { title, total: urls.length, done: 0, complete: false });
    if (navigator.serviceWorker && navigator.serviceWorker.controller) {
      navigator.serviceWorker.controller.postMessage({ type: 'CACHE_STEMS', urls, batchId });
    }
    renderDownloadProgress();
    return batchId;
  }

  function onBatchProgress(batchId, done, total) {
    const b = _dl.batches.get(batchId);
    if (!b) return;
    b.done = done;
    b.total = total;
    renderDownloadProgress();
  }

  function onBatchComplete(batchId) {
    const b = _dl.batches.get(batchId);
    if (b) { b.complete = true; b.done = b.total; }
    renderDownloadProgress();
    // When every batch is finished, clear the banner and notify once.
    const allDone = _dl.batches.size > 0 && [..._dl.batches.values()].every(x => x.complete);
    if (allDone) {
      _dl.batches.clear();
      hideProgress();
      toast('Download concluído!', 'success');
      renderCatalog();
    }
  }

  // Draw the single aggregated banner from the sum of all active batches.
  function renderDownloadProgress() {
    const batches = [..._dl.batches.values()];
    if (batches.length === 0) { hideProgress(); return; }
    const total = batches.reduce((a, b) => a + b.total, 0);
    const done = batches.reduce((a, b) => a + b.done, 0);
    const active = batches.filter(b => !b.complete).length;
    let title;
    if (batches.length === 1) title = batches[0].title;
    else title = `Baixando ${batches.length} itens${active ? '' : ' (finalizando…)'}`;
    showProgress(title, done, total);
  }

  function showProgress(title, current, total) {
    document.getElementById('progress-banner').classList.add('visible');
    document.getElementById('progress-title').textContent = title;
    updateProgress(current, total);
  }

  function updateProgress(current, total) {
    const pct = total > 0 ? Math.round((current / total) * 100) : 0;
    document.getElementById('progress-fill').style.width = pct + '%';
    document.getElementById('progress-status').textContent = `${current}/${total}`;
  }

  function hideProgress() {
    document.getElementById('progress-banner').classList.remove('visible');
  }

  function requestCacheSize() {
    if (navigator.serviceWorker && navigator.serviceWorker.controller) {
      navigator.serviceWorker.controller.postMessage({ type: 'GET_CACHE_SIZE' });
    }
  }

  function updateStorageDisplay(totalSize) {
    const el = document.getElementById('storage-used');
    if (el) el.textContent = formatBytes(totalSize);
    if (navigator.storage && navigator.storage.estimate) {
      navigator.storage.estimate().then(({ usage, quota }) => {
        const pct = quota > 0 ? Math.round((usage / quota) * 100) : 0;
        const fill = document.getElementById('storage-fill');
        if (fill) fill.style.width = pct + '%';
        const avail = document.getElementById('storage-available');
        if (avail) avail.textContent = `${formatBytes(quota - usage)} livres`;
      });
    }
  }

  // ============================================================
  // Events (Delegation)
  // ============================================================
  function initEvents() {
    // Handle screen-off / tab-hidden transitions to keep background playback
    // stable (resume AudioContext, gentle re-sync, pause visual work).
    document.addEventListener('visibilitychange', handleVisibilityChange);

    // Logo click = hard refresh
    document.querySelector('.header h1').addEventListener('click', () => {
      if (navigator.serviceWorker && navigator.serviceWorker.controller) {
        navigator.serviceWorker.controller.postMessage({ type: 'SKIP_WAITING' });
      }
      // Clear all app caches to force fresh content
      caches.keys().then(keys => Promise.all(keys.filter(k => k.startsWith('showtime-app')).map(k => caches.delete(k)))).then(() => {
        location.reload(true);
      });
    });

    // Nav bar
    document.getElementById('nav-bar').addEventListener('click', (e) => {
      const item = e.target.closest('.nav-item');
      if (item?.dataset.view) switchView(item.dataset.view);
    });

    // Queue view ("Tocando agora")
    document.getElementById('queue-content').addEventListener('click', (e) => {
      const playBtn = e.target.closest('[data-q-play]');
      if (playBtn) { playQueueAt(parseInt(playBtn.dataset.qPlay)); return; }
      const rmBtn = e.target.closest('[data-q-remove]');
      if (rmBtn) { queueRemoveAt(parseInt(rmBtn.dataset.qRemove)); return; }
    });
    document.getElementById('queue-clear').addEventListener('click', () => {
      clearQueue();
    });

    // Library
    document.getElementById('library-content').addEventListener('click', (e) => {
      if (e.target.closest('#lib-back')) { state.currentPlaylistId = null; renderLibrary(); return; }
      if (e.target.closest('#pl-play-all')) { playPlaylist(false); return; }
      if (e.target.closest('#pl-shuffle')) { playPlaylist(true); return; }
      // Per-item options menu (queue actions) — check before play/navigate.
      const songMenu = e.target.closest('[data-song-menu]');
      if (songMenu) { showSongActions(songMenu.dataset.songMenu); return; }
      const plMenu = e.target.closest('[data-playlist-menu]');
      if (plMenu) { showPlaylistActions(plMenu.dataset.playlistMenu); return; }
      const plCard = e.target.closest('[data-playlist-id]');
      if (plCard) { state.currentPlaylistId = plCard.dataset.playlistId; loadPlaylistSettings(); renderLibrary(); return; }
      const songItem = e.target.closest('[data-song-id]');
      if (songItem) {
        const songId = songItem.dataset.songId;
        // Tapping a song sets the queue to the current browsing context
        // (the open playlist, or the full library) starting at this song.
        const ctxIds = getPlaylistSongIds();
        const startAt = ctxIds.indexOf(songId);
        if (startAt !== -1) {
          const pl = state.currentPlaylistId ? state.playlists.find(p => p.id === state.currentPlaylistId) : null;
          setQueue(ctxIds, startAt, pl ? pl.title : 'Biblioteca');
        } else {
          setQueue([songId], 0, 'Biblioteca');
        }
        loadSong(songId);
        return;
      }
    });

    // Long-press fast forward/rewind
    let _longPressInterval = null;
    document.getElementById('player-container').addEventListener('pointerdown', (e) => {
      const btn = e.target.closest('[data-action="back10"], [data-action="fwd10"]');
      if (!btn) return;
      const dir = btn.dataset.action === 'fwd10' ? 1 : -1;
      // Start fast seek after 400ms hold
      const startFast = setTimeout(() => {
        _longPressInterval = setInterval(() => seekTo(getCurrentTime() + dir * 5), 100);
      }, 400);
      const onUp = () => {
        clearTimeout(startFast);
        if (_longPressInterval) { clearInterval(_longPressInterval); _longPressInterval = null; }
        document.removeEventListener('pointerup', onUp);
        document.removeEventListener('pointercancel', onUp);
      };
      document.addEventListener('pointerup', onUp);
      document.addEventListener('pointercancel', onUp);
    });

    // Player view (delegation — covers both player-container and transport)
    document.getElementById('player-view').addEventListener('click', (e) => {
      // Edit key (tom) — chip in the now-playing bar
      const keyEl = e.target.closest('[data-edit-key]');
      if (keyEl) {
        const songId = keyEl.dataset.editKey;
        const song = state.songs.find(s => s.id === songId) || state.currentSong;
        if (song) showKeyPickerModal(song, () => renderPlayer());
        return;
      }
      // Transport actions
      const action = e.target.closest('[data-action]')?.dataset.action;
      if (action === 'toggle') togglePlay();
      else if (action === 'back10') { if (!_longPressInterval) seekTo(getCurrentTime() - 10); }
      else if (action === 'fwd10') { if (!_longPressInterval) seekTo(getCurrentTime() + 10); }
      else if (action === 'prev') playPrevSong();
      else if (action === 'next') playNextSong();
      else if (action === 'master-mute') toggleMasterMute();
      else if (action === 'gain-down') adjustSongGain(-10);
      else if (action === 'gain-up') adjustSongGain(10);
      else if (action === 'gain-reset') resetSongGain();
      else if (action === 'repeat') cycleRepeat();

      // Mute/Solo
      const muteBtn = e.target.closest('[data-mute]');
      if (muteBtn) { toggleMute(muteBtn.dataset.mute); return; }
      const soloBtn = e.target.closest('[data-solo]');
      if (soloBtn) { toggleSolo(soloBtn.dataset.solo); return; }

      // Mixer nav (mobile)
      const mixerNav = e.target.closest('[data-mixer-nav]');
      if (mixerNav) {
        if (mixerNav.dataset.mixerNav === 'prev' && state._mixerStemIdx > 0) state._mixerStemIdx--;
        else if (mixerNav.dataset.mixerNav === 'next') state._mixerStemIdx++;
        renderMixer();
        return;
      }

      // Tools page dots
      const dot = e.target.closest('[data-tools-page]');
      if (dot) {
        state._toolsPage = parseInt(dot.dataset.toolsPage);
        const pages = document.getElementById('tools-pages');
        if (pages) pages.style.transform = `translateX(-${state._toolsPage * 100}%)`;
        document.querySelectorAll('.tools-dot').forEach((d, i) => d.style.background = i === state._toolsPage ? 'var(--accent)' : 'var(--surface-3)');
        return;
      }

      // Pitch buttons
      const pitchBtn = e.target.closest('[data-pitch]');
      if (pitchBtn) { switchPitch(parseInt(pitchBtn.dataset.pitch)); return; }

      // Toggle the "generate new tone" picker row
      const pitchGenToggle = e.target.closest('[data-pitch-gen-toggle]');
      if (pitchGenToggle) {
        const row = document.getElementById('pitch-gen-row');
        if (row) row.style.display = row.style.display === 'none' ? 'flex' : 'none';
        return;
      }

      // Request generation of a specific semitone
      const pitchGenBtn = e.target.closest('[data-pitch-gen]');
      if (pitchGenBtn) { requestPitchGeneration(parseInt(pitchGenBtn.dataset.pitchGen)); return; }

      // Presets
      const loadP = e.target.closest('[data-load-preset]');
      if (loadP) { loadPreset(parseInt(loadP.dataset.loadPreset)); return; }
      const delP = e.target.closest('[data-del-preset]');
      if (delP) { deletePreset(parseInt(delP.dataset.delPreset)); renderPlayer(); return; }

      // Tool chips (debounce to prevent double-fire from synthetic + native click)
      const tool = e.target.closest('[data-tool]')?.dataset.tool;
      if (tool) {
        const now = Date.now();
        const toolBtn = e.target.closest('[data-tool]');
        if (toolBtn._lastToolClick && now - toolBtn._lastToolClick < 300) return;
        toolBtn._lastToolClick = now;

        if (tool === 'metronome') { toggleMetronome(); toolBtn.classList.toggle('active', state.metronome.enabled); }
        else if (tool === 'loop-a') { if (state.loopA != null) { state.loopA = null; renderLoopUI(); saveSongSettings(); } else setLoopA(); }
        else if (tool === 'loop-b') { if (state.loopB != null) { state.loopB = null; renderLoopUI(); saveSongSettings(); } else setLoopB(); }
        else if (tool === 'loop-clear') clearLoop();
        else if (tool === 'trim-before') setTrimBefore();
        else if (tool === 'trim-after') setTrimAfter();
        else if (tool === 'trim-clear') clearTrim();
        else if (tool === 'tap-tempo') handleTapTempo();
        else if (tool === 'beat-align') showBeatAlignModal();
        else if (tool === 'bpm-sections') showBpmSectionsModal();
        else if (tool === 'notes') { state.notesEnabled = !state.notesEnabled; toolBtn.classList.toggle('active', state.notesEnabled); savePlaylistSettings(); }
        else if (tool === 'notes-audio') { state.notesAudioEnabled = !state.notesAudioEnabled; toolBtn.classList.toggle('active', state.notesAudioEnabled); savePlaylistSettings(); }
        else if (tool === 'notes-add') showAddNoteModal();
        else if (tool === 'notes-list') showNotesListModal();
        else if (tool === 'notes-gen-tts') requestNotesTTS();
        else if (tool === 'save-preset') {
          const input = document.getElementById('preset-name-input');
          const name = input ? input.value.trim() : '';
          savePreset(name || `Preset ${getPresets().length + 1}`);
          renderPlayer();
        }
        return;
      }

      // If no interactive element was clicked, treat as play/pause (with delay to distinguish from dblclick)
      if (!action && !muteBtn && !soloBtn && !mixerNav && !dot && !pitchBtn && !loadP && !delP) {
        const isInteractive = e.target.closest('button, input, select, label, [contenteditable="true"], [data-tool], [data-action], [data-stem-vol], [data-load-preset], [data-del-preset], .timeline, .stem-row, .mixer-mobile, .mixer, .now-playing-bar, .chord-bar, .tools-section, .transport, .time-labels');
        if (!isInteractive && state.currentSong) {
          if (state._playPauseTimeout) clearTimeout(state._playPauseTimeout);
          state._playPauseTimeout = setTimeout(() => { state._playPauseTimeout = null; togglePlay(); }, 250);
        }
      }
    });

    // Player: volume sliders (input event)
    document.getElementById('player-container').addEventListener('input', (e) => {
      const volSlider = e.target.closest('[data-stem-vol]');
      if (volSlider) {
        const pct = parseInt(volSlider.value);
        setVolume(volSlider.dataset.stemVol, pct / 100);
        // Atualiza o valor numérico (%) exibido ao lado do slider.
        // Mobile: span irmão com text-align:right. Desktop: label .stem-vol-label se existir.
        const label = volSlider.parentElement?.querySelector('.stem-vol-label, [style*="text-align:right"]');
        if (label) label.textContent = `${pct}%`;
        return;
      }
      if (e.target.id === 'speed-range') {
        setSpeed(parseInt(e.target.value) / 100);
      }
      if (e.target.id === 'master-vol-slider') {
        setMasterVolume(parseInt(e.target.value) / 100);
        savePlaylistSettings();
      }
    });

    // Mouse wheel on volume faders adjusts volume
    document.getElementById('player-container').addEventListener('wheel', (e) => {
      const volSlider = e.target.closest('[data-stem-vol]');
      if (volSlider) {
        e.preventDefault();
        const step = e.deltaY < 0 ? 5 : -5;
        const newVal = Math.max(0, Math.min(150, parseInt(volSlider.value) + step));
        volSlider.value = newVal;
        setVolume(volSlider.dataset.stemVol, newVal / 100);
        const label = volSlider.parentElement?.querySelector('.stem-vol-label, [style*="text-align:right"]');
        if (label) label.textContent = `${newVal}%`;
        return;
      }
      const masterSlider = e.target.closest('#master-vol-slider');
      if (masterSlider) {
        e.preventDefault();
        const step = e.deltaY < 0 ? 5 : -5;
        const newVal = Math.max(0, Math.min(100, parseInt(masterSlider.value) + step));
        masterSlider.value = newVal;
        setMasterVolume(newVal / 100);
        savePlaylistSettings();
      }
    }, { passive: false });

    // Double-tap/click to reset sliders to default value
    document.getElementById('player-view').addEventListener('dblclick', (e) => {
      // Double-click on empty area: left half = rewind 10s, right half = forward 10s
      const isInteractive = e.target.closest('button, input, select, label, [contenteditable="true"], [data-tool], [data-action], [data-stem-vol], [data-load-preset], [data-del-preset], .timeline, .stem-row, .mixer-mobile, .mixer, .now-playing-bar, .chord-bar, .tools-section, .transport, .time-labels');
      if (!isInteractive && state.currentSong) {
        if (state._playPauseTimeout) { clearTimeout(state._playPauseTimeout); state._playPauseTimeout = null; }
        const container = document.getElementById('player-container');
        const rect = container.getBoundingClientRect();
        const x = e.clientX - rect.left;
        if (x > rect.width / 2) {
          seekTo(getCurrentTime() + 10);
        } else {
          seekTo(getCurrentTime() - 10);
        }
        return;
      }

      // Speed: reset to 1.0x
      if (e.target.id === 'speed-range' || e.target.id === 'speed-value' || e.target.closest('#speed-value')) {
        setSpeed(1.0);
        return;
      }
      // Stem volume: reset to 100%
      const stemVol = e.target.closest('[data-stem-vol]');
      if (stemVol) {
        const name = stemVol.dataset.stemVol;
        state.volumes[name] = 1;
        stemVol.value = 100;
        updateGains();
        // Update the % label if present
        const label = stemVol.parentElement?.querySelector('span');
        if (label && label.textContent.includes('%')) label.textContent = '100%';
        return;
      }
      // Master volume: reset to 100%
      if (e.target.id === 'master-vol-slider' || e.target.closest('#master-vol-slider')) {
        state.masterVolume = 1;
        state.masterMuted = false;
        const mv = document.getElementById('master-vol-slider');
        if (mv) mv.value = 100;
        updateGains();
        return;
      }
    });

    // Timeline seek (pointer events)
    let timelineDragging = false;

    // Double-tap detection for touch devices (sliders)
    let _lastTapTime = 0;
    let _lastTapTarget = null;
    document.getElementById('player-container').addEventListener('touchend', (e) => {
      const t = e.target;
      const now = Date.now();
      if (t === _lastTapTarget && now - _lastTapTime < 350) {
        // Double-tap detected — dispatch dblclick
        t.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
        _lastTapTime = 0;
        _lastTapTarget = null;
      } else {
        _lastTapTime = now;
        _lastTapTarget = t;
      }
    }, { passive: true });

    function timelineSeek(clientX) {
      const tl = document.getElementById('timeline');
      if (!tl || !state.duration) return;
      const rect = tl.getBoundingClientRect();
      const pct = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
      seekTo(pct * state.duration);
    }

    document.getElementById('player-container').addEventListener('pointerdown', (e) => {
      if (e.target.closest('#timeline')) {
        timelineDragging = true;
        timelineSeek(e.clientX);
        e.preventDefault();
      }
    });
    document.addEventListener('pointermove', (e) => {
      if (timelineDragging) timelineSeek(e.clientX);
    });
    document.addEventListener('pointerup', () => { timelineDragging = false; });

    // Tools carousel swipe
    let _swipeStartX = 0;
    let _swipeStartTarget = null;
    document.getElementById('player-container').addEventListener('touchstart', (e) => {
      // Don't track swipe when interacting with sliders/inputs
      if (e.target.closest('input[type="range"]') || e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT') return;
      const carousel = e.target.closest('.tools-carousel');
      if (carousel) {
        _swipeStartX = e.touches[0].clientX;
        _swipeStartTarget = e.target;
      }
    }, { passive: true });
    document.getElementById('player-container').addEventListener('touchend', (e) => {
      if (!_swipeStartX) return;
      const carousel = e.target.closest('.tools-carousel');
      if (!carousel) { _swipeStartX = 0; _swipeStartTarget = null; return; }
      const dx = _swipeStartX - e.changedTouches[0].clientX;
      _swipeStartX = 0;
      const tapTarget = _swipeStartTarget;
      _swipeStartTarget = null;
      if (Math.abs(dx) < 40) {
        // Not a swipe — treat as a tap. Synthesize click for tool-chips
        // because mobile browsers may suppress click after touchstart/touchend dance
        const toolBtn = tapTarget?.closest('[data-tool]') || tapTarget?.closest('[data-tools-page]');
        if (toolBtn) toolBtn.click();
        return;
      }
      const maxPage = TOOLS_PAGES.length - 1;
      if (dx > 0) state._toolsPage = state._toolsPage >= maxPage ? 0 : state._toolsPage + 1;
      else state._toolsPage = state._toolsPage <= 0 ? maxPage : state._toolsPage - 1;
      const pages = document.getElementById('tools-pages');
      if (pages) pages.style.transform = `translateX(-${state._toolsPage * 100}%)`;
      document.querySelectorAll('.tools-dot').forEach((d, i) => d.style.background = i === state._toolsPage ? 'var(--accent)' : 'var(--surface-3)');
    }, { passive: true });

    // Setlist
    document.getElementById('setlist-select').addEventListener('change', (e) => {
      state._selectedSetlist = e.target.value;
      if (e.target.value) loadPlaylistSettings();
      renderSetlist(e.target.value);
      // Refresh shared notes for this setlist from the server, then re-render.
      if (e.target.value) {
        pullSetlistNotes().then(() => renderSetlist(e.target.value)).catch(() => {});
      }
    });

    // Metronome sound selector
    const metroSoundSel = document.getElementById('metro-sound-select');
    metroSoundSel.value = state.metronome.sound;
    metroSoundSel.addEventListener('change', (e) => {
      state.metronome.sound = e.target.value;
      savePlaylistSettings();
      // Preview the sound
      initAudioCtx();
      if (state.audioCtx) createMetronomeClick(state.audioCtx.currentTime + 0.05);
    });

    // Setlist fullscreen
    document.getElementById('setlist-fullscreen').addEventListener('click', () => {
      const view = document.getElementById('setlist-view');
      if (document.fullscreenElement) {
        document.exitFullscreen();
      } else {
        view.requestFullscreen().catch(() => {});
      }
    });

    // Sincronizar setlist (verifica alterações de músicas no servidor)
    document.getElementById('setlist-sync').addEventListener('click', () => {
      const playlistId = document.getElementById('setlist-select').value;
      if (!playlistId) { toast('Selecione uma setlist primeiro', 'info'); return; }
      syncSetlist(playlistId);
    });

    document.getElementById('setlist-songs').addEventListener('click', (e) => {
      // Collapse/expand toggle (visual-only — não altera a setlist)
      const collapseBtn = e.target.closest('[data-sl-collapse]');
      if (collapseBtn) {
        const playlistId = document.getElementById('setlist-select').value;
        toggleCollapsedSong(playlistId, collapseBtn.dataset.slCollapse);
        return;
      }
      // Add note button
      const addNoteBtn = e.target.closest('[data-add-note-pos]');
      if (addNoteBtn) {
        const pos = parseFloat(addNoteBtn.dataset.addNotePos);
        const playlistId = document.getElementById('setlist-select').value;
        if (!playlistId) return;
        showSetlistNoteModal(playlistId, pos);
        return;
      }
      // Delete note button
      const delNoteBtn = e.target.closest('[data-del-note]');
      if (delNoteBtn) {
        const noteId = parseInt(delNoteBtn.dataset.delNote);
        deleteSetlistNote(noteId);
        return;
      }
      // Edit note on click
      const noteEl = e.target.closest('.setlist-note');
      if (noteEl && !e.target.closest('.sl-note-del')) {
        const noteId = parseInt(noteEl.dataset.noteId);
        const note = state.setlistNotes.find(n => n.id === noteId);
        if (note) {
          const playlistId = document.getElementById('setlist-select').value;
          showSetlistNoteModal(playlistId, note.position, note);
        }
        return;
      }
      // Edit key (tom) inline
      const keyEl = e.target.closest('[data-edit-key]');
      if (keyEl) {
        const songId = keyEl.dataset.editKey;
        const song = state.songs.find(s => s.id === songId);
        if (!song) return;
        showKeyPickerModal(song, () => {
          const playlistId = document.getElementById('setlist-select').value;
          if (playlistId) renderSetlist(playlistId);
        });
        return;
      }
      // Edit BPM inline
      const bpmEl = e.target.closest('[data-edit-bpm]');
      if (bpmEl) {
        const songId = bpmEl.dataset.editBpm;
        const song = state.songs.find(s => s.id === songId);
        if (!song) return;
        const currentBpm = song.bpm || '';
        const overlay = document.createElement('div');
        overlay.className = 'modal-overlay';
        overlay.innerHTML = `
          <div class="modal-box">
            <h3>🎵 BPM — ${esc(song.title)}</h3>
            <input type="number" id="sl-bpm-input" value="${currentBpm}" min="20" max="300" step="0.1" placeholder="Ex: 120" autocomplete="off" style="width:100%;padding:0.5rem;border-radius:6px;border:1px solid var(--surface-3);background:var(--surface-2);color:var(--text);font-size:1.2rem;text-align:center;margin:0.75rem 0">
            <div style="display:flex;gap:0.5rem;justify-content:flex-end">
              ${currentBpm ? '<button class="modal-btn cancel" id="sl-bpm-clear" style="margin-right:auto">Limpar</button>' : ''}
              <button class="modal-btn cancel" id="sl-bpm-cancel">Cancelar</button>
              <button class="modal-btn confirm" id="sl-bpm-save">Salvar</button>
            </div>
          </div>`;
        mountOverlay(overlay);
        const input = overlay.querySelector('#sl-bpm-input');
        input.focus();
        input.select();

        const close = () => overlay.remove();
        overlay.querySelector('#sl-bpm-cancel').addEventListener('click', close);
        overlay.addEventListener('click', (ev) => { if (ev.target === overlay) close(); });

        const save = () => {
          const val = parseFloat(input.value);
          const newBpm = (val && val >= 20 && val <= 300) ? Math.round(val * 10) / 10 : null;
          song.bpm = newBpm;
          idbPut('songs', song);
          if (newBpm) addPendingEdit('bpm', songId, { bpm: newBpm, beatOffset: song.beatOffset || 0 });
          // Save to song-scoped localStorage too
          const songKey = `showtime_song_${songId}`;
          try {
            const saved = JSON.parse(localStorage.getItem(songKey) || '{}');
            saved.bpm = newBpm;
            localStorage.setItem(songKey, JSON.stringify(saved));
          } catch {}
          // Update player state if this song is loaded
          if (state.currentSongId === songId) state.bpm = newBpm;
          close();
          const playlistId = document.getElementById('setlist-select').value;
          if (playlistId) renderSetlist(playlistId);
        };

        overlay.querySelector('#sl-bpm-save').addEventListener('click', save);
        input.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') save(); if (ev.key === 'Escape') close(); });
        const clearBtn = overlay.querySelector('#sl-bpm-clear');
        if (clearBtn) clearBtn.addEventListener('click', () => { input.value = ''; save(); });
        return;
      }
      const playBtn = e.target.closest('[data-sl-play]');
      if (playBtn) {
        const songId = playBtn.dataset.slPlay;
        if (songId === state.currentSongId && state.isPlaying) stopPlayback();
        else if (songId === state.currentSongId) startPlayback();
        else {
          // Playing from the setlist sets the queue to the setlist order,
          // starting at the tapped song (without altering the saved setlist).
          const playlistId = document.getElementById('setlist-select').value;
          const ids = state.playlistSongs
            .filter(ps => ps.playlist_id === playlistId)
            .sort((a, b) => (a.position || 0) - (b.position || 0))
            .map(ps => ps.song_id);
          const startAt = ids.indexOf(songId);
          const pl = state.playlists.find(p => p.id === playlistId);
          if (startAt !== -1) setQueue(ids, startAt, pl ? pl.title : null);
          else setQueue([songId], 0, pl ? pl.title : null);
          loadSong(songId, { navigate: false }).then(() => startPlayback());
        }
        setTimeout(() => renderSetlist(document.getElementById('setlist-select').value), 100);
        return;
      }
      // Metronome button per setlist item
      const metroBtn = e.target.closest('[data-sl-metro]');
      if (metroBtn) {
        const songId = metroBtn.dataset.slMetro;
        const song = state.songs.find(s => s.id === songId);
        if (song && song.bpm) {
          state.bpm = song.bpm;
          state.beatOffset = song.beatOffset || 0;
          state.bpmSections = song.bpmSections || [];
          if (state.metronome.enabled) {
            stopMetronome();
            state.metronome.enabled = false;
            metroBtn.classList.remove('metro-active');
          } else {
            state.metronome.enabled = true;
            metroBtn.classList.add('metro-active');
            // Start standalone metronome (without song playing)
            initAudioCtx();
            startMetronomeTicking();
          }
        }
        return;
      }
      const item = e.target.closest('.setlist-item');
      if (item) {
        document.querySelectorAll('.setlist-item').forEach(i => i.classList.remove('active'));
        item.classList.add('active');
      }
    });

    // Sync / Catalog
    document.getElementById('catalog-content').addEventListener('click', async (e) => {
      const btn = e.target.closest('[data-action]');
      if (!btn) return;
      const { action, id } = btn.dataset;
      if (action === 'download-playlist') { downloadPlaylist(id).then(() => renderCatalog()); }
      else if (action === 'update-playlist') { toast('Atualizando playlist...', 'info'); removePlaylist(id).then(() => refreshCatalog()).then(() => downloadPlaylist(id)).then(() => renderCatalog()); }
      else if (action === 'remove-playlist') { await removePlaylist(id); toast('Playlist removida', 'success'); }
      else if (action === 'download-song') { downloadSong(id).then(() => renderCatalog()); }
      else if (action === 'remove-song') { await removeSong(id); toast('Música removida', 'success'); }
    });

    document.getElementById('btn-storage').addEventListener('click', () => switchView('sync-view'));

    // Service Worker messages
    if (navigator.serviceWorker) {
      navigator.serviceWorker.addEventListener('message', (e) => {
        if (e.data?.type === 'CACHE_PROGRESS') onBatchProgress(e.data.batchId, e.data.cached + e.data.failed, e.data.total);
        if (e.data?.type === 'CACHE_COMPLETE') onBatchComplete(e.data.batchId);
        if (e.data?.type === 'CACHE_SIZE') updateStorageDisplay(e.data.totalSize);
        if (e.data?.type === 'PURGE_COMPLETE') requestCacheSize();
      });
    }

    // Keyboard shortcuts
    initKeyboardShortcuts();

    // Responsive: re-render mixer on resize
    let resizeTimer;
    window.addEventListener('resize', () => {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => {
        if (state.currentSong && state.currentView === 'player-view') {
          renderMixer();
        }
      }, 250);
    });

    // Visibility change: flush pending edits
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden && state.isOnline) flushPendingEdits();
    });
  }

  // ============================================================
  // Keyboard Shortcuts
  // ============================================================
  function initKeyboardShortcuts() {
    let _keyHoldInterval = null;
    document.addEventListener('keydown', (e) => {
      if (e.target.matches('input, select, textarea, [contenteditable="true"]')) return;
      if (e.repeat && (e.code === 'ArrowLeft' || e.code === 'ArrowRight')) {
        // Fast seek on hold
        e.preventDefault();
        if (!_keyHoldInterval) {
          _keyHoldInterval = setInterval(() => {
            seekTo(getCurrentTime() + (e.code === 'ArrowRight' ? 3 : -3));
          }, 50);
        }
        return;
      }
      switch (e.code) {
        case 'Space': e.preventDefault(); togglePlay(); return;
        case 'ArrowLeft': e.preventDefault(); seekTo(getCurrentTime() - (e.shiftKey ? 1 : 5)); return;
        case 'ArrowRight': e.preventDefault(); seekTo(getCurrentTime() + (e.shiftKey ? 1 : 5)); return;
        case 'ArrowUp': e.preventDefault(); setSpeed(Math.min(2, state.speed + 0.05)); return;
        case 'ArrowDown': e.preventDefault(); setSpeed(Math.max(0.25, state.speed - 0.05)); return;
        case 'Backspace': e.preventDefault(); clearLoop(); return;
      }
      // Character-based shortcuts use e.key (respects keyboard layout, e.g.
      // ABNT2/Brazilian). e.code maps to the physical US-layout position, so
      // symbols like [ ] ? < > would not match on non-US layouts.
      const k = e.key.toLowerCase();
      switch (k) {
        case '[': setLoopA(); break;                // início do loop (A)
        case ']': setLoopB(); break;                // fim do loop (B)
        case '<': setSpeed(Math.max(0.25, state.speed - 0.05)); break;
        case '>': setSpeed(Math.min(2, state.speed + 0.05)); break;
        case '?': e.preventDefault(); showShortcutsModal(); break;
        case 'm': toggleMasterMute(); break;
        case 'n': playNextSong(); break;
        case 'p': playPrevSong(); break;
        case 't': handleTapTempo(); break;
        case 'k': toggleMetronome(); break;
      }
    });
    document.addEventListener('keyup', (e) => {
      if (e.code === 'ArrowLeft' || e.code === 'ArrowRight') {
        if (_keyHoldInterval) { clearInterval(_keyHoldInterval); _keyHoldInterval = null; }
      }
    });

    // Floating "?" / keyboard button (desktop) + "?" hotkey
    createShortcutsFab();
  }

  // Definition of all keyboard shortcuts (kept in sync with initKeyboardShortcuts)
  const KEYBOARD_SHORTCUTS = [
    { keys: ['Espaço'], desc: 'Tocar / pausar' },
    { keys: ['←'], desc: 'Voltar 5s (Shift: 1s · segurar: rápido)' },
    { keys: ['→'], desc: 'Avançar 5s (Shift: 1s · segurar: rápido)' },
    { keys: ['↑'], desc: 'Aumentar velocidade' },
    { keys: ['↓'], desc: 'Diminuir velocidade' },
    { keys: ['M'], desc: 'Mudo geral (master)' },
    { keys: ['['], desc: 'Marcar início do loop (A)' },
    { keys: [']'], desc: 'Marcar fim do loop (B)' },
    { keys: ['Backspace'], desc: 'Limpar loop' },
    { keys: ['N'], desc: 'Próxima música' },
    { keys: ['P'], desc: 'Música anterior' },
    { keys: ['T'], desc: 'Tap tempo (marcar BPM)' },
    { keys: ['K'], desc: 'Ligar / desligar metrônomo' },
    { keys: ['?'], desc: 'Mostrar esta lista de atalhos' },
  ];

  function createShortcutsFab() {
    if (document.getElementById('kbd-fab')) return;
    const btn = document.createElement('button');
    btn.id = 'kbd-fab';
    btn.className = 'kbd-fab';
    btn.type = 'button';
    btn.title = 'Atalhos de teclado (?)';
    btn.setAttribute('aria-label', 'Ver atalhos de teclado');
    btn.innerHTML = '⌨';
    btn.addEventListener('click', showShortcutsModal);
    document.body.appendChild(btn);
  }

  function showShortcutsModal() {
    // Avoid stacking multiple copies
    if (document.getElementById('kbd-shortcuts-modal')) return;
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    overlay.id = 'kbd-shortcuts-modal';

    let rows = '';
    for (const sc of KEYBOARD_SHORTCUTS) {
      const keys = sc.keys.map(k => `<span class="kbd-key">${esc(k)}</span>`).join('');
      rows += `<div class="kbd-row">
        <span class="kbd-desc">${esc(sc.desc)}</span>
        <span class="kbd-keys">${keys}</span>
      </div>`;
    }

    overlay.innerHTML = `<div class="modal-box" style="max-width:380px">
      <h3>Atalhos de teclado</h3>
      <div class="kbd-list">${rows}</div>
      <div style="display:flex;justify-content:flex-end;margin-top:0.9rem">
        <button class="modal-btn cancel" data-modal-close>Fechar</button>
      </div>
    </div>`;

    const close = () => {
      overlay.remove();
      document.removeEventListener('keydown', onKey, true);
    };
    const onKey = (e) => {
      if (e.key === 'Escape') { e.preventDefault(); close(); }
    };
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay || e.target.matches('[data-modal-close]')) close();
    });
    document.addEventListener('keydown', onKey, true);
    mountOverlay(overlay);
  }

  // ============================================================
  // Utilities — esc/formatTime/formatBytes imported from ./js/utils.js
  // ============================================================

  // ============================================================
  // Init
  // ============================================================
  async function init() {
    state.idb = await openDB();
    await loadLocalData();
    loadPlaylistSettings();
    loadQueue();

    renderLibrary();
    renderSetlistSelector();
    initEvents();

    const online = await checkConnection();
    setOnlineStatus(online);
    if (online) {
      // Pull shared setlist notes from the server, then refresh the UI.
      await pullSetlistNotes().catch(() => {});
      renderSetlistSelector();
      const sel = document.getElementById('setlist-select');
      if (sel && sel.value) renderSetlist(sel.value);
    }

    // Connectivity monitor
    setInterval(async () => {
      const on = await checkConnection();
      if (on !== state.isOnline) {
        setOnlineStatus(on);
        if (on) {
          flushPendingEdits();
          pullSetlistNotes().catch(() => {});
        }
      }
    }, 15000);

    // Register SW
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.register('/sw.js');
    }

    setTimeout(requestCacheSize, 1000);
  }

  init().catch(err => console.error('Init failed:', err));
})();
