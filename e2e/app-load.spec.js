// @ts-check
const { test, expect } = require('@playwright/test');

test.describe('App Load & Initial State', () => {
  test('should load without critical console errors', async ({ page }) => {
    const errors = [];
    page.on('pageerror', e => errors.push(e.message));
    await page.goto('/');
    await page.waitForLoadState('networkidle');
    const critical = errors.filter(e => !e.includes('serviceWorker') && !e.includes('fetch'));
    expect(critical).toHaveLength(0);
  });

  test('should show the header with Showtime title', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('.header h1')).toContainText('Showtime');
  });

  test('should have 5 navigation tabs', async ({ page }) => {
    await page.goto('/');
    const navItems = page.locator('.nav-item');
    await expect(navItems).toHaveCount(5);
  });

  test('should show library view by default', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('#library-view')).toHaveClass(/active/);
  });

  test('should show offline badge when server is unreachable', async ({ page, context }) => {
    // Block ping before navigating. Use context.route (not page.route) so the
    // interception also covers requests made by the service worker — page.route
    // does NOT intercept SW fetches, which let the real ping through.
    await context.route('**/api/ping', route => route.abort());
    await page.goto('/');
    await page.waitForLoadState('domcontentloaded');
    // Wait for initial connectivity check + one interval
    await page.waitForTimeout(18000);
    await expect(page.locator('#offline-badge')).toHaveClass(/visible/);
  });

  test('should register service worker', async ({ page }) => {
    await page.goto('/');
    await page.waitForTimeout(2000);
    const swRegistered = await page.evaluate(() => navigator.serviceWorker?.controller != null || navigator.serviceWorker?.ready != null);
    expect(swRegistered).toBeTruthy();
  });
});
