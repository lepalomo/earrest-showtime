// @ts-check
const { test, expect } = require('@playwright/test');

test.describe('Navigation — View Switching', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await page.waitForLoadState('networkidle');
  });

  test('should switch to player view on tab click', async ({ page }) => {
    await page.locator('[data-view="player-view"]').click();
    await expect(page.locator('#player-view')).toHaveClass(/active/);
    await expect(page.locator('#library-view')).not.toHaveClass(/active/);
  });

  test('should switch to setlist view on tab click', async ({ page }) => {
    await page.locator('[data-view="setlist-view"]').click();
    await expect(page.locator('#setlist-view')).toHaveClass(/active/);
  });

  test('should switch to sync view on tab click', async ({ page }) => {
    await page.locator('[data-view="sync-view"]').click();
    await expect(page.locator('#sync-view')).toHaveClass(/active/);
  });

  test('should switch back to library view', async ({ page }) => {
    await page.locator('[data-view="sync-view"]').click();
    await page.locator('[data-view="library-view"]').click();
    await expect(page.locator('#library-view')).toHaveClass(/active/);
  });

  test('should highlight active nav item', async ({ page }) => {
    await page.locator('[data-view="player-view"]').click();
    await expect(page.locator('[data-view="player-view"]')).toHaveClass(/active/);
    await expect(page.locator('[data-view="library-view"]')).not.toHaveClass(/active/);
  });
});

test.describe('Navigation — Library Drill-Down', () => {
  test('should show playlists in library when data exists', async ({ page }) => {
    await page.goto('/');
    // Seed IDB with a playlist
    await page.evaluate(() => {
      return new Promise(resolve => {
        const req = indexedDB.open('showtime');
        req.onsuccess = () => {
          const db = req.result;
          const tx = db.transaction(['playlists', 'songs', 'playlistSongs'], 'readwrite');
          tx.objectStore('playlists').put({ id: 'test-pl', title: 'Test Playlist', position: 0 });
          tx.objectStore('songs').put({ id: 'test-song', youtube_id: 'abc123', title: 'Test Song', artist: 'Artist', duration: 180, stems: {}, bpm: 120 });
          tx.objectStore('playlistSongs').put({ playlist_id: 'test-pl', song_id: 'test-song', position: 0 });
          tx.oncomplete = () => { db.close(); resolve(); };
        };
      });
    });
    await page.reload();
    await page.waitForLoadState('networkidle');
    await expect(page.locator('[data-playlist-id="test-pl"]')).toBeVisible();
  });

  test('should drill into playlist on click', async ({ page }) => {
    await page.goto('/');
    await page.evaluate(() => {
      return new Promise(resolve => {
        const req = indexedDB.open('showtime');
        req.onsuccess = () => {
          const db = req.result;
          const tx = db.transaction(['playlists', 'songs', 'playlistSongs'], 'readwrite');
          tx.objectStore('playlists').put({ id: 'pl2', title: 'Drill Playlist', position: 0 });
          tx.objectStore('songs').put({ id: 'song2', youtube_id: 'def456', title: 'Drill Song', artist: 'Art', duration: 200, stems: {}, bpm: 90 });
          tx.objectStore('playlistSongs').put({ playlist_id: 'pl2', song_id: 'song2', position: 0 });
          tx.oncomplete = () => { db.close(); resolve(); };
        };
      });
    });
    await page.reload();
    await page.waitForLoadState('networkidle');
    await page.locator('[data-playlist-id="pl2"]').click();
    await expect(page.locator('#lib-back')).toBeVisible();
    await expect(page.locator('[data-song-id="song2"]')).toBeVisible();
  });

  test('should go back from playlist to main library', async ({ page }) => {
    await page.goto('/');
    await page.evaluate(() => {
      return new Promise(resolve => {
        const req = indexedDB.open('showtime');
        req.onsuccess = () => {
          const db = req.result;
          const tx = db.transaction(['playlists'], 'readwrite');
          tx.objectStore('playlists').put({ id: 'pl3', title: 'Back Test', position: 0 });
          tx.oncomplete = () => { db.close(); resolve(); };
        };
      });
    });
    await page.reload();
    await page.waitForLoadState('networkidle');
    await page.locator('[data-playlist-id="pl3"]').click();
    await page.locator('#lib-back').click();
    await expect(page.locator('[data-playlist-id="pl3"]')).toBeVisible();
    await expect(page.locator('#lib-back')).not.toBeVisible();
  });
});
