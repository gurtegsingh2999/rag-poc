import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '..');

const sm3Playwright = path.resolve(REPO_ROOT, '../sm3/node_modules/playwright/index.mjs');
const { chromium } = await import(sm3Playwright);

async function testCacheInjection() {
  const chunks = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'public/corpus/precomputed-chunks.json'), 'utf8'));
  console.log(`Loaded ${chunks.length} precomputed chunks from disk.`);

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  const page = await context.newPage();

  page.on('console', msg => console.log('PAGE LOG:', msg.text()));

  console.log('Navigating to live page...');
  await page.goto('https://jpeckenpaugh.github.io/rag-poc/', { waitUntil: 'domcontentloaded' });

  console.log('Injecting precomputed chunks into browser IndexedDB...');
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
  }, chunks);

  console.log('Reloading page to trigger instant auto-restore from IndexedDB cache...');
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForTimeout(1000);

  // Check header text or store stats
  const headerText = await page.locator('header').innerText();
  console.log('Header text after reload:', headerText.replace(/\n+/g, ' | '));

  // Check if "Load Cache" or "Rebuild" is present
  const rebuildBtn = page.getByRole('button', { name: 'Rebuild' });
  console.log('Is Rebuild button visible (indicates chunks loaded):', await rebuildBtn.isVisible());

  // Switch to Chat tab
  await page.getByRole('button', { name: 'Chat', exact: true }).click();
  await page.waitForTimeout(500);

  // Select Q-001
  const selectEl = page.locator('select').first();
  await selectEl.selectOption('Q-001');
  console.log('Triggered Q-001...');
  
  // Wait for citation buttons
  await page.waitForSelector('button:has-text("NU-OPS-002")', { timeout: 15000 });
  console.log('Citation button found!');

  const chatContainer = page.locator('.overflow-y-auto').first();
  console.log('Response preview:', (await chatContainer.innerText()).slice(0, 300));

  await browser.close();
  console.log('SUCCESS!');
}

testCacheInjection().catch(console.error);
