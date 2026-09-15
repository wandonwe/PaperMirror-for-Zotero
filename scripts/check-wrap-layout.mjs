// Local browser geometry check. CHROME_BINARY may select an installed Chromium.
import { build } from 'esbuild';
import { readFileSync, writeFileSync, mkdtempSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
const root = fileURLToPath(new URL('..', import.meta.url));
const temporary = mkdtempSync(join(tmpdir(), 'papermirror-wrap-'));
try {
 await build({ entryPoints: [join(root,process.env.PM_REAL_ONLY ? 'tests/browser/realTranslationsStandalone.ts' : 'tests/browser/wrapFlow.ts')], bundle:true, platform:'browser', format:'iife', outfile:join(temporary,'check.js'), loader:{'.css':'text','.svg':'text'} });
 writeFileSync(join(temporary,'check.html'), '<!doctype html><meta charset="utf-8"><style>'+readFileSync(join(root,'src/ui/styles/translationPane.css'),'utf8')+'</style><script>window.captionFixtureImage="data:image/png;base64,'+readFileSync(join(root,'tests/fixtures/regression/simohamed2021-p4.png')).toString('base64')+'";window.realTranslationImages='+JSON.stringify(Object.fromEntries([35,40,27,22,38].map(p=>[p,'data:image/png;base64,'+readFileSync(join(root,`tests/fixtures/regression/${p===22?'serruys2021':'stroke2026'}-p${p}-visual.png`)).toString('base64')])) )+';</script><script defer src="check.js"></script>');
 const binary = process.env.CHROME_BINARY || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
 const result = spawnSync(binary, ['--headless','--window-size=1600,1000','--disable-background-networking','--disable-gpu','--no-first-run',`--user-data-dir=${join(temporary,'profile')}`,'--virtual-time-budget=5000','--dump-dom',`file://${join(temporary,'check.html')}`], { encoding:'utf8', timeout:30000, maxBuffer:4*1024*1024 });
 const match = result.stdout?.match(/<pre id="result"[^>]*>[\s\S]*?<\/pre>/);
 if(result.status !== 0 || !match?.[0].includes('data-pass="true"')) throw Error(match?.[0] || result.error?.message || result.stderr);
 console.log(match[0]);
 if (process.env.PM_VISUAL_OUTPUT) {
  const output=process.env.PM_VISUAL_OUTPUT;mkdirSync(output,{recursive:true});
  writeFileSync(join(output,'real-translations.html'),readFileSync(join(temporary,'check.html'),'utf8').replace('<script defer src="check.js"></script>','<script>'+readFileSync(join(temporary,'check.js'),'utf8')+'</script>'));
  const shot=spawnSync(binary,['--headless','--window-size=1600,1000','--disable-background-networking','--disable-gpu','--no-first-run',`--user-data-dir=${join(temporary,'profile')}`,'--window-size=1250,1000','--virtual-time-budget=5000',`--screenshot=${join(output,'real-translations.png')}`,`file://${join(temporary,'check.html')}`],{encoding:'utf8',timeout:30000});
  if(shot.status!==0)throw Error(shot.stderr||'Screenshot failed');
 }

} finally { rmSync(temporary,{recursive:true,force:true}); }
