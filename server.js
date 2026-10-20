require('dotenv').config();
const fs = require('fs');
const https = require('https');
const express = require('express');
const path = require('path');
const Database = require('better-sqlite3');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const PORT = process.env.PORT || 7001;
const STEMIZER_DATA_DIR = path.resolve(process.env.STEMIZER_DATA_DIR || '../earrest/data');
const STEMS_DIR = path.join(STEMIZER_DATA_DIR, 'stems');
const DB_PATH = path.join(STEMIZER_DATA_DIR, 'earrest.db');

// Open Stemizer's DB in read-only mode
let db;
try {
  db = new Database(DB_PATH, { readonly: true, fileMustExist: true });
  db.pragma('journal_mode = WAL');
} catch (e) {
  console.error('⚠️  Não foi possível abrir o banco do Stemizer:', e.message);
  console.error('   Verifique se STEMIZER_DATA_DIR aponta para a pasta data/ do earrest');
  process.exit(1);
}

// Serve stems as static files (directly from Stemizer's data dir)
app.use('/stems', express.static(path.resolve(STEMS_DIR)));

// --- LAN-only middleware ---
app.use('/api', (req, res, next) => {
  const ip = req.ip || req.connection.remoteAddress;
  const local = /^(::ffff:)?(127\.|192\.168\.|10\.|100\.|172\.(1[6-9]|2\d|3[01])\.)/.test(ip) || ip === '::1';
  if (!local) return res.status(403).json({ error: 'LAN access only' });
  next();
});

// --- Connectivity probe ---
app.get('/api/ping', (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json({ ok: true, ts: Date.now() });
});

// Force no-cache for manifest and icons
app.get('/manifest.json', (req, res) => {
  res.set('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.sendFile(path.join(__dirname, 'public', 'manifest.json'));
});

// --- API: Catalog (what's available on server to download offline) ---
app.get('/api/catalog', (req, res) => {
  const playlists = db.prepare('SELECT * FROM playlists ORDER BY position ASC, created_at DESC').all();
  const songs = db.prepare("SELECT * FROM songs WHERE status = 'done'").all();
  const playlistSongs = db.prepare('SELECT * FROM playlist_songs ORDER BY position ASC').all();

  // Enrich songs with metadata from chords.json
  const enriched = songs.map(s => {
    const songDir = path.join(STEMS_DIR, s.youtube_id);
    const chordsPath = path.join(songDir, 'chords.json');
    let bpm = null, beatOffset = 0, chords = null, notes = [], originalKey = null, bpmSections = [];
    let pitches = [0];
    let stems = {};
    let gain = 1;

    if (fs.existsSync(chordsPath)) {
      try {
        const data = JSON.parse(fs.readFileSync(chordsPath, 'utf-8'));
        if (Array.isArray(data)) { chords = data; }
        else {
          chords = data.chords || null;
          bpm = data.bpm || null;
          beatOffset = data.beatOffset || 0;
          notes = data.notes || [];
          originalKey = data.originalKey || null;
          bpmSections = data.bpmSections || [];
          gain = (typeof data.gain === 'number' && data.gain > 0) ? data.gain : 1;
        }
      } catch {}
    }

    // List stems (MP3 only for Showtime)
    if (fs.existsSync(songDir)) {
      const files = fs.readdirSync(songDir).filter(f => f.endsWith('.mp3'));
      for (const f of files) {
        stems[path.parse(f).name] = `/stems/${s.youtube_id}/${f}`;
      }
      // Pitch variants
      for (const d of fs.readdirSync(songDir)) {
        const m = d.match(/^pitch_([+-]?\d+)$/);
        if (m && fs.statSync(path.join(songDir, d)).isDirectory()) {
          pitches.push(parseInt(m[1]));
        }
      }
      pitches.sort((a, b) => a - b);
    }

    // Calculate total size of stems (for storage info)
    let size = 0;
    if (fs.existsSync(songDir)) {
      const allFiles = fs.readdirSync(songDir);
      for (const f of allFiles) {
        const fp = path.join(songDir, f);
        if (fs.statSync(fp).isFile()) size += fs.statSync(fp).size;
      }
    }

    return {
      ...s,
      bpm, beatOffset, chords, notes, originalKey, bpmSections, pitches, stems, size, gain
    };
  });

  res.json({ playlists, songs: enriched, playlistSongs });
});

// --- API: Sync (pull updates since last sync) ---
app.get('/api/sync', (req, res) => {
  // Returns everything — the client compares versions locally
  // In future, could use timestamps to optimize, but for now full sync is fine
  // given the small dataset (tens/hundreds of songs, not thousands)
  const playlists = db.prepare('SELECT * FROM playlists ORDER BY position ASC').all();
  const songs = db.prepare("SELECT * FROM songs WHERE status = 'done'").all();
  const playlistSongs = db.prepare('SELECT * FROM playlist_songs ORDER BY position ASC').all();

  // Enrich with metadata
  const enriched = songs.map(s => {
    const songDir = path.join(STEMS_DIR, s.youtube_id);
    const chordsPath = path.join(songDir, 'chords.json');
    let bpm = null, beatOffset = 0, chords = null, notes = [], originalKey = null, bpmSections = [];
    let pitches = [0];
    let gain = 1;

    if (fs.existsSync(chordsPath)) {
      try {
        const data = JSON.parse(fs.readFileSync(chordsPath, 'utf-8'));
        if (Array.isArray(data)) { chords = data; }
        else {
          chords = data.chords || null;
          bpm = data.bpm || null;
          beatOffset = data.beatOffset || 0;
          notes = data.notes || [];
          originalKey = data.originalKey || null;
          bpmSections = data.bpmSections || [];
          gain = (typeof data.gain === 'number' && data.gain > 0) ? data.gain : 1;
        }
      } catch {}
    }

    if (fs.existsSync(songDir)) {
      for (const d of fs.readdirSync(songDir)) {
        const m = d.match(/^pitch_([+-]?\d+)$/);
        if (m && fs.statSync(path.join(songDir, d)).isDirectory()) {
          pitches.push(parseInt(m[1]));
        }
      }
      pitches.sort((a, b) => a - b);
    }

    return { ...s, bpm, beatOffset, chords, notes, originalKey, bpmSections, pitches, gain };
  });

  res.json({ playlists, songs: enriched, playlistSongs, setlistNotes: loadSetlistNotes(), serverTime: Date.now() });
});

// --- API: Push local edits from Showtime to Stemizer ---
app.post('/api/sync', (req, res) => {
  // Receives edits made offline in Showtime and writes them to Stemizer's data
  // We open a writable connection just for this operation
  let writeDb;
  try {
    writeDb = new Database(DB_PATH, { fileMustExist: true });
    writeDb.pragma('journal_mode = WAL');
  } catch (e) {
    return res.status(500).json({ error: 'Cannot write to Stemizer DB' });
  }

  const { edits } = req.body;
  if (!Array.isArray(edits)) {
    writeDb.close();
    return res.status(400).json({ error: 'edits array required' });
  }

  const results = [];

  for (const edit of edits) {
    try {
      const song = writeDb.prepare('SELECT * FROM songs WHERE id = ?').get(edit.songId);
      if (!song) { results.push({ songId: edit.songId, ok: false, error: 'not found' }); continue; }

      const songDir = path.join(STEMS_DIR, song.youtube_id);
      const chordsPath = path.join(songDir, 'chords.json');

      switch (edit.type) {
        case 'title':
          writeDb.prepare('UPDATE songs SET title = ? WHERE id = ?').run(edit.value, edit.songId);
          break;

        case 'artist':
          writeDb.prepare('UPDATE songs SET artist = ? WHERE id = ?').run(edit.value, edit.songId);
          break;

        case 'bpm': {
          let data = loadChordsData(chordsPath);
          data.bpm = edit.value || null;
          fs.mkdirSync(songDir, { recursive: true });
          fs.writeFileSync(chordsPath, JSON.stringify(data));
          break;
        }

        case 'beatOffset': {
          let data = loadChordsData(chordsPath);
          data.beatOffset = edit.value || 0;
          fs.mkdirSync(songDir, { recursive: true });
          fs.writeFileSync(chordsPath, JSON.stringify(data));
          break;
        }

        case 'gain': {
          // Per-song playback gain (multiplier). Preserved across stem
          // reprocessing because it lives in chords.json, which the worker
          // keeps when regenerating stems.
          let data = loadChordsData(chordsPath);
          const g = Number(edit.value);
          data.gain = (isFinite(g) && g > 0) ? g : 1;
          fs.mkdirSync(songDir, { recursive: true });
          fs.writeFileSync(chordsPath, JSON.stringify(data));
          break;
        }

        case 'bpmSections': {
          let data = loadChordsData(chordsPath);
          data.bpmSections = edit.value || [];
          fs.mkdirSync(songDir, { recursive: true });
          fs.writeFileSync(chordsPath, JSON.stringify(data));
          break;
        }

        case 'notes': {
          let data = loadChordsData(chordsPath);
          data.notes = edit.value || [];
          fs.mkdirSync(songDir, { recursive: true });
          fs.writeFileSync(chordsPath, JSON.stringify(data));
          break;
        }

        case 'originalKey': {
          let data = loadChordsData(chordsPath);
          data.originalKey = edit.value || null;
          fs.mkdirSync(songDir, { recursive: true });
          fs.writeFileSync(chordsPath, JSON.stringify(data));
          break;
        }

        case 'playlistOrder': {
          // edit.value = { playlistId, songIds: [...] }
          const upd = writeDb.prepare('UPDATE playlist_songs SET position = ? WHERE playlist_id = ? AND song_id = ?');
          if (edit.value?.songIds) {
            edit.value.songIds.forEach((id, i) => upd.run(i, edit.value.playlistId, id));
          }
          break;
        }

        default:
          results.push({ songId: edit.songId, ok: false, error: 'unknown edit type' });
          continue;
      }

      results.push({ songId: edit.songId, ok: true });
    } catch (e) {
      results.push({ songId: edit.songId, ok: false, error: e.message });
    }
  }

  writeDb.close();
  res.json({ ok: true, results });
});

// --- API: Get stems URLs for a specific song (for caching) ---
app.get('/api/songs/:id/stems', (req, res) => {
  const song = db.prepare('SELECT * FROM songs WHERE id = ?').get(req.params.id);
  if (!song || song.status !== 'done') return res.status(404).json({ error: 'not ready' });

  const songDir = path.join(STEMS_DIR, song.youtube_id);
  if (!fs.existsSync(songDir)) return res.status(404).json({ error: 'stems missing' });

  const pitchParam = parseInt(req.query.pitch) || 0;
  const stemDir = pitchParam === 0 ? songDir : path.join(songDir, `pitch_${pitchParam > 0 ? '+' : ''}${pitchParam}`);

  const stems = {};
  if (fs.existsSync(stemDir)) {
    const files = fs.readdirSync(stemDir).filter(f => f.endsWith('.mp3'));
    for (const f of files) {
      const name = path.parse(f).name;
      const relPath = pitchParam === 0 ? f : `pitch_${pitchParam > 0 ? '+' : ''}${pitchParam}/${f}`;
      stems[name] = `/stems/${song.youtube_id}/${relPath}`;
    }
  }

  res.json({ stems });
});

// --- API: Storage usage info ---
app.get('/api/storage', (req, res) => {
  // This tells the client how much data is available on server
  let totalSize = 0;
  const songs = db.prepare("SELECT youtube_id FROM songs WHERE status = 'done'").all();
  for (const s of songs) {
    const songDir = path.join(STEMS_DIR, s.youtube_id);
    if (fs.existsSync(songDir)) {
      for (const f of fs.readdirSync(songDir)) {
        const fp = path.join(songDir, f);
        try {
          const stat = fs.statSync(fp);
          if (stat.isFile()) totalSize += stat.size;
          else if (stat.isDirectory()) {
            // Pitch dirs
            for (const pf of fs.readdirSync(fp)) {
              const pfp = path.join(fp, pf);
              if (fs.statSync(pfp).isFile()) totalSize += fs.statSync(pfp).size;
            }
          }
        } catch {}
      }
    }
  }
  res.json({ totalServerSize: totalSize, songCount: songs.length });
});

// ============================================================
// Setlist notes (Showtime-only concept — the Stemizer DB is read-only,
// so these live in a JSON file inside the Stemizer data dir, which is
// writable). Shape: { [playlistId]: [{ noteId, position, text }, ...] }.
// Notes are keyed by a stable client-generated `noteId` so they stay
// consistent across devices.
// ============================================================
const SETLIST_NOTES_PATH = path.join(STEMIZER_DATA_DIR, 'showtime-setlist-notes.json');

function loadSetlistNotes() {
  try {
    if (fs.existsSync(SETLIST_NOTES_PATH)) {
      const raw = JSON.parse(fs.readFileSync(SETLIST_NOTES_PATH, 'utf-8'));
      return (raw && typeof raw === 'object') ? raw : {};
    }
  } catch {}
  return {};
}

function saveSetlistNotes(all) {
  fs.mkdirSync(path.dirname(SETLIST_NOTES_PATH), { recursive: true });
  fs.writeFileSync(SETLIST_NOTES_PATH, JSON.stringify(all));
}

// Pull all setlist notes (optionally filtered by playlistId).
app.get('/api/setlist-notes', (req, res) => {
  const all = loadSetlistNotes();
  const { playlistId } = req.query;
  if (playlistId) return res.json({ notes: all[playlistId] || [] });
  res.json({ notes: all });
});

// Replace the full note set for a single playlist.
// Body: { playlistId, notes: [{ noteId, position, text }, ...] }
app.post('/api/setlist-notes', (req, res) => {
  const { playlistId, notes } = req.body || {};
  if (!playlistId || !Array.isArray(notes)) {
    return res.status(400).json({ error: 'playlistId and notes[] required' });
  }
  const all = loadSetlistNotes();
  const clean = notes
    .filter(n => n && typeof n.noteId === 'string' && typeof n.text === 'string')
    .map(n => ({ noteId: n.noteId, position: Number(n.position) || 0, text: n.text }));
  if (clean.length > 0) all[playlistId] = clean;
  else delete all[playlistId];
  try {
    saveSetlistNotes(all);
  } catch (e) {
    return res.status(500).json({ error: 'Cannot persist setlist notes: ' + e.message });
  }
  res.json({ ok: true, notes: clean });
});

// --- SPA fallback ---
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// --- Helper ---
function loadChordsData(chordsPath) {
  let data = {};
  if (fs.existsSync(chordsPath)) {
    try {
      const raw = JSON.parse(fs.readFileSync(chordsPath, 'utf-8'));
      data = Array.isArray(raw) ? { chords: raw } : raw;
    } catch {}
  }
  return data;
}

// --- Start server ---
const certPath = path.join(__dirname, 'cert.pem');
const keyPath = path.join(__dirname, 'key.pem');

if (fs.existsSync(certPath) && fs.existsSync(keyPath)) {
  const options = { cert: fs.readFileSync(certPath), key: fs.readFileSync(keyPath) };
  https.createServer(options, app).listen(PORT, '0.0.0.0', () => {
    console.log(`🎶 EarRest Showtime running at https://0.0.0.0:${PORT}`);
  });
} else {
  app.listen(PORT, '0.0.0.0', () => {
    console.log(`🎶 EarRest Showtime running at http://0.0.0.0:${PORT}`);
  });
}
