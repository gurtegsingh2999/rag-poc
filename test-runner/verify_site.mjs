import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '..');

const sm3Playwright = path.resolve(REPO_ROOT, '../sm3/node_modules/playwright/index.mjs');
const { chromium } = await import(sm3Playwright);

async function check() {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  
  page.on('console', msg => console.log('PAGE LOG:', msg.text()));
  page.on('pageerror', err => console.log('PAGE ERROR:', err.message));

  console.log('Navigating...');
  await page.goto('https://jpeckenpaugh.github.io/rag-poc/', { waitUntil: 'networkidle' });
  
  console.log('Clicking Load Corpus...');
  const loadBtn = page.getByRole('button', { name: 'Load Corpus' });
  if (await loadBtn.isVisible()) {
    await loadBtn.click();
    console.log('Waiting for corpus ingestion / cache restore...');
    await page.waitForTimeout(4000);
  }

  // Switch to Chat tab
  console.log('Switching to Chat tab...');
  await page.getByRole('button', { name: 'Chat', exact: true }).click();
  await page.waitForTimeout(1000);

  // Check for evaluation select
  const selectEl = page.locator('select');
  console.log('Select count:', await selectEl.count());
  if (await selectEl.count() > 0) {
    const options = await selectEl.first().locator('option').allTextContents();
    console.log('Sample options:', options.slice(0, 5));
    
    // Select Q-001
    console.log('Selecting Q-001...');
    await selectEl.first().selectOption('Q-001');
    await page.waitForTimeout(3000);
    
    // Get chat messages
    const chatText = await page.locator('.space-y-4').first().innerText();
    console.log('Chat output preview:', chatText.slice(0, 300));
  }

  await browser.close();
}

check().catch(console.error);
