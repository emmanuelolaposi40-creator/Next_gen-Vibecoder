import fs from 'node:fs';
import path from 'node:path';
import { expect, test } from '@playwright/test';

const SCREENSHOT_DIR = path.resolve(process.cwd(), 'docs/screenshots');

test.describe('Patrol Full-Stack & Visual Verification', () => {
  test('loads world, captures all camera views, missile strike, modal, and passes soak test', async ({
    page,
  }) => {
    fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });

    const errors: string[] = [];
    page.on('pageerror', (err) => errors.push(`PAGEERROR: ${err.message}`));
    page.on('console', (msg) => {
      if (msg.type() === 'error') {
        errors.push(`CONSOLE_ERROR: ${msg.text()}`);
      } else if (msg.type() === 'warning' && msg.text().toLowerCase().includes('webgl')) {
        errors.push(`WEBGL_WARN: ${msg.text()}`);
      }
    });

    await page.goto('/');

    // 1. Verify title card & terrain worker completion
    await expect(page.locator('#title-overlay')).toBeVisible();
    await expect(page.locator('#loader-overlay')).toBeHidden({ timeout: 30_000 });
    await expect(page.locator('#badge-players')).toContainText('IN WING', { timeout: 10_000 });

    // Verify REST API connectivity
    const health = await page.request.get('/api/health');
    expect(health.ok()).toBeTruthy();

    const waitFrames = async (count = 3) => {
      await page.evaluate(
        (n) =>
          new Promise<void>((resolve) => {
            let left = n;
            const tick = () => {
              if (--left <= 0) resolve();
              else requestAnimationFrame(tick);
            };
            requestAnimationFrame(tick);
          }),
        count
      );
    };

    // Launch flight
    await page.click('#btn-launch');
    await expect(page.locator('#title-overlay')).toBeHidden();
    await waitFrames(4);

    // 2. Capture Chase view
    await expect(page.locator('#camera-label')).toHaveText('CHASE');
    await page.screenshot({ path: path.join(SCREENSHOT_DIR, '01-chase.png') });

    // 3. Cycle to Cockpit view -> wait ~1.2s blend + frames -> Capture Cockpit view
    await page.keyboard.press('Space');
    await expect(page.locator('#camera-label')).toHaveText('COCKPIT');
    await page.waitForTimeout(1200);
    await waitFrames(4);
    await page.screenshot({ path: path.join(SCREENSHOT_DIR, '03-cockpit.png') });

    // 4. Cycle to Top-Down view -> wait ~1.2s blend + frames -> Capture Top-Down view
    await page.keyboard.press('Space');
    await expect(page.locator('#camera-label')).toHaveText('TOPDOWN');
    await page.waitForTimeout(1200);
    await waitFrames(4);
    await page.screenshot({ path: path.join(SCREENSHOT_DIR, '02-topdown.png') });

    // 5. Cycle back to Chase view & fire missile salvo for active strike screenshot
    await page.keyboard.press('Space');
    await expect(page.locator('#camera-label')).toHaveText('CHASE');
    await page.waitForTimeout(1200);
    await waitFrames(4);
    await page.mouse.move(640, 440);
    await page.keyboard.press('f');
    await waitFrames(3);
    await page.keyboard.press('f');
    await waitFrames(5);
    await page.screenshot({ path: path.join(SCREENSHOT_DIR, '04-missile-strike.png') });

    // 6. Snap a postcard [P] and open Recon Wall / Seeds Modal
    await page.keyboard.press('p');
    await page.waitForTimeout(500);
    await page.click('#btn-wall');
    await expect(page.locator('#modal-overlay')).toBeVisible();
    await page.waitForTimeout(600);
    await page.screenshot({ path: path.join(SCREENSHOT_DIR, '05-modal-seeds-wall.png') });
    await page.keyboard.press('Escape');
    await expect(page.locator('#modal-overlay')).toBeHidden();

    // 7. Automated Soak Test: rapid steering, camera switches, barrel rolls, afterburner, missiles, postcards
    const soakStart = Date.now();
    let step = 0;
    while (Date.now() - soakStart < 25_000) {
      const mx = 240 + ((step * 173) % 800);
      const my = 160 + ((step * 97) % 400);
      await page.mouse.move(mx, my);

      if (step % 5 === 0) {
        await page.keyboard.press('Space');
      }
      if (step % 7 === 0) {
        // Quick left click -> barrel roll
        await page.mouse.click(mx, my, { button: 'left' });
      }
      if (step % 9 === 0) {
        // Right click -> fire missile
        await page.mouse.click(mx, my, { button: 'right' });
      }
      if (step % 15 === 0) {
        // Afterburner hold burst
        await page.mouse.down({ button: 'left' });
        await page.waitForTimeout(350);
        await page.mouse.up({ button: 'left' });
      }
      if (step % 25 === 0) {
        await page.keyboard.press('p');
      }

      await page.waitForTimeout(180);
      step++;
    }

    expect(errors, `Encountered runtime errors:\n${errors.join('\n')}`).toEqual([]);
  });
});
