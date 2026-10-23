// ============================================================
// IndexedDB access layer. Uses the shared `state.idb` connection.
// Stores: songs, playlists, playlistSongs, pendingEdits, setlistNotes.
// ============================================================
import { state } from './state.js';

export function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('showtime', 3);
    req.onupgradeneeded = (e) => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains('songs')) db.createObjectStore('songs', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('playlists')) db.createObjectStore('playlists', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('playlistSongs')) db.createObjectStore('playlistSongs', { keyPath: ['playlist_id', 'song_id'] });
      if (!db.objectStoreNames.contains('pendingEdits')) {
        const s = db.createObjectStore('pendingEdits', { keyPath: 'id', autoIncrement: true });
        s.createIndex('songId', 'songId', { unique: false });
      }
      if (!db.objectStoreNames.contains('setlistNotes')) {
        db.createObjectStore('setlistNotes', { keyPath: 'id', autoIncrement: true });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export function idbGetAll(store) {
  return new Promise((resolve, reject) => {
    const tx = state.idb.transaction(store, 'readonly');
    const req = tx.objectStore(store).getAll();
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export function idbPut(store, value) {
  return new Promise((resolve, reject) => {
    const tx = state.idb.transaction(store, 'readwrite');
    tx.objectStore(store).put(value);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export function idbDelete(store, key) {
  return new Promise((resolve, reject) => {
    const tx = state.idb.transaction(store, 'readwrite');
    tx.objectStore(store).delete(key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export function idbAdd(store, value) {
  return new Promise((resolve, reject) => {
    const tx = state.idb.transaction(store, 'readwrite');
    const req = tx.objectStore(store).add(value);
    req.onsuccess = () => resolve(req.result);
    tx.onerror = () => reject(tx.error);
  });
}
