// Local browser geometry check. CHROME_BINARY may select an installed Chromium.
import { build } from 'esbuild';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
const root = fileURLToPath(new URL('..', import.meta.url));
const temporary = mkdtempSync(join(tmpdir(), 'papermirror-wrap-'));
try {
 await build({ entryPoints: [join(root,'tests/browser/wrapFlow.ts')], bundle:true, platform:'browser', format:'iife', outfile:join(temporary,'check.js'), loader:{'.css':'text','.svg':'text'} });
 writeFileSync(join(temporary,'check.html'), '<!doctype html><meta charset="utf-8"><style>'+readFileSync(join(root,'src/ui/styles/translationPane.css'),'utf8')+'</style><script defer src="check.js"></script>');
 const binary = process.env.CHROME_BINARY || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
 const result = spawnSync(binary, ['--headless','--disable-background-networking','--disable-gpu','--no-first-run',`--user-data-dir=${join(temporary,'profile')}`,'--dump-dom',`file://${join(temporary,'check.html')}`], { encoding:'utf8', timeout:30000, maxBuffer:4*1024*1024 });
 const match = result.stdout?.match(/<pre id="result"[^>]*>[\s\S]*?<\/pre>/);
 if(result.status !== 0 || !match?.[0].includes('data-pass="true"')) throw Error(match?.[0] || result.error?.message || result.stderr);
 console.log(match[0]);
} finally { rmSync(temporary,{recursive:true,force:true}); }
