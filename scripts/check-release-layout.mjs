// Focused 4.5 release checks. No network or model requests; requires Chromium.
import {build} from 'esbuild';
import {readFileSync,writeFileSync,mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
const root=fileURLToPath(new URL('..',import.meta.url));
const temporary=mkdtempSync(join(tmpdir(),'papermirror-release-'));
try {
 await build({entryPoints:[join(root,'tests/browser/release45.ts')],bundle:true,platform:'browser',format:'iife',
  outfile:join(temporary,'check.js'),loader:{'.css':'text','.svg':'text'}});
 writeFileSync(join(temporary,'check.html'),'<!doctype html><meta charset="utf-8"><style>'+readFileSync(join(root,'src/ui/styles/translationPane.css'),'utf8')+'</style><script defer src="check.js"></script>');
 const binary=process.env.CHROME_BINARY || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
 const result=spawnSync(binary,['--headless','--disable-background-networking','--disable-gpu','--no-first-run',
  '--window-size=1600,1000',`--user-data-dir=${join(temporary,'profile')}`,'--virtual-time-budget=5000',
  '--dump-dom',`file://${join(temporary,'check.html')}`],{encoding:'utf8',timeout:30000,maxBuffer:4*1024*1024});
 const match=result.stdout?.match(/<pre id="result"[^>]*>[\s\S]*?<\/pre>/)?.[0];
 if(result.status!==0 || !match?.includes('data-pass="true"'))throw Error(match || result.error?.message || result.stderr || 'Chromium did not complete');
 console.log(match);
} finally {rmSync(temporary,{recursive:true,force:true});}
