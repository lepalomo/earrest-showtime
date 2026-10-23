// @ts-check
const { test, expect } = require('@playwright/test');

test.describe('Responsiveness — No Horizontal Overflow', () => {
  const views = ['library-view', 'player-view', 'setlist-view', 'sync-view'];

  for (const view of views) {
    test(`${view} should have no horizontal scroll`, async ({ page }) => {
      await page.goto('/');
      await page.waitForLoadState('networkidle');
      await page.locator(`[data-view="${view}"]`).click();
      await page.waitForTimeout(300);

      const hasOverflow = await page.evaluate(() => {
        return document.documentElement.scrollWidth > document.documentElement.clientWidth;
      });
      expect(hasOverflow).toBe(false);
    });
  }
});

test.describe('Responsiveness — Touch Targets', () => {
  test('nav items should have minimum 44px height', async ({ page }) => {
    await page.goto('/');
    const navItems = page.locator('.nav-item');
    const count = await navItems.count();
    for (let i = 0; i < count; i++) {
      const box = await navItems.nth(i).boundingBox();
      expect(box.height).toBeGreaterThanOrEqual(44);
    }
  });

  test('playlist cards should have minimum 44px height', async ({ page }) => {
    await page.goto('/');
    await page.evaluate(() => {
      return new Promise(resolve => {
        const req = indexedDB.open('showtime');
        req.onsuccess = () => {
          const db = req.result;
          const tx = db.transaction(['playlists'], 'readwrite');
          tx.objectStore('playlists').put({ id: 'resp-pl', title: 'Responsive Test', position: 0 });
          tx.oncomplete = () => { db.close(); resolve(); };
        };
      });
    });
    await page.reload();
    await page.waitForLoadState('networkidle');
    const card = page.locator('.playlist-card').first();
    const box = await card.boundingBox();
    expect(box.height).toBeGreaterThanOrEqual(44);
  });

  test('song items should have minimum 44px height', async ({ page }) => {
    await page.goto('/');
    await page.evaluate(() => {
      return new Promise(resolve => {
        const req = indexedDB.open('showtime');
        req.onsuccess = () => {
          const db = req.result;
          const tx = db.transaction(['songs'], 'readwrite');
          tx.objectStore('songs').put({ id: 'resp-s', youtube_id: 'r1', title: 'Resp Song', artist: '', duration: 100, stems: {} });
          tx.oncomplete = () => { db.close(); resolve(); };
        };
      });
    });
    await page.reload();
    await page.waitForLoadState('networkidle');
    const item = page.locator('.song-item').first();
    const box = await item.boundingBox();
    expect(box.height).toBeGreaterThanOrEqual(44);
  });
});

test.describe('Responsiveness — Layout Adaptation', () => {
  test('should use single column on mobile (375px)', async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 812 });
    await page.goto('/');
    await page.waitForLoadState('networkidle');
    // Catalog should be single column
    await page.locator('[data-view="sync-view"]').click();
    await page.waitForTimeout(500);
    // The catalog may render more than one `.catalog-list` (e.g. "Playlists"
    // and "Músicas avulsas" sections). Assert every one is single-column, and
    // avoid strict-mode violations by iterating per element.
    const lists = page.locator('.catalog-list');
    const count = await lists.count();
    for (let i = 0; i < count; i++) {
      const gridCols = await lists.nth(i).evaluate(el => getComputedStyle(el).gridTemplateColumns);
      // Single column = flex (grid-template-columns: none) or one track value.
      expect(gridCols === 'none' || gridCols.split(' ').length <= 1).toBeTruthy();
    }
  });

  test('should adapt layout after viewport resize', async ({ page }) => {
    await page.goto('/');
    await page.waitForLoadState('networkidle');
    // Start mobile
    await page.setViewportSize({ width: 375, height: 812 });
    await page.waitForTimeout(300);
    // Expand to desktop
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.waitForTimeout(300);
    // No horizontal overflow
    const hasOverflow = await page.evaluate(() =>
      document.documentElement.scrollWidth > document.documentElement.clientWidth
    );
    expect(hasOverflow).toBe(false);
  });
});

test.describe('Responsiveness — Text Overflow', () => {
  test('long titles should not overflow', async ({ page }) => {
    await page.goto('/');
    await page.evaluate(() => {
      return new Promise(resolve => {
        const req = indexedDB.open('showtime');
        req.onsuccess = () => {
          const db = req.result;
          const tx = db.transaction(['songs'], 'readwrite');
          tx.objectStore('songs').put({
            id: 'long-title', youtube_id: 'lt1',
            title: 'This Is An Extremely Long Song Title That Should Be Truncated With Ellipsis And Not Cause Horizontal Overflow In The Layout',
            artist: 'Some Very Long Artist Name That Also Needs To Be Truncated Properly',
            duration: 300, stems: {}, bpm: 120
          });
          tx.oncomplete = () => { db.close(); resolve(); };
        };
      });
    });
    await page.reload();
    await page.waitForLoadState('networkidle');
    const hasOverflow = await page.evaluate(() =>
      document.documentElement.scrollWidth > document.documentElement.clientWidth
    );
    expect(hasOverflow).toBe(false);
  });
});
