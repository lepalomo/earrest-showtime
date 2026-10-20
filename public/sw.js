const CACHE_APP = 'showtime-app-v23';
const CACHE_STEMS = 'showtime-stems-v1';
const CACHE_API = 'showtime-api-v1';

const APP_SHELL = [
  '/',
  '/app.js',
  '/manifest.json',
  '/icon.svg',
  '/icon-192.png?v=2',
  '/icon-512.png?v=2'
];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE_APP).then(c => c.addAll(APP_SHELL))
  );
  self.skipWaiting();
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => ![CACHE_APP, CACHE_STEMS, CACHE_API].includes(k)).map(k => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET') return;
  if (!url.protocol.startsWith('http')) return;

  // Stems: cache-first (offline-first)
  if (url.pathname.startsWith('/stems/')) {
    e.respondWith(handleStemRequest(e.request));
    return;
  }

  // Ping: always network (connectivity check)
  if (url.pathname === '/api/ping') {
    e.respondWith(fetch(e.request).catch(() => new Response('', { status: 503 })));
    return;
  }

  // API: cache-first with background revalidate
  if (url.pathname.startsWith('/api/')) {
    e.respondWith(handleApiRequest(e.request));
    return;
  }

  // App shell: cache-first, update in background
  e.respondWith(handleAppRequest(e.request));
});

async function handleStemRequest(request) {
  // Handle range requests from cache
  if (request.headers.get('range')) {
    const cached = await caches.match(new Request(request.url));
    if (cached) {
      try {
        const buf = await cached.arrayBuffer();
        const range = request.headers.get('range');
        const match = range.match(/bytes=(\d+)-(\d*)/);
        const start = parseInt(match[1]);
        const end = match[2] ? parseInt(match[2]) : buf.byteLength - 1;
        if (start < buf.byteLength) {
          const actualEnd = Math.min(end, buf.byteLength - 1);
          if (start === 0 && actualEnd === buf.byteLength - 1) {
            return new Response(buf, {
              status: 200,
              headers: {
                'Content-Length': buf.byteLength,
                'Content-Type': cached.headers.get('Content-Type') || 'audio/mpeg',
                'Accept-Ranges': 'bytes'
              }
            });
          }
          return new Response(buf.slice(start, actualEnd + 1), {
            status: 206,
            headers: {
              'Content-Range': `bytes ${start}-${actualEnd}/${buf.byteLength}`,
              'Content-Length': actualEnd - start + 1,
              'Content-Type': cached.headers.get('Content-Type') || 'audio/mpeg'
            }
          });
        }
      } catch {}
    }
    return fetch(request).catch(() => new Response('', { status: 404 }));
  }

  // Non-range: cache-first
  const cached = await caches.match(request);
  if (cached) return cached;

  try {
    const res = await fetch(request);
    if (res.ok) {
      const clone = res.clone();
      caches.open(CACHE_STEMS).then(c => c.put(request, clone));
    }
    return res;
  } catch {
    return new Response('', { status: 404 });
  }
}

async function handleApiRequest(request) {
  const cached = await caches.match(request);

  // Background revalidate
  const networkFetch = fetch(request).then(res => {
    if (res.ok) {
      const clone = res.clone();
      caches.open(CACHE_API).then(c => c.put(request, clone));
    }
    return res;
  }).catch(() => null);

  if (cached) {
    networkFetch; // fire and forget
    return cached;
  }

  const res = await networkFetch;
  if (res) return res;
  return new Response(JSON.stringify({ error: 'offline' }), {
    status: 503, headers: { 'Content-Type': 'application/json' }
  });
}

async function handleAppRequest(request) {
  const cached = await caches.match(request);

  const networkFetch = fetch(request).then(res => {
    if (res.ok) {
      const clone = res.clone();
      caches.open(CACHE_APP).then(c => c.put(request, clone));
    }
    return res;
  }).catch(() => null);

  if (cached) {
    networkFetch; // update in background
    return cached;
  }

  const res = await networkFetch;
  if (res) return res;

  // Fallback to index.html for SPA routes
  const index = await caches.match('/');
  if (index) return index;

  return new Response('Offline', { status: 503 });
}

// --- Messages from app ---
self.addEventListener('message', (e) => {
  if (e.data?.type === 'SKIP_WAITING') {
    self.skipWaiting();
    return;
  }

  if (e.data?.type === 'CACHE_STEMS') {
    // Cache a list of stem URLs
    const urls = e.data.urls || [];
    caches.open(CACHE_STEMS).then(async cache => {
      let cached = 0;
      let failed = 0;
      for (const url of urls) {
        const existing = await cache.match(url);
        if (!existing) {
          try {
            const res = await fetch(url);
            if (res.ok) {
              await cache.put(url, res);
              cached++;
            } else { failed++; }
          } catch { failed++; }
        } else { cached++; }
        // Report progress
        self.clients.matchAll().then(clients => {
          clients.forEach(c => c.postMessage({
            type: 'CACHE_PROGRESS',
            cached: cached,
            failed,
            total: urls.length
          }));
        });
      }
      self.clients.matchAll().then(clients => {
        clients.forEach(c => c.postMessage({
          type: 'CACHE_COMPLETE',
          cached, failed, total: urls.length
        }));
      });
    });
  }

  if (e.data?.type === 'PURGE_STEMS') {
    // Remove stems for a specific song
    const ytId = e.data.youtubeId;
    caches.open(CACHE_STEMS).then(async cache => {
      const keys = await cache.keys();
      for (const req of keys) {
        if (new URL(req.url).pathname.includes(`/stems/${ytId}/`)) {
          await cache.delete(req);
        }
      }
      self.clients.matchAll().then(clients => {
        clients.forEach(c => c.postMessage({ type: 'PURGE_COMPLETE', youtubeId: ytId }));
      });
    });
  }

  if (e.data?.type === 'GET_CACHE_SIZE') {
    // Estimate cache storage usage
    caches.open(CACHE_STEMS).then(async cache => {
      const keys = await cache.keys();
      let totalSize = 0;
      const songSizes = {};
      for (const req of keys) {
        const pathname = new URL(req.url).pathname;
        const match = pathname.match(/\/stems\/([^/]+)\//);
        if (match) {
          const res = await cache.match(req);
          if (res) {
            const blob = await res.clone().blob();
            totalSize += blob.size;
            songSizes[match[1]] = (songSizes[match[1]] || 0) + blob.size;
          }
        }
      }
      self.clients.matchAll().then(clients => {
        clients.forEach(c => c.postMessage({
          type: 'CACHE_SIZE',
          totalSize, songSizes, fileCount: keys.length
        }));
      });
    });
  }
});

// --- Background Sync ---
self.addEventListener('sync', (e) => {
  if (e.tag === 'sync-edits') {
    e.waitUntil(syncPendingEdits());
  }
});

async function syncPendingEdits() {
  // Get pending edits from IndexedDB and push to server
  // This is triggered when connection is restored
  try {
    const dbReq = indexedDB.open('showtime', 1);
    const idb = await new Promise((resolve, reject) => {
      dbReq.onsuccess = () => resolve(dbReq.result);
      dbReq.onerror = () => reject(dbReq.error);
    });

    const tx = idb.transaction('pendingEdits', 'readonly');
    const store = tx.objectStore('pendingEdits');
    const edits = await new Promise((resolve, reject) => {
      const req = store.getAll();
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });

    if (edits.length === 0) return;

    const res = await fetch('/api/sync', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ edits })
    });

    if (res.ok) {
      // Clear synced edits
      const clearTx = idb.transaction('pendingEdits', 'readwrite');
      clearTx.objectStore('pendingEdits').clear();

      // Notify clients
      self.clients.matchAll().then(clients => {
        clients.forEach(c => c.postMessage({ type: 'SYNC_COMPLETE', count: edits.length }));
      });
    }
  } catch (e) {
    console.error('Background sync failed:', e);
  }
}
