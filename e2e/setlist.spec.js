// @ts-check
const { test, expect } = require('@playwright/test');

test.describe('Setlist View', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await page.evaluate(() => {
      return new Promise((resolve, reject) => {
        // Open without forcing a version so we attach to whatever version the
        // app already created (currently v3). Forcing an older version throws
        // a VersionError and leaves the promise unresolved.
        const req = indexedDB.open('showtime');
        req.onerror = () => reject(req.error);
        req.onsuccess = () => {
          const db = req.result;
          const tx = db.transaction(['playlists', 'songs', 'playlistSongs'], 'readwrite');
          tx.objectStore('playlists').put({ id: 'setlist-pl', title: 'Setlist de Teste', position: 0 });
          tx.objectStore('songs').put({ id: 'sl-s1', youtube_id: 'sl1', title: 'Song One', artist: 'A1', duration: 200, bpm: 120, beatOffset: 0, chords: [], notes: [], bpmSections: [], originalKey: 'Am', pitches: [0], stems: { vocals: '/stems/sl1/vocals.mp3' } });
          tx.objectStore('songs').put({ id: 'sl-s2', youtube_id: 'sl2', title: 'Song Two', artist: 'A2', duration: 180, bpm: 95, beatOffset: 0, chords: [], notes: [], bpmSections: [], originalKey: 'C', pitches: [0], stems: { vocals: '/stems/sl2/vocals.mp3' } });
          tx.objectStore('playlistSongs').put({ playlist_id: 'setlist-pl', song_id: 'sl-s1', position: 0 });
          tx.objectStore('playlistSongs').put({ playlist_id: 'setlist-pl', song_id: 'sl-s2', position: 1 });
          tx.oncomplete = () => { db.close(); resolve(); };
          tx.onerror = () => { db.close(); reject(tx.error); };
        };
      });
    });
    await page.reload();
    await page.waitForLoadState('networkidle');
    await page.locator('[data-view="setlist-view"]').click();
  });

  test('should show setlist view with playlist selector', async ({ page }) => {
    await expect(page.locator('#setlist-select')).toBeVisible();
  });

  test('should populate playlist selector with available playlists', async ({ page }) => {
    const options = await page.locator('#setlist-select option').count();
    expect(options).toBeGreaterThan(1); // default "Selecione" + at least 1 playlist
  });

  test('should render songs when playlist is selected', async ({ page }) => {
    await page.locator('#setlist-select').selectOption('setlist-pl');
    await page.waitForTimeout(300);
    await expect(page.locator('.setlist-item')).toHaveCount(2);
  });

  test('should show BPM for songs that have it', async ({ page }) => {
    await page.locator('#setlist-select').selectOption('setlist-pl');
    await page.waitForTimeout(300);
    await expect(page.locator('.sl-bpm').first()).toContainText('120');
  });

  test('should show key for songs that have it', async ({ page }) => {
    await page.locator('#setlist-select').selectOption('setlist-pl');
    await page.waitForTimeout(300);
    await expect(page.locator('.sl-key').first()).toContainText('Am');
  });

  test('tap on item should highlight it, not load song', async ({ page }) => {
    await page.locator('#setlist-select').selectOption('setlist-pl');
    await page.waitForTimeout(300);
    const item = page.locator('.setlist-item').first();
    await item.click();
    await expect(item).toHaveClass(/active/);
    // Player view should NOT activate
    await expect(page.locator('#setlist-view')).toHaveClass(/active/);
  });

  test('play button should be visible for each song', async ({ page }) => {
    await page.locator('#setlist-select').selectOption('setlist-pl');
    await page.waitForTimeout(300);
    const playBtns = page.locator('[data-sl-play]');
    await expect(playBtns).toHaveCount(2);
  });

  test('play button should have minimum 44px touch target', async ({ page }) => {
    await page.locator('#setlist-select').selectOption('setlist-pl');
    await page.waitForTimeout(300);
    const btn = page.locator('[data-sl-play]').first();
    const box = await btn.boundingBox();
    expect(box.width).toBeGreaterThanOrEqual(44);
    expect(box.height).toBeGreaterThanOrEqual(44);
  });

  test('setlist item title should be large and readable', async ({ page }) => {
    await page.locator('#setlist-select').selectOption('setlist-pl');
    await page.waitForTimeout(300);
    const title = page.locator('.sl-title').first();
    const fontSize = await title.evaluate(el => parseFloat(getComputedStyle(el).fontSize));
    expect(fontSize).toBeGreaterThanOrEqual(16); // 1rem = 16px
  });

  test('key chip is clickable (has data-edit-key) for every song', async ({ page }) => {
    await page.locator('#setlist-select').selectOption('setlist-pl');
    await page.waitForTimeout(300);
    await expect(page.locator('.sl-key[data-edit-key]')).toHaveCount(2);
  });

  test('clicking key chip opens the fixed key picker (12 major + 12 minor + limpar)', async ({ page }) => {
    await page.locator('#setlist-select').selectOption('setlist-pl');
    await page.waitForTimeout(300);
    await page.locator('.sl-key[data-edit-key]').first().click();
    await expect(page.locator('.modal-overlay')).toBeVisible();
    await expect(page.locator('[data-key-cell]')).toHaveCount(24);
    // sl-s1 has 'Am', so a "Limpar" button should be present
    await expect(page.locator('#sl-key-clear')).toBeVisible();
  });

  test('picking a key updates the chip and persists to IndexedDB', async ({ page }) => {
    await page.locator('#setlist-select').selectOption('setlist-pl');
    await page.waitForTimeout(300);
    // Edit the second song (originally 'C') -> set to 'G'
    await page.locator('.sl-key[data-edit-key="sl-s2"]').click();
    await page.locator('[data-key-cell="G"]').click();
    await page.waitForTimeout(200);
    await expect(page.locator('.sl-key[data-edit-key="sl-s2"]')).toContainText('G');

    // Persisted to the songs store
    const stored = await page.evaluate(() => new Promise(resolve => {
      const req = indexedDB.open('showtime');
      req.onsuccess = () => {
        const db = req.result;
        const tx = db.transaction('songs', 'readonly');
        const g = tx.objectStore('songs').get('sl-s2');
        g.onsuccess = () => { db.close(); resolve(g.result); };
      };
    }));
    expect(stored.originalKey).toBe('G');
  });

  test('offline: editing the key queues a pending originalKey edit for later sync', async ({ page }) => {
    // Simulate no route to the server: the sync POST fails, so the queued edit
    // must remain in IndexedDB to be flushed once connectivity returns.
    await page.route('**/api/sync', route => route.abort());

    await page.locator('#setlist-select').selectOption('setlist-pl');
    await page.waitForTimeout(300);
    await page.locator('.sl-key[data-edit-key="sl-s2"]').click();
    await page.locator('[data-key-cell="G"]').click();
    await page.waitForTimeout(300);

    // Chip still updates locally (offline-first)
    await expect(page.locator('.sl-key[data-edit-key="sl-s2"]')).toContainText('G');

    // A pending edit of type 'originalKey' remains queued for later server sync
    const pending = await page.evaluate(() => new Promise(resolve => {
      const req = indexedDB.open('showtime');
      req.onsuccess = () => {
        const db = req.result;
        const tx = db.transaction('pendingEdits', 'readonly');
        const all = tx.objectStore('pendingEdits').getAll();
        all.onsuccess = () => { db.close(); resolve(all.result); };
      };
    }));
    const keyEdits = pending.filter(e => e.type === 'originalKey' && e.songId === 'sl-s2');
    expect(keyEdits.length).toBeGreaterThanOrEqual(1);
    expect(keyEdits[keyEdits.length - 1].value).toBe('G');
  });

  test('clearing a key sets the chip to the empty placeholder', async ({ page }) => {
    await page.locator('#setlist-select').selectOption('setlist-pl');
    await page.waitForTimeout(300);
    await page.locator('.sl-key[data-edit-key="sl-s1"]').click();
    await page.locator('#sl-key-clear').click();
    await page.waitForTimeout(200);
    const chip = page.locator('.sl-key[data-edit-key="sl-s1"]');
    await expect(chip).toHaveClass(/sl-key--empty/);
  });

  test('key chip meets minimum touch target height', async ({ page }) => {
    await page.locator('#setlist-select').selectOption('setlist-pl');
    await page.waitForTimeout(300);
    // key cells inside the picker must be >=44px
    await page.locator('.sl-key[data-edit-key]').first().click();
    const box = await page.locator('[data-key-cell]').first().boundingBox();
    expect(box.height).toBeGreaterThanOrEqual(44);
  });
});
