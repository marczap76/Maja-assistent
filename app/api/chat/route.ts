import { createOpenAI } from '@ai-sdk/openai';
import { streamText, APICallError } from 'ai';
import { getDocumentContext } from '@/lib/documentContext';

export const maxDuration = 60; // Consenti fino a 60 secondi di esecuzione su Vercel


const openrouter = createOpenAI({
  baseURL: 'https://openrouter.ai/api/v1',
  apiKey: process.env.OPENROUTER_API_KEY,
});

// Multi-model fallback — primary model first
const MODELS = [
  "stepfun/step-3.5-flash:free",
  "meta-llama/llama-3.3-70b-instruct:free",
  "nvidia/nemotron-3-super-120b-a12b:free",
];

function buildSystemPrompt(context: string): string {
  return `
Sei l'assistente ufficiale di "Le Cronache di Maja", un gioco dal vivo fantasy (LARP).
Il tuo compito è rispondere alle domande in modo discorsivo usando ESCLUSIVAMENTE le informazioni contenute nei documenti qui sotto.

--- REGOLE OBBLIGATORIE ---
1. **Sintesi e Brevità**: Sii estremamente sintetico, diretto e vai subito al punto. Evita introduzioni prolisse (es. "Certamente!", "Ecco le informazioni...") o conclusioni ripetitive. Riassumi le informazioni in modo chiaro e asciutto.
2. **Nessuna conoscenza esterna**: Non usare informazioni dal tuo training data. Se non è nei documenti, non esiste.
3. **NESSUNA CITAZIONE**: Fornisci direttamente le risposte senza menzionare il nome del file o la fonte documentale. Mantieni un tono amichevole, diretto e immersivo nel mondo di gioco.
4. **Riconosci le lacune**: Se una risposta non è nei documenti, dichiara chiaramente: "Questa informazione non è presente nei documenti forniti." NON indovinare.
5. **Creazione personaggi**: Se l'utente chiede di creare un personaggio, guidalo rigorosamente seguendo le regole spiegate nei documenti.
6. **Equipaggiamento e Regole**: Rispondi precisamente citando le regole di campo, sicurezza ed equipaggiamento presenti nei documenti.

--- DOCUMENTI UFFICIALI (CONTESTO) ---
${context}
--- FINE DOCUMENTI ---

Rispondi in italiano. Usa il **grassetto** per i termini chiave. Usa markdown strutturato per output complessi.
  `.trim();
}

export async function POST(req: Request) {
  try {
    const { messages } = await req.json();
    let context = await getDocumentContext();

    // Truncate if too long (OpenRouter can handle large contexts, but just for safety)
    if (context.length > 500000) {
      context = context.substring(0, 500000) + "\n... [Contenuto troncato]";
    }

    const systemPrompt = buildSystemPrompt(context);

    // Try each model with fallback logic
    for (const modelId of MODELS) {
      try {
        const result = streamText({
          model: openrouter(modelId),
          system: systemPrompt,
          messages,
          // Extra headers per le policy di OpenRouter
          headers: {
            "HTTP-Referer": "https://maja-assistent.vercel.app",
            "X-Title": "Maja-assistent"
          }
        });

        // Avvia lo streaming e ritorna la risposta (Data Stream protocollo Vercel)
        return result.toDataStreamResponse({
          headers: {
            "Cache-Control": "no-cache"
          }
        });
      } catch (err) {
        // Se c'è un errore API (es. rate limit), prova il modello successivo
        if (APICallError.isInstance(err) && (err.statusCode === 429 || err.statusCode === 503 || err.statusCode === 502)) {
          console.warn(`Modello ${modelId} non disponibile. Tento il fallback...`);
          await new Promise(r => setTimeout(r, 1000));
          continue;
        }
        throw err;
      }
    }

    return new Response(
      "Tutti i modelli AI sono temporaneamente sovraccarichi. Riprova tra un momento.",
      { status: 503 }
    );

  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("Chat API Error:", msg);
    return new Response(`Errore di connessione: ${msg}`, { status: 500 });
  }
}
