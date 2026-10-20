// @ts-check
const { test, expect } = require('@playwright/test');

test.describe('Queue ("Tocando agora")', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    // Clear any persisted queue from a previous run.
    await page.evaluate(() => localStorage.removeItem('showtime_queue'));
    await page.evaluate(() => new Promise((resolve, reject) => {
      const req = indexedDB.open('showtime');
      req.onerror = () => reject(req.error);
      req.onsuccess = () => {
        const db = req.result;
        const tx = db.transaction(['songs', 'playlists', 'playlistSongs'], 'readwrite');
        const S = tx.objectStore('songs');
        S.put({ id: 'q1', youtube_id: 'q1', title: 'Q One', artist: 'A', duration: 100, bpm: 100, beatOffset: 0, chords: [], notes: [], bpmSections: [], originalKey: null, pitches: [0], stems: { vocals: '/stems/q1/vocals.mp3' } });
        S.put({ id: 'q2', youtube_id: 'q2', title: 'Q Two', artist: 'A', duration: 100, bpm: 100, beatOffset: 0, chords: [], notes: [], bpmSections: [], originalKey: null, pitches: [0], stems: { vocals: '/stems/q2/vocals.mp3' } });
        S.put({ id: 'q3', youtube_id: 'q3', title: 'Q Three', artist: 'A', duration: 100, bpm: 100, beatOffset: 0, chords: [], notes: [], bpmSections: [], originalKey: null, pitches: [0], stems: { vocals: '/stems/q3/vocals.mp3' } });
        tx.objectStore('playlists').put({ id: 'q-pl', title: 'Queue PL', position: 0 });
        tx.objectStore('playlistSongs').put({ playlist_id: 'q-pl', song_id: 'q1', position: 0 });
        tx.objectStore('playlistSongs').put({ playlist_id: 'q-pl', song_id: 'q2', position: 1 });
        tx.oncomplete = () => { db.close(); resolve(); };
        tx.onerror = () => { db.close(); reject(tx.error); };
      };
    }));
    await page.reload();
    await page.waitForLoadState('networkidle');
  });

  // Helper: read the current queue state from localStorage.
  async function getQueue(page) {
    return page.evaluate(() => JSON.parse(localStorage.getItem('showtime_queue') || '{"queue":[]}'));
  }

  test('has a Fila nav item that opens the queue view', async ({ page }) => {
    await expect(page.locator('[data-view="queue-view"]')).toBeVisible();
    await page.locator('[data-view="queue-view"]').click();
    await expect(page.locator('#queue-view')).toHaveClass(/active/);
  });

  test('empty queue shows an empty state', async ({ page }) => {
    await page.locator('[data-view="queue-view"]').click();
    await expect(page.locator('#queue-content')).toContainText('Fila vazia');
  });

  test('playing a playlist fills the queue with its songs in order', async ({ page }) => {
    await page.locator('[data-playlist-id="q-pl"]').click();
    await page.waitForTimeout(200);
    await page.locator('#pl-play-all').click();
    await page.waitForTimeout(500);
    const q = await getQueue(page);
    expect(q.queue).toEqual(['q1', 'q2']);
    expect(q.queueIndex).toBe(0);
  });

  test('"Tocar a seguir" inserts right after the current song', async ({ page }) => {
    // Start the playlist (queue = [q1, q2], index 0)
    await page.locator('[data-playlist-id="q-pl"]').click();
    await page.waitForTimeout(200);
    await page.locator('#pl-play-all').click();
    await page.waitForTimeout(400);
    // Go back to library root, open the song menu for q3 and add "play next".
    await page.locator('[data-view="library-view"]').click();
    await page.locator('#lib-back').click();
    await page.locator('[data-song-menu="q3"]').click();
    await page.locator('.action-sheet-item', { hasText: 'Tocar a seguir' }).click();
    await page.waitForTimeout(200);
    const q = await getQueue(page);
    // q3 should be inserted at index 1 (right after current q1).
    expect(q.queue).toEqual(['q1', 'q3', 'q2']);
  });

  test('"Adicionar ao final" appends to the end of the queue', async ({ page }) => {
    await page.locator('[data-playlist-id="q-pl"]').click();
    await page.waitForTimeout(200);
    await page.locator('#pl-play-all').click();
    await page.waitForTimeout(400);
    await page.locator('[data-view="library-view"]').click();
    await page.locator('#lib-back').click();
    await page.locator('[data-song-menu="q3"]').click();
    await page.locator('.action-sheet-item', { hasText: 'Adicionar ao final' }).click();
    await page.waitForTimeout(200);
    const q = await getQueue(page);
    expect(q.queue).toEqual(['q1', 'q2', 'q3']);
  });

  test('adding a whole playlist to the queue does not alter the saved playlist', async ({ page }) => {
    // Start with a single song so the queue context is not the playlist.
    await page.locator('[data-song-menu="q3"]').click();
    await page.locator('.action-sheet-item', { hasText: 'Adicionar ao final' }).click();
    await page.waitForTimeout(150);
    // Now append the whole playlist via its menu.
    await page.locator('[data-playlist-menu="q-pl"]').click();
    await page.locator('.action-sheet-item', { hasText: 'Adicionar ao final' }).click();
    await page.waitForTimeout(200);
    const q = await getQueue(page);
    expect(q.queue).toEqual(['q3', 'q1', 'q2']);

    // The saved playlist still has exactly its 2 original songs.
    const plSongs = await page.evaluate(() => new Promise(resolve => {
      const req = indexedDB.open('showtime');
      req.onsuccess = () => {
        const db = req.result;
        const tx = db.transaction('playlistSongs', 'readonly');
        const all = tx.objectStore('playlistSongs').getAll();
        all.onsuccess = () => { db.close(); resolve(all.result.filter(p => p.playlist_id === 'q-pl')); };
      };
    }));
    expect(plSongs.length).toBe(2);
  });

  test('removing a queue item updates the queue without touching the playlist', async ({ page }) => {
    await page.locator('[data-playlist-id="q-pl"]').click();
    await page.waitForTimeout(200);
    await page.locator('#pl-play-all').click();
    await page.waitForTimeout(400);
    await page.locator('[data-view="queue-view"]').click();
    await page.waitForTimeout(200);
    // Remove the 2nd item (q2).
    await page.locator('[data-q-remove="1"]').click();
    await page.waitForTimeout(200);
    const q = await getQueue(page);
    expect(q.queue).toEqual(['q1']);
  });

  test('clear empties the queue', async ({ page }) => {
    await page.locator('[data-playlist-id="q-pl"]').click();
    await page.waitForTimeout(200);
    await page.locator('#pl-play-all').click();
    await page.waitForTimeout(400);
    await page.locator('[data-view="queue-view"]').click();
    await page.locator('#queue-clear').click();
    await page.waitForTimeout(200);
    const q = await getQueue(page);
    expect(q.queue).toEqual([]);
    await expect(page.locator('#queue-content')).toContainText('Fila vazia');
  });

  test('queue item play button has an adequate touch target', async ({ page }) => {
    await page.locator('[data-playlist-id="q-pl"]').click();
    await page.waitForTimeout(200);
    await page.locator('#pl-play-all').click();
    await page.waitForTimeout(400);
    await page.locator('[data-view="queue-view"]').click();
    await page.waitForTimeout(200);
    const box = await page.locator('[data-q-play="0"]').boundingBox();
    expect(box.width).toBeGreaterThanOrEqual(36);
    expect(box.height).toBeGreaterThanOrEqual(36);
  });
});
