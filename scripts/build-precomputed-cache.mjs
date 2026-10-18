import fs from 'fs';
import path from 'path';
import * as pdfjsLib from 'pdfjs-dist';
import { pipeline } from '@huggingface/transformers';

function chunkDocument(extracted, options = { windowSize: 500, overlap: 100, minThreshold: 60 }) {
  const chunks = [];
  const { windowSize, overlap, minThreshold } = options;
  const step = Math.max(1, windowSize - overlap);

  for (const page of extracted.pages) {
    const text = page.text.trim();
    if (!text) continue;

    let start = 0;
    let chunkIndex = 1;

    while (start < text.length) {
      let end = start + windowSize;
      if (end >= text.length) {
        end = text.length;
      } else {
        const lastPeriod = text.lastIndexOf('.', end);
        const lastNewline = text.lastIndexOf('\n', end);
        const breakPoint = Math.max(lastPeriod, lastNewline);
        if (breakPoint > start + minThreshold) {
          end = breakPoint + 1;
        }
      }

      const rawSlice = text.substring(start, end).trim();
      if (rawSlice.length >= minThreshold) {
        const chunkId = `${extracted.docId}-p${page.pageNumber}-c${chunkIndex}`;
        const prefix = `[Document: ${extracted.docId} - ${extracted.title} | Page: ${page.pageNumber} | Status: ${extracted.status}]\n`;
        chunks.push({
          id: chunkId,
          source: extracted.filename,
          docId: extracted.docId,
          title: extracted.title,
          status: extracted.status,
          page: page.pageNumber,
          text: `${prefix}${rawSlice}`,
        });
        chunkIndex++;
      }

      if (end >= text.length) break;
      start += step;
    }
  }

  return chunks;
}

async function extractTextFromPDF(dataBuffer, metadata) {
  const loadingTask = pdfjsLib.getDocument({
    data: new Uint8Array(dataBuffer),
    useWorkerFetch: false,
    isEvalSupported: false,
    useSystemFonts: true,
  });

  const pdfDocument = await loadingTask.promise;
  const numPages = pdfDocument.numPages;
  const pages = [];
  let totalCharacters = 0;

  for (let i = 1; i <= numPages; i++) {
    const page = await pdfDocument.getPage(i);
    const content = await page.getTextContent();
    const pageStrings = content.items
      .map((item) => ('str' in item ? item.str : ''))
      .join(' ')
      .replace(/\s+/g, ' ');

    pages.push({
      pageNumber: i,
      text: pageStrings,
      characterCount: pageStrings.length,
    });
    totalCharacters += pageStrings.length;
  }

  return {
    ...metadata,
    totalPages: numPages,
    pages,
    totalCharacters,
  };
}

async function main() {
  console.log('Loading manifest...');
  const manifest = JSON.parse(fs.readFileSync('public/corpus/manifest.json', 'utf8'));
  const allChunks = [];

  for (const item of manifest) {
    const pdfPath = path.resolve(`public/corpus/${item.filename}`);
    const buf = fs.readFileSync(pdfPath);
    const doc = await extractTextFromPDF(buf, {
      docId: item.id,
      title: item.title,
      status: item.status,
      filename: item.filename,
    });
    const chunks = chunkDocument(doc);
    allChunks.push(...chunks);
  }

  console.log(`Generated ${allChunks.length} chunks across 21 PDFs.`);
  console.log('Initializing feature-extraction pipeline (Xenova/all-MiniLM-L6-v2)...');
  const extractor = await pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2');

  console.log('Generating embeddings for all chunks in batches...');
  const BATCH_SIZE = 32;
  const serializedRecords = [];

  for (let i = 0; i < allChunks.length; i += BATCH_SIZE) {
    const batch = allChunks.slice(i, i + BATCH_SIZE);
    const texts = batch.map((c) => c.text);
    const output = await extractor(texts, { pooling: 'mean', normalize: true });
    
    // output can be 2D array or Tensor
    for (let j = 0; j < batch.length; j++) {
      const chunk = batch[j];
      const vecSlice = Array.from(output[j].data);
      serializedRecords.push({
        id: chunk.id,
        source: chunk.source,
        docId: chunk.docId,
        title: chunk.title,
        status: chunk.status,
        page: chunk.page,
        text: chunk.text,
        vector: vecSlice,
      });
    }
    console.log(`Embedded ${serializedRecords.length}/${allChunks.length} chunks...`);
  }

  const outPath = 'public/corpus/precomputed-chunks.json';
  fs.writeFileSync(outPath, JSON.stringify(serializedRecords));
  console.log(`Saved ${serializedRecords.length} chunks to ${outPath} (${(fs.statSync(outPath).size / 1024 / 1024).toFixed(2)} MB).`);
}

main().catch(console.error);
