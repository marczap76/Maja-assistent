/**
 * extract-docs.mjs
 * 
 * Script per estrarre testo dai PDF nel bucket Supabase 'source-docs'
 * e caricare i file .txt risultanti nel bucket 'extracted-text'.
 * 
 * Eseguire con: node extract-docs.mjs
 * 
 * IMPORTANTE: Configura le variabili SUPABASE_URL e SERVICE_ROLE_KEY
 * prima di eseguire.
 */

import { createClient } from '@supabase/supabase-js';
import { extractText } from 'unpdf';
import { readFileSync } from 'fs';

// --- CARICAMENTO .env.local ---
try {
  const envContent = readFileSync('.env.local', 'utf-8');
  for (const line of envContent.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIndex = trimmed.indexOf('=');
    if (eqIndex > 0) {
      const key = trimmed.substring(0, eqIndex).trim();
      const value = trimmed.substring(eqIndex + 1).trim();
      process.env[key] = value;
    }
  }
} catch (e) {
  console.log('⚠️  .env.local non trovato, uso variabili d\'ambiente di sistema');
}

// --- CONFIGURAZIONE ---
const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const SOURCE_BUCKET = 'Documenti di riferimento';
const TEXT_BUCKET = 'extracted-text';

const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

async function main() {
  console.log('🔄 Inizio estrazione documenti...\n');

  // Crea il bucket di testo se non esiste
  const { error: bucketError } = await supabase.storage.createBucket(TEXT_BUCKET, { public: false });
  if (bucketError && !bucketError.message.includes('already exists')) {
    console.error('❌ Errore creazione bucket:', bucketError.message);
    return;
  }

  // Lista file nel bucket sorgente
  console.log(`📂 Bucket sorgente: "${SOURCE_BUCKET}"`);
  const { data: files, error: listError } = await supabase.storage.from(SOURCE_BUCKET).list('', {
    limit: 100,
    sortBy: { column: 'name', order: 'asc' }
  });
  if (listError) {
    console.error('❌ Errore lista file:', listError.message);
    return;
  }

  console.log(`📋 File trovati nel bucket:`, files?.map(f => f.name));

  if (!files || files.length === 0) {
    console.log(`⚠️  Nessun file trovato nel bucket "${SOURCE_BUCKET}". Carica i PDF dalla dashboard Supabase.`);
    return;
  }

  const pdfFiles = files.filter(f => f.name.endsWith('.pdf'));
  console.log(`📄 Trovati ${pdfFiles.length} file PDF da elaborare.\n`);

  for (const file of pdfFiles) {
    try {
      console.log(`📥 Scaricamento: ${file.name}...`);
      const { data: blob, error: dlError } = await supabase.storage.from(SOURCE_BUCKET).download(file.name);
      if (dlError || !blob) {
        console.error(`  ❌ Errore download ${file.name}:`, dlError?.message);
        continue;
      }

      console.log(`🔍 Estrazione testo...`);
      const buffer = await blob.arrayBuffer();
      const { text } = await extractText(new Uint8Array(buffer), { mergePages: true });

      // Pulizia whitespace
      const cleaned = text
        .split('\n')
        .map(l => l.trim())
        .filter(l => l.length > 0)
        .join('\n');

      const txtName = file.name.replace('.pdf', '.txt');
      const txtBlob = new Blob([cleaned], { type: 'text/plain' });

      const { error: uploadError } = await supabase.storage
        .from(TEXT_BUCKET)
        .upload(txtName, txtBlob, { upsert: true });

      if (uploadError) {
        console.error(`  ❌ Errore upload ${txtName}:`, uploadError.message);
        continue;
      }

      console.log(`  ✅ Estratto: ${txtName} (${cleaned.length} caratteri)\n`);
    } catch (err) {
      console.error(`  ❌ Errore elaborazione ${file.name}:`, err);
    }
  }

  console.log('🎉 Estrazione completata!');
}

main().catch(console.error);
