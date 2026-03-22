import { supabase } from "./supabase";

let cachedContext: string | null = null;
let lastFetchTime: number = 0;
const CACHE_TTL = 1000 * 60 * 60; // 1 ora di cache

export async function getDocumentContext(): Promise<string> {
  const TEXT_BUCKET = process.env.SUPABASE_TEXT_BUCKET || 'extracted-text';

  // Usa la cache se valida
  if (cachedContext && (Date.now() - lastFetchTime) < CACHE_TTL) {
    console.log("⚡ Fetching context from memory cache...");
    return cachedContext;
  }

  try {
    const { data: files, error } = await supabase.storage.from(TEXT_BUCKET).list('');
    if (error || !files?.length) {
      console.error("Cannot list text files:", error?.message);
      return "No documents available.";
    }

    const txtFiles = files.filter((f: { name: string }) => f.name.endsWith('.txt'));
    let allText = "";

    console.log("📥 Downloading document context from Supabase...");
    for (const file of txtFiles) {
      const { data, error: dlErr } = await supabase.storage.from(TEXT_BUCKET).download(file.name);
      if (dlErr || !data) { console.error(`Download error ${file.name}:`, dlErr?.message); continue; }
      
      const text = await data.text();
      const docName = file.name.replace('.txt', '.pdf');
      allText += `\n--- Documento: ${docName} ---\n${text}\n`;
    }

    // Salva in cache
    cachedContext = allText;
    lastFetchTime = Date.now();

    console.log(`✅ Loaded complete context: ${allText.length} chars`);
    return allText || "Nessun contenuto estratto dai documenti.";

  } catch (err) {
    console.error("Context load error:", err);
    return "Errore nel caricamento dell'archivio documentale.";
  }
}
