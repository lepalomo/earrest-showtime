// ============================================================
// Central app state — a single mutable object shared across modules.
// Importing modules read/write the same instance (ES module singleton).
// ============================================================

export const state = {
  // Connectivity
  isOnline: false,
  // IDB
  idb: null,
  // Local data
  playlists: [],
  songs: [],
  playlistSongs: [],
  setlistNotes: [],
  // Navigation
  currentView: 'library-view',
  currentPlaylistId: null,
  // Visual-only: songs collapsed ("escondidas") na setlist. Não altera a
  // playlist/setlist — só esconde o item na tela. Persistido em localStorage.
  collapsedSetlist: new Set(),
  // Player
  audioCtx: null,
  masterGain: null,
  // Persistent audio graph pool, keyed by stem name. Each entry is
  // { audio, source, gain } created ONCE (while foregrounded) and reused
  // across songs. Rebuilding MediaElementSource nodes on every track change
  // is unreliable when the screen is locked (background media throttling),
  // which caused songs to start "muted / only one stem". Reusing the graph
  // and just swapping audio.src is far more robust in the background.
  audioPool: {},
  audioEls: {},
  gainNodes: {},
  sourceNodes: {},
  isPlaying: false,
  pausedAt: 0,
  duration: 0,
  currentSongId: null,
  currentSong: null,
  stems: {},
  chords: [],
  notes: [],
  bpm: null,
  beatOffset: 0,
  bpmSections: [],
  originalKey: null,
  pitches: [0],
  currentPitch: 0,
  _pitchGenerating: null,
  // Mixer
  muted: new Set(),
  soloed: new Set(),
  volumes: {},
  masterVolume: 1,
  masterMuted: false,
  // Per-song playback gain (multiplier applied on top of master volume).
  // 1 = original mix. Adjusted in ±10% steps to level quiet songs.
  songGain: 1,
  // Playback
  speed: 1,
  repeatMode: 'off', // 'off', 'all', 'one'
  loopA: null,
  loopB: null,
  trimBefore: null,
  trimAfter: null,
  // Metronome
  metronome: { enabled: false, sound: 'click', volume: 0.6, intervalId: null, nextBeatTime: 0 },
  // Notes
  notesEnabled: true,
  notesAudioEnabled: true,
  _lastNoteIdx: -1,
  // Animation
  _animFrame: null,
  _boundaryInterval: null,
  _lastChordIdx: -1,
  _loadId: 0,
  _stemReady: false,
  // Background/visibility handling (see visibility + boundary checker).
  // When the screen is off or the tab is hidden, browsers throttle timers
  // and stop rAF. We suspend visual work and defer stem re-sync until the
  // page is visible again to avoid a burst of simultaneous seeks (glitches).
  _hidden: (typeof document !== 'undefined' && document.hidden) || false,
  _lastBoundaryTs: 0,
  // UI state
  _mixerStemIdx: 0,
  _toolsPage: 0,
  _lastMasterVol: 1,
  _catalog: null,
  _shuffledOrder: null,
  // ---- Playback queue ("Tocando agora") ----
  // The queue is the source of truth for playback order. Starting a
  // playlist/setlist or a single song REPLACES the queue with that context.
  // "Tocar a seguir" / "Adicionar ao final" mutate ONLY the queue, never the
  // saved playlist/setlist. Persisted to localStorage (ephemeral, client-only).
  queue: [],            // array of song IDs
  queueIndex: -1,       // index of the currently-playing song in `queue`
  queueContext: null,   // label describing where the queue came from (UI only)
};

// Tap-tempo transient state. Wrapped in an object so other modules can mutate
// it by reference (plain `let` exports are read-only to importers).
export const tap = {
  times: [],
  timeout: null,
  posSample: null,
};
