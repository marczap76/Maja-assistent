import { createClient } from '@supabase/supabase-js';
import { readFileSync } from 'fs';

let envVars = {};
try {
  const envContent = readFileSync('.env.local', 'utf-8');
  for (const line of envContent.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIndex = trimmed.indexOf('=');
    if (eqIndex > 0) {
      envVars[trimmed.substring(0, eqIndex).trim()] = trimmed.substring(eqIndex + 1).trim();
    }
  }
} catch (e) {
  console.log('No .env.local found');
}

const supabase = createClient(envVars.NEXT_PUBLIC_SUPABASE_URL, envVars.SUPABASE_SERVICE_ROLE_KEY);

async function main() {
  const { data: buckets, error } = await supabase.storage.listBuckets();
  if (error) {
    console.error('Error listing buckets:', error.message);
    return;
  }
  
  console.log('Available buckets:');
  buckets.forEach(b => console.log(' - ' + b.name));

  for (const b of buckets) {
    if (b.name.includes('ocument') || b.name === 'extracted-text') {
      const { data: files } = await supabase.storage.from(b.name).list('');
      console.log(`\nFiles in "${b.name}":`, files?.map(f => f.name));
    }
  }
}

main().catch(console.error);
