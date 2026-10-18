import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { spawn } from 'child_process';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '..');
const DEMOS_DIR = path.join(REPO_ROOT, 'demos/latest');
const GALLERY_DIR = path.join(DEMOS_DIR, 'gallery');

const sm3Playwright = path.resolve(REPO_ROOT, '../sm3/node_modules/playwright/index.mjs');
const { chromium } = await import(sm3Playwright);

// 1. Cursor simulation helper
async function injectCursor(page) {
  await page.evaluate(() => {
    if (document.getElementById('demo-cursor')) return;
    const c = document.createElement('div');
    c.id = 'demo-cursor';
    c.style.position = 'fixed';
    c.style.top = '0';
    c.style.left = '0';
    c.style.width = '18px';
    c.style.height = '18px';
    c.style.borderRadius = '50%';
    c.style.backgroundColor = 'rgba(99, 102, 241, 0.85)';
    c.style.border = '2px solid #ffffff';
    c.style.boxShadow = '0 0 14px rgba(99, 102, 241, 0.95)';
    c.style.pointerEvents = 'none';
    c.style.zIndex = '9999999';
    c.style.transform = 'translate(-50%, -50%)';
    c.style.transition = 'width 0.12s ease, height 0.12s ease, background-color 0.12s ease';
    document.body.appendChild(c);
    window.__setCursor = (x, y) => {
      c.style.left = `${x}px`;
      c.style.top = `${y}px`;
    };
  });
}

async function smoothMove(page, targetX, targetY, steps = 16, delayMs = 15) {
  await page.mouse.move(targetX, targetY, { steps });
  await page.evaluate(({ x, y }) => window.__setCursor?.(x, y), { x: targetX, y: targetY });
  if (delayMs > 0) await page.waitForTimeout(delayMs);
}

async function smoothClick(page, target, steps = 14) {
  let box;
  if (typeof target === 'string') {
    box = await page.locator(target).first().boundingBox();
  } else if (target && typeof target.boundingBox === 'function') {
    box = await target.boundingBox();
  } else if (target && typeof target.x === 'number') {
    box = target;
  }
  if (!box) {
    console.warn(`[smoothClick] Warning: target element bounding box was null for:`, target);
    return;
  }
  const targetX = box.x + box.width / 2;
  const targetY = box.y + box.height / 2;
  await smoothMove(page, targetX, targetY, steps);
  await page.evaluate(() => {
    const c = document.getElementById('demo-cursor');
    if (c) {
      c.style.width = '13px';
      c.style.height = '13px';
      c.style.backgroundColor = 'rgba(239, 68, 68, 0.95)';
    }
  });
  await page.waitForTimeout(100);
  await page.mouse.click(targetX, targetY);
  await page.evaluate(() => {
    const c = document.getElementById('demo-cursor');
    if (c) {
      c.style.width = '18px';
      c.style.height = '18px';
      c.style.backgroundColor = 'rgba(99, 102, 241, 0.85)';
    }
  });
  await page.waitForTimeout(200);
}

async function generateWebPThumbnail(browser, sourcePngPath, outWebPPath) {
  console.log(`[Thumbnail] Generating WebP from ${sourcePngPath}...`);
  const page = await browser.newPage();
  const pngDataUrl = `data:image/png;base64,${fs.readFileSync(sourcePngPath).toString('base64')}`;

  const webpBase64 = await page.evaluate(async (dataUrl) => {
    return new Promise((resolve) => {
      const img = new Image();
      img.onload = () => {
        const canvas = document.createElement('canvas');
        canvas.width = 640;
        canvas.height = 384;
        const ctx = canvas.getContext('2d');
        ctx.imageSmoothingEnabled = true;
        ctx.imageSmoothingQuality = 'high';
        ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
        const webpData = canvas.toDataURL('image/webp', 0.88);
        resolve(webpData.split(',')[1]);
      };
      img.src = dataUrl;
    });
  }, pngDataUrl);

  fs.writeFileSync(outWebPPath, Buffer.from(webpBase64, 'base64'));
  await page.close();
  console.log(`[Thumbnail] Saved WebP (${fs.statSync(outWebPPath).size} bytes) to ${outWebPPath}`);
}

async function main() {
  fs.mkdirSync(GALLERY_DIR, { recursive: true });

  const precomputedChunks = JSON.parse(
    fs.readFileSync(path.join(REPO_ROOT, 'public/corpus/precomputed-chunks.json'), 'utf8')
  );
  console.log(`[Setup] Loaded ${precomputedChunks.length} precomputed chunks for in-browser vector index.`);

  console.log('[Playwright] Launching Chromium 1280x720 video recording...');
  const browser = await chromium.launch({ headless: true });

  const tempVideoDir = path.join(DEMOS_DIR, '__temp_video');
  fs.mkdirSync(tempVideoDir, { recursive: true });

  const context = await browser.newContext({
    viewport: { width: 1280, height: 720 },
    recordVideo: {
      dir: tempVideoDir,
      size: { width: 1280, height: 720 },
    },
  });

  const page = await context.newPage();
  const startTime = Date.now();

  try {
    console.log('[Recording] Navigating to https://jpeckenpaugh.github.io/rag-poc/ ...');
    await page.goto('https://jpeckenpaugh.github.io/rag-poc/', { waitUntil: 'domcontentloaded' });

    // Seed IndexedDB cache and localStorage
    console.log('[Setup] Seeding browser IndexedDB cache & metadata...');
    await page.evaluate(async (chunkList) => {
      const DB_NAME = 'northstar_rag_db';
      const STORE_NAME = 'corpus_chunks';
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = (e) => {
        const db = e.target.result;
        if (!db.objectStoreNames.contains(STORE_NAME)) {
          db.createObjectStore(STORE_NAME, { keyPath: 'id' });
        }
      };
      await new Promise((resolve, reject) => {
        req.onsuccess = (e) => {
          const db = e.target.result;
          const tx = db.transaction(STORE_NAME, 'readwrite');
          const store = tx.objectStore(STORE_NAME);
          store.clear();
          for (const c of chunkList) store.put(c);
          tx.oncomplete = resolve;
          tx.onerror = reject;
        };
        req.onerror = reject;
      });

      localStorage.setItem('corpus_cache_meta', JSON.stringify({
        savedAt: Date.now(),
        chunkCount: chunkList.length,
        documentCount: 21,
        model: 'Xenova/all-MiniLM-L6-v2',
        windowSize: 500,
        overlap: 100,
      }));
    }, precomputedChunks);

    // Reload with seeded cache
    await page.reload({ waitUntil: 'networkidle' });
    await injectCursor(page);
    await page.evaluate(() => window.__setCursor?.(640, 360));
    await page.waitForTimeout(600);

    // -------------------------------------------------------------------
    // Beat 1: Architecture Hero & In-Memory Corpus Ingestion (0.0s - 4.5s)
    // -------------------------------------------------------------------
    console.log('[1/6] Capturing Zero-Backend Architecture Overview...');
    await smoothMove(page, 480, 240, 15);
    await page.waitForTimeout(800);

    // Hover over client-side technical specs
    await smoothMove(page, 720, 290, 15);
    await page.waitForTimeout(600);

    const still1 = path.join(GALLERY_DIR, '01-architecture-overview.png');
    await page.screenshot({ path: still1 });
    console.log(`  -> Saved ${path.basename(still1)}`);

    // -------------------------------------------------------------------
    // Beat 2: Benchmark Evaluation Query & Streaming Citations (4.5s - 11.5s)
    // -------------------------------------------------------------------
    console.log('[2/6] Navigating to Chat & Running Benchmark Query Q-001...');
    // Click "Chat" tab in header
    await smoothClick(page, page.getByRole('button', { name: 'Chat', exact: true }));
    await page.waitForTimeout(600);

    // Move to Benchmark dropdown
    await smoothMove(page, 460, 88, 14);
    await page.waitForTimeout(300);

    // Select Q-001
    const selectEl = page.locator('select').first();
    await selectEl.selectOption('Q-001');
    await page.waitForTimeout(800);

    // Wait for citation buttons to render
    await page.waitForSelector('button:has-text("NU-OPS-002")', { timeout: 10000 });
    await page.waitForTimeout(1000);

    // Move cursor over grounded citation badge
    const citationBtn = page.locator('button:has-text("NU-OPS-002")').first();
    const citeBox = await citationBtn.boundingBox();
    if (citeBox) {
      await smoothMove(page, citeBox.x + citeBox.width / 2, citeBox.y + citeBox.height / 2, 14);
    }
    await page.waitForTimeout(800);

    const still2 = path.join(GALLERY_DIR, '02-evaluation-benchmark-chat.png');
    await page.screenshot({ path: still2 });
    console.log(`  -> Saved ${path.basename(still2)}`);

    // -------------------------------------------------------------------
    // Beat 3: DevTools Vector Retrieval & Similarity Ranking (11.5s - 17.5s)
    // -------------------------------------------------------------------
    console.log('[3/6] Opening DevTools Drawer & Inspecting 384-Dim Query Embedding...');
    // Click DevTools button in header
    await smoothClick(page, page.getByRole('button', { name: 'DevTools', exact: true }));
    await page.waitForTimeout(700);

    // Click Tab 2 (Retrieval / Vectors) in drawer
    const vectorsTab = page.locator('aside button:has-text("Retrieval"), aside button:has-text("Vectors")').first();
    if (await vectorsTab.isVisible()) {
      await smoothClick(page, vectorsTab);
      await page.waitForTimeout(700);
    }

    // Move cursor over similarity percentage badge
    const simBadge = page.locator('span:has-text("dot =")').first();
    if (await simBadge.isVisible()) {
      const simBox = await simBadge.boundingBox();
      if (simBox) {
        await smoothMove(page, simBox.x + simBox.width / 2, simBox.y + simBox.height / 2, 12);
      }
    }
    await page.waitForTimeout(600);

    const still3 = path.join(GALLERY_DIR, '03-devtools-vector-retrieval.png');
    await page.screenshot({ path: still3 });
    console.log(`  -> Saved ${path.basename(still3)}`);

    // Open Settings Modal briefly to show similarity threshold & topK sliders
    await smoothClick(page, page.getByRole('button', { name: 'Settings', exact: true }));
    await page.waitForTimeout(800);
    // Move over similarity threshold slider
    const slider = page.locator('input[type="range"]').nth(3);
    if (await slider.isVisible()) {
      const sBox = await slider.boundingBox();
      if (sBox) {
        await smoothMove(page, sBox.x + sBox.width / 2, sBox.y + sBox.height / 2, 10);
      }
    }
    await page.waitForTimeout(500);
    // Close settings modal using Escape
    await page.keyboard.press('Escape');
    await page.waitForTimeout(500);

    // -------------------------------------------------------------------
    // Beat 4: Chunk Metadata Inspector & Integrated PDF Viewer (17.5s - 23.5s)
    // -------------------------------------------------------------------
    console.log('[4/6] Inspecting Chunk Modal & Switching to PDF Viewer...');
    // Click ranked candidate card in DevTools
    const chunkCard = page.locator('aside div:has-text("NU-OPS-002")').first();
    if (await chunkCard.isVisible()) {
      await smoothClick(page, chunkCard);
      await page.waitForTimeout(800);
    } else {
      // fallback to clicking citation badge
      await smoothClick(page, citationBtn);
      await page.waitForTimeout(800);
    }

    const still4 = path.join(GALLERY_DIR, '04-chunk-modal-inspector.png');
    await page.screenshot({ path: still4 });
    console.log(`  -> Saved ${path.basename(still4)}`);

    // Click "View in PDF Document Viewer" from ChunkModal
    const openInPdfBtn = page.locator('button:has-text("View in PDF Document Viewer")').first();
    if (await openInPdfBtn.isVisible()) {
      await smoothClick(page, openInPdfBtn);
    } else {
      await page.keyboard.press('Escape');
      await page.waitForTimeout(300);
      await smoothClick(page, page.getByRole('button', { name: 'PDFs', exact: true }));
    }
    await page.waitForTimeout(1400);

    // Zoom or pan PDF canvas
    await smoothMove(page, 450, 420, 16);
    await page.waitForTimeout(700);

    const still5 = path.join(GALLERY_DIR, '05-pdf-canvas-corpus-viewer.png');
    await page.screenshot({ path: still5 });
    console.log(`  -> Saved ${path.basename(still5)}`);

    // -------------------------------------------------------------------
    // Beat 5: Guardrail Negative Test & Strict Abstention (23.5s - 30.5s)
    // -------------------------------------------------------------------
    console.log('[5/6] Navigating Back to Chat & Submitting Negative Query Q-011...');
    // Click Chat button in header
    await smoothClick(page, page.getByRole('button', { name: 'Chat', exact: true }));
    await page.waitForTimeout(800);

    // Wait for the Benchmark select to be available
    await page.waitForSelector('select', { timeout: 10000 });
    const chatSelect = page.locator('select').first();
    await smoothClick(page, chatSelect);
    await chatSelect.selectOption('Q-011');
    await page.waitForTimeout(1400);

    // Position cursor over the Guardrail abstention alert
    const guardrailBanner = page.locator('text=Guardrail Triggered').first();
    if (await guardrailBanner.isVisible()) {
      const gBox = await guardrailBanner.boundingBox();
      if (gBox) {
        await smoothMove(page, gBox.x + gBox.width / 2, gBox.y + gBox.height / 2, 14);
      }
    }
    await page.waitForTimeout(1000);

    const still6 = path.join(GALLERY_DIR, '06-guardrail-abstention-refusal.png');
    await page.screenshot({ path: still6 });
    console.log(`  -> Saved ${path.basename(still6)}`);

    // Hold final steady state to hit exactly ~30.5 seconds
    const elapsedMs = Date.now() - startTime;
    const remainingMs = 30500 - elapsedMs;
    if (remainingMs > 0) {
      console.log(`[Hold] Holding final steady state for ${(remainingMs / 1000).toFixed(1)}s to complete 30.5s recording...`);
      await page.waitForTimeout(remainingMs);
    }
  } catch (err) {
    console.error('[Error during recording]', err);
    throw err;
  } finally {
    const videoObj = page.video();
    await context.close();
    await browser.close();

    const rawVideoPath = await videoObj.path();
    console.log(`[Video] Raw recording saved at: ${rawVideoPath}`);

    const finalWebM = path.join(DEMOS_DIR, 'demo.webm');
    const ffmpegMac = path.resolve(process.env.HOME, 'Library/Caches/ms-playwright/ffmpeg-1013/ffmpeg-mac');

    if (fs.existsSync(ffmpegMac)) {
      console.log(`[FFmpeg] Transcoding video with VP9 to exact 30.5s duration...`);
      await new Promise((resolve, reject) => {
        const proc = spawn(ffmpegMac, [
          '-y',
          '-i', rawVideoPath,
          '-t', '30.5',
          '-c:v', 'libvpx-vp9',
          '-b:v', '750k',
          '-crf', '32',
          '-an',
          finalWebM
        ], { stdio: 'inherit' });
        proc.on('close', (code) => {
          if (code === 0) resolve();
          else reject(new Error(`FFmpeg exited with code ${code}`));
        });
      });
    } else {
      console.log(`[Video] Moving raw WebM to ${finalWebM}...`);
      fs.copyFileSync(rawVideoPath, finalWebM);
    }

    try {
      fs.rmSync(tempVideoDir, { recursive: true, force: true });
    } catch (_) {}

    // Generate Card Thumbnail WebP
    const helperBrowser = await chromium.launch({ headless: true });
    try {
      const sourceStill = path.join(GALLERY_DIR, '03-devtools-vector-retrieval.png');
      const cardThumbWebP = path.join(DEMOS_DIR, 'thumb.webp');
      await generateWebPThumbnail(helperBrowser, sourceStill, cardThumbWebP);

      const netfixThumb = path.resolve(REPO_ROOT, '../thumbnails/rag-poc.webp');
      const betaThumb = path.resolve(REPO_ROOT, '../beta-livive-net/thumbnails/rag-poc.webp');
      const liviveThumb = path.resolve(REPO_ROOT, '../livive-net/thumbnails/rag-poc.webp');

      for (const tPath of [netfixThumb, betaThumb, liviveThumb]) {
        if (fs.existsSync(path.dirname(tPath))) {
          fs.copyFileSync(cardThumbWebP, tPath);
          console.log(`[Thumbnail] Copied to ${tPath}`);
        }
      }
    } finally {
      await helperBrowser.close();
    }

    console.log('\n======================================================');
    console.log('SUCCESS: All Northstar RAG POC showcase assets captured!');
    console.log(`  - Video: ${finalWebM} (${(fs.statSync(finalWebM).size / 1024 / 1024).toFixed(2)} MB)`);
    for (const f of fs.readdirSync(GALLERY_DIR).sort()) {
      const p = path.join(GALLERY_DIR, f);
      console.log(`  - Gallery: ${f} (${(fs.statSync(p).size / 1024).toFixed(1)} KB)`);
    }
    console.log('======================================================\n');
  }
}

main().catch((err) => {
  console.error('[FATAL]', err);
  process.exit(1);
});
