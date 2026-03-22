---
name: RAG Chatbot PWA
description: Build a document-grounded AI chatbot Progressive Web App (PWA) using Next.js, Supabase Storage, and OpenRouter. The AI answers strictly from uploaded documents (PDF/TXT). Covers architecture, document pre-processing, strict RAG prompt engineering, serverless deployment, and UI patterns.
---

# RAG Chatbot PWA — Build Skill

## What This Builds

A **mobile-first Progressive Web App** where users chat with an AI that answers **exclusively from documents you provide** (PDF manuals, rulebooks, knowledge bases, etc.). No hallucinations — if the answer isn't in the documents, the AI says so.

**Tech stack:**
- **Frontend**: Next.js (App Router) + Tailwind CSS + Framer Motion — deployed to Vercel
- **Storage**: Supabase Storage (holds the source documents + pre-extracted text)
- **AI**: OpenRouter API (multi-model fallback — free tier compatible)
- **PWA**: `next-pwa` for offline support and home screen installation

---

## Architecture Overview

```
User → Next.js Frontend (Vercel)
         ↓ POST /api/chat
       API Route (Node.js Serverless)
         ↓ 1. Fetch pre-extracted .txt files from Supabase Storage
         ↓ 2. Build system prompt with document context
         ↓ 3. Call OpenRouter (tries multiple models in order)
         ↓ 4. Return structured response
       Frontend renders markdown response with citations
```

---

## Step 1: Project Setup

```bash
npx create-next-app@latest ./ --typescript --tailwind --app --no-src-dir --import-alias "@/*"
npm install @supabase/supabase-js framer-motion lucide-react react-markdown next-pwa unpdf
```

### Required Environment Variables (`.env.local`)
```env
NEXT_PUBLIC_SUPABASE_URL=https://your-project.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=your-anon-key
SUPABASE_SERVICE_ROLE_KEY=your-service-role-key
SUPABASE_TEXT_BUCKET=your-text-bucket-name
OPENROUTER_API_KEY=sk-or-v1-...
```

> **Never commit `.env.local`** — add it to `.gitignore` immediately.

---

## Step 2: Supabase Setup

### 2a. Create two Storage Buckets
- **`source-docs`** (private): upload original PDF/TXT files here manually from the Supabase dashboard
- **`extracted-text`** (private): this is where pre-processed `.txt` files will be stored (populated by the script in Step 3)

### 2b. Supabase Client (`lib/supabase.ts`)
```typescript
import { createClient } from "@supabase/supabase-js";

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY 
  || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;

export const supabase = createClient(supabaseUrl, supabaseKey);
```

> Use the **Service Role Key** on the server side to bypass RLS for document reading. Never expose it to the client.

---

## Step 3: Document Pre-Processing (CRITICAL)

> ⚠️ **Do NOT parse PDFs at runtime** in serverless functions. It causes timeouts and errors.

### Why pre-processing is required
- Vercel Hobby plan: **10 second function timeout**
- Downloading + parsing large PDFs (~2MB) per request = guaranteed timeout
- `pdf-parse` library also **fails silently** on serverless (tries to access local filesystem test files)

### The correct approach: pre-extract once, store as .txt

**Use `unpdf`** — the only PDF library designed for serverless/edge environments.

**One-time extraction script** (`extract-docs.mjs`):
```javascript
import { createClient } from '@supabase/supabase-js';
import { extractText } from 'unpdf';

const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);
const SOURCE_BUCKET = 'source-docs';
const TEXT_BUCKET = 'extracted-text';

// Create the text bucket if it doesn't exist
await supabase.storage.createBucket(TEXT_BUCKET, { public: false });

const { data: files } = await supabase.storage.from(SOURCE_BUCKET).list('');

for (const file of files.filter(f => f.name.endsWith('.pdf'))) {
  const { data: blob } = await supabase.storage.from(SOURCE_BUCKET).download(file.name);
  const buffer = await blob.arrayBuffer();
  const { text } = await extractText(new Uint8Array(buffer), { mergePages: true });
  
  // Clean whitespace
  const cleaned = text.split('\n').map(l => l.trim()).filter(l => l.length > 0).join('\n');
  
  const txtName = file.name.replace('.pdf', '.txt');
  const txtBlob = new Blob([cleaned], { type: 'text/plain' });
  await supabase.storage.from(TEXT_BUCKET).upload(txtName, txtBlob, { upsert: true });
  console.log(`✅ Extracted: ${txtName} (${cleaned.length} chars)`);
}
```

Run with: `node extract-docs.mjs`

> **Re-run this script whenever you add or update documents in `source-docs`.**

---

## Step 4: Document Context Loader (`lib/documentContext.ts`)

```typescript
import { supabase } from "./supabase";

export async function getDocumentContext(): Promise<string> {
  const TEXT_BUCKET = process.env.SUPABASE_TEXT_BUCKET || 'extracted-text';

  try {
    const { data: files, error } = await supabase.storage.from(TEXT_BUCKET).list('');
    if (error || !files?.length) {
      console.error("Cannot list text files:", error?.message);
      return "No documents available.";
    }

    const txtFiles = files.filter(f => f.name.endsWith('.txt'));
    let allText = "";

    for (const file of txtFiles) {
      const { data, error: dlErr } = await supabase.storage.from(TEXT_BUCKET).download(file.name);
      if (dlErr || !data) { console.error(`Download error ${file.name}:`, dlErr?.message); continue; }
      
      const text = await data.text();
      const docName = file.name.replace('.txt', '.pdf'); // for citation display
      allText += `\n--- Document: ${docName} ---\n${text}\n`;
      console.log(`Loaded: ${file.name} (${text.length} chars)`);
    }

    console.log(`Total context: ${allText.length} chars`);
    return allText || "No content extracted from documents.";

  } catch (err) {
    console.error("Context load error:", err);
    return "Error loading document archive.";
  }
}
```

---

## Step 5: Chat API Route (`app/api/chat/route.ts`)

```typescript
import { NextResponse } from "next/server";
import { getDocumentContext } from "@/lib/documentContext";

const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;

// Multi-model fallback list — put fastest/cheapest first
const MODELS = [
  "google/gemini-flash-1.5",
  "meta-llama/llama-3.3-70b-instruct:free",
  "qwen/qwen3-235b-a22b:free",
];

export async function POST(req: Request) {
  try {
    const { messages } = await req.json();
    let context = await getDocumentContext();

    // Truncate if too long (model context window limits)
    if (context.length > 500000) {
      context = context.substring(0, 500000) + "\n... [Content truncated]";
    }

    const systemPrompt = buildSystemPrompt(context);
    const apiMessages = [
      { role: "system", content: systemPrompt },
      ...messages.map((m: { role: string; content: string }) => ({
        role: m.role, content: m.content
      }))
    ];

    // Try each model with fallback on rate limiting
    for (const model of MODELS) {
      const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${OPENROUTER_API_KEY}`,
          "Content-Type": "application/json",
          "HTTP-Referer": "https://your-app.vercel.app", // update this
          "X-Title": "Your App Name"
        },
        body: JSON.stringify({ model, messages: apiMessages }),
      });

      const data = await res.json();

      if (res.ok) {
        return NextResponse.json({
          role: "assistant",
          content: data.choices[0].message.content,
          reply: data.choices[0].message.content,
        });
      }

      if (res.status === 429) {
        await new Promise(r => setTimeout(r, 2000));
        continue;
      }

      console.error(`Model ${model} failed (${res.status}):`, data.error?.message);
    }

    return NextResponse.json(
      { reply: "All AI models are temporarily overloaded. Please retry in a moment." },
      { status: 503 }
    );

  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ reply: `Connection error: ${msg}` }, { status: 500 });
  }
}
```

### Strict RAG System Prompt Pattern
```typescript
function buildSystemPrompt(context: string): string {
  return `
You are the official assistant for [YOUR APP/KNOWLEDGE BASE NAME].
Your task is to answer questions using EXCLUSIVELY the information in the documents below.

--- MANDATORY RULES ---
1. **No external knowledge**: Do not use information from your training data. If it's not in the documents, it does not exist.
2. **Cite sources accurately**: Use the EXACT filename shown after "--- Document: " markers. Never fabricate document names.
3. **Acknowledge gaps**: If an answer is not in the documents, clearly state: "This information is not present in the provided documents." Do NOT guess.
4. **Mandatory citations**: Every key statement must include the source filename (e.g., "... (source: manual-v2.pdf)").

[ADD DOMAIN-SPECIFIC INSTRUCTIONS HERE — e.g., character creation, recipe generation, FAQ handling]

--- OFFICIAL DOCUMENTS (CONTEXT) ---
${context}
--- END DOCUMENTS ---

Respond in [LANGUAGE]. Use **bold** for key terms. Use structured markdown for complex outputs.
  `.trim();
}
```

---

## Step 6: Chat UI with Stop Button (`components/ChatInterface.tsx`)

Key patterns:
```typescript
// AbortController for cancellable requests
const abortControllerRef = useRef<AbortController | null>(null);

// Cancel the in-flight request
const handleStop = () => {
  abortControllerRef.current?.abort();
  abortControllerRef.current = null;
  setIsLoading(false);
  // Append a cancellation message to the chat
};

// In fetch call, pass the signal
const controller = new AbortController();
abortControllerRef.current = controller;
const response = await fetch("/api/chat", {
  ...options,
  signal: controller.signal,
});

// Detect abort vs real error
} catch (err) {
  if (err instanceof Error && err.name === "AbortError") return;
  // Handle real error
}
```

**UI pattern: Button transforms during loading**
```tsx
{isLoading ? (
  <button onClick={handleStop} className="... bg-red-600 animate-pulse">
    <Square className="w-5 h-5 fill-white" /> {/* lucide-react */}
  </button>
) : (
  <button type="submit" disabled={!input.trim()}>
    <Send className="w-5 h-5" />
  </button>
)}
```

---

## Step 7: PWA Configuration (`next.config.ts`)

```typescript
import withPWA from "next-pwa";

const pwaConfig = withPWA({
  dest: "public",
  register: true,
  skipWaiting: true,
  disable: process.env.NODE_ENV === "development",
});

export default pwaConfig({
  // your next config
});
```

**Required files in `/public/`:**
- `manifest.json` — name, icons, theme_color, background_color, display: "standalone"
- `icon-192.png`, `icon-512.png` — app icons (use sharp or squoosh to generate)

---

## Step 8: Deployment (Vercel)

### 8a. Push to GitHub
```bash
git init
git add .
git commit -m "Initial commit"
git remote add origin https://github.com/your-user/your-repo.git
git push -u origin main
```

### 8b. Connect to Vercel
1. Go to [vercel.com](https://vercel.com) → Import from GitHub
2. Add all env variables from `.env.local` in **Settings → Environment Variables**
3. Deploy

### 8c. Make it public
Vercel Hobby adds authentication by default for previews.
Go to **Project Settings → Deployment Protection → disable "Vercel Authentication"**

### 8d. Install on mobile
- **iOS**: Open in Safari → Share → "Add to Home Screen"
- **Android**: Open in Chrome → three dots menu → "Install App"

---

## Common Pitfalls & Fixes

| Problem | Cause | Fix |
|---|---|---|
| AI says "context is empty" | PDF parsing fails silently on serverless | Pre-extract PDFs to .txt (Step 3) |
| Request hangs / times out | PDF download+parse exceeds 10s Vercel timeout | Use pre-extracted .txt files |
| `pdf-parse` crashes on Vercel | Accesses local filesystem test files | Replace with `unpdf` |
| AI invents document names | System prompt not strict enough | Use exact filenames from document markers |
| App asks for Vercel login | Deployment protection enabled | Disable in Vercel project settings |
| Build fails with TypeScript errors | Implicit `any` types in array callbacks | Add explicit types: `.map((line: string) => ...)` |
| OpenRouter 429 errors | Rate limiting on free model tier | Implement multi-model fallback list |

---

## Checklist

- [ ] Create Next.js project with TypeScript + Tailwind
- [ ] Set up Supabase: two storage buckets (source + text)
- [ ] Add all env vars to `.env.local` (and to `.gitignore`)
- [ ] Upload source documents to Supabase Storage manually
- [ ] Run `extract-docs.mjs` to pre-process documents to `.txt`
- [ ] Implement `lib/documentContext.ts` (reads from text bucket)
- [ ] Implement `app/api/chat/route.ts` with strict RAG prompt + multi-model fallback
- [ ] Build `ChatInterface.tsx` with AbortController stop button
- [ ] Configure `next-pwa` + `manifest.json` + icons
- [ ] Push to GitHub → deploy to Vercel
- [ ] Add env vars to Vercel dashboard
- [ ] Disable Vercel authentication (for public access)
- [ ] Test on mobile + install as PWA

---

## When Documents Change

If you add, remove, or update source documents:
1. Upload the new/updated PDF to the `source-docs` Supabase bucket
2. Re-run `node extract-docs.mjs` to regenerate the `.txt` files
3. The API will automatically pick up the new content on the next request (no redeploy needed)
