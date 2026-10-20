// @ts-check
const { test, expect } = require('@playwright/test');

test.describe('Player — Layout & Controls', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    // Seed a song into IDB
    await page.evaluate(() => {
      return new Promise(resolve => {
        const req = indexedDB.open('showtime');
        req.onsuccess = () => {
          const db = req.result;
          const tx = db.transaction(['songs', 'playlists', 'playlistSongs'], 'readwrite');
          tx.objectStore('songs').put({
            id: 'player-test', youtube_id: 'xyz789', title: 'Player Test Song',
            artist: 'Test Artist', duration: 240, bpm: 120, beatOffset: 0.5,
            chords: [{ time: 0, chord: 'Am' }, { time: 3, chord: 'F' }, { time: 6, chord: 'C' }],
            notes: [{ time: 5, text: 'test note' }],
            bpmSections: [], originalKey: 'Am', pitches: [0],
            stems: { vocals: '/stems/xyz789/vocals.mp3', drums: '/stems/xyz789/drums.mp3', bass: '/stems/xyz789/bass.mp3' }
          });
          tx.oncomplete = () => { db.close(); resolve(); };
        };
      });
    });
    await page.reload();
    await page.waitForLoadState('networkidle');
  });

  test('should show empty state when no song is selected', async ({ page }) => {
    await page.locator('[data-view="player-view"]').click();
    await expect(page.locator('#player-container')).toContainText('Nenhuma música selecionada');
  });

  test('should render player when a song is selected from library', async ({ page }) => {
    await page.locator('[data-song-id="player-test"]').click();
    await expect(page.locator('#player-view')).toHaveClass(/active/);
    await expect(page.locator('.np-title')).toContainText('Player Test Song');
  });

  test('should show transport controls', async ({ page }) => {
    await page.locator('[data-song-id="player-test"]').click();
    await expect(page.locator('#play-btn')).toBeVisible();
    await expect(page.locator('[data-action="prev"]')).toBeVisible();
    await expect(page.locator('[data-action="next"]')).toBeVisible();
  });

  test('should show timeline', async ({ page }) => {
    await page.locator('[data-song-id="player-test"]').click();
    await expect(page.locator('#timeline')).toBeVisible();
    await expect(page.locator('#time-now')).toBeVisible();
    await expect(page.locator('#time-total')).toBeVisible();
  });

  test('should show mixer with stems', async ({ page }) => {
    await page.locator('[data-song-id="player-test"]').click();
    await page.waitForTimeout(1000);
    const mixer = page.locator('#mixer');
    await expect(mixer).toBeVisible();
  });

  test('should show tools (metronome, loop, notes)', async ({ page }) => {
    await page.locator('[data-song-id="player-test"]').click();
    await expect(page.locator('[data-tool="metronome"]')).toBeVisible();
    await expect(page.locator('[data-tool="loop-a"]')).toBeVisible();
    await expect(page.locator('[data-tool="notes"]')).toBeVisible();
  });

  test('should show chord bar with chords', async ({ page }) => {
    await page.locator('[data-song-id="player-test"]').click();
    await page.waitForTimeout(500);
    const chordBar = page.locator('#chord-bar');
    await expect(chordBar).toBeVisible();
  });

  test('play button should have minimum 44px touch target', async ({ page }) => {
    await page.locator('[data-song-id="player-test"]').click();
    const btn = page.locator('#play-btn');
    const box = await btn.boundingBox();
    expect(box.width).toBeGreaterThanOrEqual(44);
    expect(box.height).toBeGreaterThanOrEqual(44);
  });

  test('transport controls stay fully within the viewport (no vertical overflow)', async ({ page }) => {
    await page.locator('[data-song-id="player-test"]').click();
    await page.waitForTimeout(300);
    const vh = page.viewportSize().height;
    const playBox = await page.locator('#play-btn').boundingBox();
    // The whole transport button must be above the bottom edge of the screen.
    expect(playBox.y + playBox.height).toBeLessThanOrEqual(vh);
    // And the transport bar itself must be within bounds.
    const transportBox = await page.locator('#transport').boundingBox();
    expect(transportBox.y + transportBox.height).toBeLessThanOrEqual(vh + 1);
    // The app shell must not exceed the viewport height (no page scroll).
    const appBox = await page.locator('#app').boundingBox();
    expect(appBox.height).toBeLessThanOrEqual(vh + 1);
  });

  test('the mixer (faders area) does not create its own vertical scrollbar', async ({ page }) => {
    await page.locator('[data-song-id="player-test"]').click();
    await page.waitForTimeout(400);
    // The faders area scrolls horizontally (many stems) but never vertically —
    // vertical scrolling belongs to the single player-container scroll.
    const vOverflow = await page.locator('.mixer').evaluate(el => el.scrollHeight - el.clientHeight);
    expect(vOverflow).toBeLessThanOrEqual(1);
  });

  test('should show the key (tom) chip with the current key', async ({ page }) => {
    await page.locator('[data-song-id="player-test"]').click();
    await page.waitForTimeout(300);
    const keyChip = page.locator('#np-key');
    await expect(keyChip).toBeVisible();
    await expect(keyChip).toContainText('Am');
  });

  test('editing the key from the player updates the chip and persists', async ({ page }) => {
    await page.locator('[data-song-id="player-test"]').click();
    await page.waitForTimeout(300);
    await page.locator('#np-key').click();
    await expect(page.locator('.modal-overlay')).toBeVisible();
    await expect(page.locator('[data-key-cell]')).toHaveCount(24);
    await page.locator('[data-key-cell="F#m"]').click();
    await page.waitForTimeout(200);
    await expect(page.locator('#np-key')).toContainText('F#m');

    const stored = await page.evaluate(() => new Promise(resolve => {
      const req = indexedDB.open('showtime');
      req.onsuccess = () => {
        const db = req.result;
        const tx = db.transaction('songs', 'readonly');
        const g = tx.objectStore('songs').get('player-test');
        g.onsuccess = () => { db.close(); resolve(g.result); };
      };
    }));
    expect(stored.originalKey).toBe('F#m');
  });
});

test.describe('Player — Mixer Controls', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await page.evaluate(() => {
      return new Promise(resolve => {
        const req = indexedDB.open('showtime');
        req.onsuccess = () => {
          const db = req.result;
          const tx = db.transaction(['songs'], 'readwrite');
          tx.objectStore('songs').put({
            id: 'mixer-test', youtube_id: 'mix123', title: 'Mixer Song',
            artist: '', duration: 180, bpm: null, beatOffset: 0,
            chords: [], notes: [], bpmSections: [], originalKey: null, pitches: [0],
            stems: { vocals: '/stems/mix123/vocals.mp3', drums: '/stems/mix123/drums.mp3', bass: '/stems/mix123/bass.mp3', guitar: '/stems/mix123/guitar.mp3' }
          });
          tx.oncomplete = () => { db.close(); resolve(); };
        };
      });
    });
    await page.reload();
    await page.waitForLoadState('networkidle');
    await page.locator('[data-song-id="mixer-test"]').click();
    // Wait for player to render (mixer renders after waitForBuffering timeout ~6s for missing stems)
    await page.waitForTimeout(8000);
  });

  test('should show mixer area', async ({ page }) => {
    const mixer = page.locator('#mixer');
    await expect(mixer).toBeVisible();
    // Mixer should have content (even if stems are not loaded, it renders based on song.stems keys)
    const content = await mixer.innerHTML();
    expect(content.length).toBeGreaterThan(0);
  });

  test('should have mute buttons for stems', async ({ page }) => {
    // Even without loaded audio, the mixer renders from song.stems
    const muteBtn = page.locator('[data-mute]');
    const count = await muteBtn.count();
    expect(count).toBeGreaterThan(0);
  });

  test('should have solo buttons for stems', async ({ page }) => {
    const soloBtn = page.locator('[data-solo]');
    const count = await soloBtn.count();
    expect(count).toBeGreaterThan(0);
  });

  test('should have volume sliders for stems', async ({ page }) => {
    const volSlider = page.locator('[data-stem-vol]');
    const count = await volSlider.count();
    expect(count).toBeGreaterThan(0);
  });
});

test.describe('Player — Speed Control', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await page.evaluate(() => {
      return new Promise(resolve => {
        const req = indexedDB.open('showtime');
        req.onsuccess = () => {
          const db = req.result;
          const tx = db.transaction(['songs'], 'readwrite');
          tx.objectStore('songs').put({
            id: 'speed-test', youtube_id: 'spd123', title: 'Speed Song',
            artist: '', duration: 180, bpm: 100, beatOffset: 0,
            chords: [], notes: [], bpmSections: [], originalKey: null, pitches: [0],
            stems: { vocals: '/stems/spd123/vocals.mp3' }
          });
          tx.oncomplete = () => { db.close(); resolve(); };
        };
      });
    });
    await page.reload();
    await page.locator('[data-song-id="speed-test"]').click();
    await page.waitForTimeout(500);
  });

  test('should show speed control', async ({ page }) => {
    await expect(page.locator('#speed-range')).toBeVisible();
    await expect(page.locator('#speed-value')).toBeVisible();
  });

  test('should show 1.00x as default speed', async ({ page }) => {
    await expect(page.locator('#speed-value')).toContainText('1.00x');
  });
});

test.describe('Player — Background / Visibility resilience', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await page.evaluate(() => {
      return new Promise(resolve => {
        const req = indexedDB.open('showtime');
        req.onsuccess = () => {
          const db = req.result;
          const tx = db.transaction(['songs'], 'readwrite');
          tx.objectStore('songs').put({
            id: 'bg-test', youtube_id: 'bg123', title: 'Background Song',
            artist: 'BG', duration: 200, bpm: 100, beatOffset: 0,
            chords: [{ time: 0, chord: 'C' }], notes: [], bpmSections: [],
            originalKey: 'C', pitches: [0],
            stems: { vocals: '/stems/bg123/vocals.mp3', drums: '/stems/bg123/drums.mp3', bass: '/stems/bg123/bass.mp3' }
          });
          tx.oncomplete = () => { db.close(); resolve(); };
        };
      });
    });
    await page.reload();
    await page.waitForLoadState('networkidle');
  });

  // Helper: drive the document.visibilityState + dispatch the event the app listens to.
  async function setHidden(page, hidden) {
    await page.evaluate((h) => {
      Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => h ? 'hidden' : 'visible' });
      Object.defineProperty(document, 'hidden', { configurable: true, get: () => h });
      // Emulate the OS suspending the audio context when the screen turns off:
      // clear the forced-running flag so the app must resume() again.
      if (h && window.__forceCtxSuspend) window.__forceCtxSuspend();
      document.dispatchEvent(new Event('visibilitychange'));
    }, hidden);
  }

  test('a hidden→visible cycle does not throw or break the player', async ({ page }) => {
    const errors = [];
    page.on('pageerror', e => errors.push(String(e)));

    await page.locator('[data-song-id="bg-test"]').click();
    await page.waitForTimeout(500);

    // Simulate the screen turning off and back on a few times.
    for (let i = 0; i < 3; i++) {
      await setHidden(page, true);
      await page.waitForTimeout(150);
      await setHidden(page, false);
      await page.waitForTimeout(150);
    }

    // Player transport is still present and interactive.
    await expect(page.locator('#play-btn')).toBeVisible();
    // The timeline (visual updates resumed) is still there.
    await expect(page.locator('#timeline')).toBeVisible();
    expect(errors).toEqual([]);
  });

  test('visibility handler is registered (no listener errors on dispatch)', async ({ page }) => {
    const errors = [];
    page.on('pageerror', e => errors.push(String(e)));
    await page.locator('[data-song-id="bg-test"]').click();
    await page.waitForTimeout(300);
    await setHidden(page, true);
    await setHidden(page, false);
    await page.waitForTimeout(200);
    expect(errors).toEqual([]);
  });

  test('switching songs while hidden resumes the AudioContext (no silent playback)', async ({ page }) => {
    // Instrument AudioContext.resume BEFORE the app boots so we can observe
    // that a track change in the background triggers a resume attempt.
    await page.addInitScript(() => {
      window.__resumeCalls = 0;
      window.__ctxInstances = [];
      window.__forceCtxSuspend = () => { window.__ctxInstances.forEach(c => { c.__forcedRunning = false; }); };
      const AC = window.AudioContext || window.webkitAudioContext;
      if (AC && !AC.__patched) {
        const origResume = AC.prototype.resume;
        const desc = Object.getOwnPropertyDescriptor(AC.prototype, 'state')
          || Object.getOwnPropertyDescriptor(Object.getPrototypeOf(AC.prototype), 'state');
        AC.prototype.resume = function () {
          window.__resumeCalls++;
          this.__forcedRunning = true;
          if (window.__ctxInstances.indexOf(this) === -1) window.__ctxInstances.push(this);
          return origResume.apply(this, arguments);
        };
        if (desc && desc.get) {
          Object.defineProperty(AC.prototype, 'state', {
            configurable: true,
            get: function () {
              const real = desc.get.call(this);
              if (real === 'running' && !this.__forcedRunning) return 'suspended';
              return real;
            }
          });
        }
        AC.__patched = true;
      }
    });

    // Seed a 2-song playlist so "next" has a target.
    await page.goto('/');
    await page.evaluate(() => new Promise(resolve => {
      const req = indexedDB.open('showtime');
      req.onsuccess = () => {
        const db = req.result;
        const tx = db.transaction(['songs', 'playlists', 'playlistSongs'], 'readwrite');
        tx.objectStore('songs').put({ id: 'bg-a', youtube_id: 'bga', title: 'BG A', artist: '', duration: 200, bpm: 100, beatOffset: 0, chords: [], notes: [], bpmSections: [], originalKey: null, pitches: [0], stems: { vocals: '/stems/bga/vocals.mp3', drums: '/stems/bga/drums.mp3' } });
        tx.objectStore('songs').put({ id: 'bg-b', youtube_id: 'bgb', title: 'BG B', artist: '', duration: 200, bpm: 100, beatOffset: 0, chords: [], notes: [], bpmSections: [], originalKey: null, pitches: [0], stems: { vocals: '/stems/bgb/vocals.mp3', drums: '/stems/bgb/drums.mp3' } });
        tx.objectStore('playlists').put({ id: 'bg-pl', title: 'BG PL', position: 0 });
        tx.objectStore('playlistSongs').put({ playlist_id: 'bg-pl', song_id: 'bg-a', position: 0 });
        tx.objectStore('playlistSongs').put({ playlist_id: 'bg-pl', song_id: 'bg-b', position: 1 });
        tx.oncomplete = () => { db.close(); resolve(); };
      };
    }));
    await page.reload();
    await page.waitForLoadState('networkidle');

    // Enter the playlist and start the first song.
    await page.locator('[data-playlist-id="bg-pl"]').click();
    await page.waitForTimeout(200);
    await page.locator('[data-song-id="bg-a"]').click();
    await page.waitForTimeout(500);

    // Go to background and count resume calls from this point.
    await setHidden(page, true);
    const before = await page.evaluate(() => window.__resumeCalls);

    // Advance to the next track (as the OS media control would).
    await page.locator('[data-action="next"]').click();
    await page.waitForTimeout(1500);

    const after = await page.evaluate(() => window.__resumeCalls);
    expect(after).toBeGreaterThan(before);
  });

  test('a background track change reuses the audio graph (no new MediaElementSource)', async ({ page }) => {
    // Count createMediaElementSource calls: the persistent pool must be built
    // up front (foregrounded), so switching songs in the background creates 0
    // new source nodes — the fragile operation that caused the glitch.
    await page.addInitScript(() => {
      window.__mesCalls = 0;
      const AC = window.AudioContext || window.webkitAudioContext;
      if (AC && !AC.__mesPatched) {
        const orig = AC.prototype.createMediaElementSource;
        AC.prototype.createMediaElementSource = function () {
          window.__mesCalls++;
          return orig.apply(this, arguments);
        };
        AC.__mesPatched = true;
      }
    });

    await page.goto('/');
    await page.evaluate(() => new Promise(resolve => {
      const req = indexedDB.open('showtime');
      req.onsuccess = () => {
        const db = req.result;
        const tx = db.transaction(['songs', 'playlists', 'playlistSongs'], 'readwrite');
        tx.objectStore('songs').put({ id: 'pool-a', youtube_id: 'pla', title: 'Pool A', artist: '', duration: 200, bpm: 100, beatOffset: 0, chords: [], notes: [], bpmSections: [], originalKey: null, pitches: [0], stems: { vocals: '/stems/pla/vocals.mp3', drums: '/stems/pla/drums.mp3' } });
        tx.objectStore('songs').put({ id: 'pool-b', youtube_id: 'plb', title: 'Pool B', artist: '', duration: 200, bpm: 100, beatOffset: 0, chords: [], notes: [], bpmSections: [], originalKey: null, pitches: [0], stems: { vocals: '/stems/plb/vocals.mp3', drums: '/stems/plb/drums.mp3' } });
        tx.objectStore('playlists').put({ id: 'pool-pl', title: 'Pool PL', position: 0 });
        tx.objectStore('playlistSongs').put({ playlist_id: 'pool-pl', song_id: 'pool-a', position: 0 });
        tx.objectStore('playlistSongs').put({ playlist_id: 'pool-pl', song_id: 'pool-b', position: 1 });
        tx.oncomplete = () => { db.close(); resolve(); };
      };
    }));
    await page.reload();
    await page.waitForLoadState('networkidle');

    await page.locator('[data-playlist-id="pool-pl"]').click();
    await page.waitForTimeout(200);
    await page.locator('[data-song-id="pool-a"]').click();
    await page.waitForTimeout(600); // first (foreground) load warms the pool

    await setHidden(page, true);
    const before = await page.evaluate(() => window.__mesCalls);

    await page.locator('[data-action="next"]').click();
    await page.waitForTimeout(1500);

    const after = await page.evaluate(() => window.__mesCalls);
    // No MediaElementSource nodes created during the background track change.
    expect(after).toBe(before);
  });
});
