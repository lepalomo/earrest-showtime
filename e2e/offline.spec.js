// @ts-check
const { test, expect } = require('@playwright/test');

test.describe('Offline Capability', () => {
  test('should open app without network', async ({ page, context }) => {
    // First visit to cache app shell
    await page.goto('/');
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(2000);

    // Go offline
    await context.setOffline(true);
    await page.reload();
    await page.waitForLoadState('domcontentloaded');

    // App should still render
    await expect(page.locator('.header h1')).toContainText('Showtime');
  });

  test('should show offline badge when offline', async ({ page, context }) => {
    await page.goto('/');
    await page.waitForLoadState('networkidle');

    // Block ping endpoint to simulate offline. context.route also intercepts
    // service-worker fetches (page.route does not).
    await context.route('**/api/ping', route => route.abort());
    // Wait for connectivity check interval
    await page.waitForTimeout(16000);

    await expect(page.locator('#offline-badge')).toHaveClass(/visible/);
  });

  test('should show library data from IndexedDB when offline', async ({ page, context }) => {
    await page.goto('/');
    await page.waitForLoadState('networkidle');
    // The app shell + ES modules must be cached before going offline. Wait for
    // the service worker to be activated AND controlling the page, otherwise an
    // offline reload races the SW install and the shell fails to load.
    await page.evaluate(async () => {
      const reg = await navigator.serviceWorker.ready;
      if (!navigator.serviceWorker.controller) {
        await new Promise(res => navigator.serviceWorker.addEventListener('controllerchange', res, { once: true }));
      }
      return reg.active?.state;
    });
    // Seed data
    await page.evaluate(() => {
      return new Promise(resolve => {
        const req = indexedDB.open('showtime');
        req.onsuccess = () => {
          const db = req.result;
          const tx = db.transaction(['songs'], 'readwrite');
          tx.objectStore('songs').put({ id: 'offline-s', youtube_id: 'off1', title: 'Offline Song', artist: 'Off', duration: 100, stems: {}, bpm: 80 });
          tx.oncomplete = () => { db.close(); resolve(); };
        };
      });
    });

    // Go offline and reload
    await context.setOffline(true);
    await page.reload();
    await page.waitForLoadState('domcontentloaded');
    await page.waitForTimeout(1000);

    await expect(page.locator('[data-song-id="offline-s"]')).toBeVisible();
  });

  test('should navigate between views when offline', async ({ page, context }) => {
    await page.goto('/');
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(1000);

    await context.setOffline(true);

    // Navigate between views
    await page.locator('[data-view="player-view"]').click();
    await expect(page.locator('#player-view')).toHaveClass(/active/);

    await page.locator('[data-view="setlist-view"]').click();
    await expect(page.locator('#setlist-view')).toHaveClass(/active/);

    await page.locator('[data-view="library-view"]').click();
    await expect(page.locator('#library-view')).toHaveClass(/active/);
  });

  test('sync view should show "sem conexão" message when offline', async ({ page, context }) => {
    await page.goto('/');
    await page.waitForLoadState('networkidle');
    await context.route('**/api/ping', route => route.abort());
    await context.route('**/api/catalog', route => route.abort());
    await page.waitForTimeout(16000);

    await page.locator('[data-view="sync-view"]').click();
    await expect(page.locator('#catalog-content')).toContainText('Sem conexão');
  });
});

test.describe('Offline — Data Persistence', () => {
  test('should persist song settings in localStorage', async ({ page }) => {
    await page.goto('/');
    await page.evaluate(() => {
      localStorage.setItem('showtime_test-song', JSON.stringify({ speed: 0.8, loopA: 10, loopB: 30 }));
    });
    const saved = await page.evaluate(() => JSON.parse(localStorage.getItem('showtime_test-song')));
    expect(saved.speed).toBe(0.8);
    expect(saved.loopA).toBe(10);
    expect(saved.loopB).toBe(30);
  });

  test('should store pending edits in IndexedDB', async ({ page }) => {
    await page.goto('/');
    await page.waitForLoadState('networkidle');
    await page.evaluate(() => {
      return new Promise(resolve => {
        const req = indexedDB.open('showtime');
        req.onsuccess = () => {
          const db = req.result;
          const tx = db.transaction('pendingEdits', 'readwrite');
          tx.objectStore('pendingEdits').add({ type: 'bpm', songId: 'test1', value: 140, ts: Date.now() });
          tx.oncomplete = () => {
            const readTx = db.transaction('pendingEdits', 'readonly');
            readTx.objectStore('pendingEdits').getAll().onsuccess = (e) => {
              db.close();
              resolve(e.target.result);
            };
          };
        };
      });
    }).then(edits => {
      expect(edits.length).toBe(1);
      expect(edits[0].type).toBe('bpm');
      expect(edits[0].value).toBe(140);
    });
  });
});
