// Fill a build's translation cache before a cache-only A/B (Tools > Developer > Run JavaScript).
//
// Load with:  eval(Zotero.File.getContents('<repo>/scripts/zotero/prime-cache.js'))
// Reads output/pm-run.config.json (the acceptance-ab.js config) and its
// "prime" entry: { xpi, version }. Installs that build, turns local-only mode
// off, and visits every page in cfg.items in split mode until the page holds
// blocks and no request is in flight. Results: output/<tag>-prime.json.
//
// Why: acceptance-ab.js blocks every request. A build that changes block
// structure (5.1 bold headings) or a prompt rule version (5.1 tableCells v4)
// has no cache entries for those blocks, so its pages would stay original
// bitmaps under the A/B. Prime it once online, then compare from cache.
//
// Like acceptance-ab.js it waits while the main window is hidden or not
// painting (PaperMirror does not follow page changes then), checks the running
// version after each paper, and stops on output/<tag>-STOP. Local-only mode and
// auto-update are put back in the finally block. The build stays installed.
// "prime": { ..., "then": "ab" } starts acceptance-ab.js with the same config
// once every page was primed without an error.
(async () => {
  const ROOT = '/Users/wangdongwei/Documents/Developer/PaperMirror for Zotero/', DIR = ROOT + 'output/';
  const cfg = JSON.parse(await Zotero.File.getContentsAsync(DIR + 'pm-run.config.json'));
  const win = Zotero.getMainWindow(), sleep = ms => new Promise(r => win.setTimeout(r, ms));
  const { AddonManager } = ChromeUtils.importESModule('resource://gre/modules/AddonManager.sys.mjs');
  const PREF = 'extensions.zotero.bilingualReader.localOnlyMode', UPDATE_PREF = 'extensions.update.enabled';
  const prev = Zotero.Prefs.get(PREF, true), prevUpdate = Services.prefs.getBoolPref(UPDATE_PREF, true);
  const out = { tool: 'pm-prime', tag: cfg.tag, prime: cfg.prime, started: new Date().toISOString(), items: [], pauses: [], errors: [] };
  const save = () => Zotero.File.putContentsAsync(DIR + cfg.tag + '-prime.json', JSON.stringify(out));
  const stopRequested = () => IOUtils.exists(DIR + cfg.tag + '-STOP');
  const painting = () => new Promise(r => { let ok = false; win.requestAnimationFrame(() => { ok = true; r(!win.document.hidden); }); win.setTimeout(() => r(ok && !win.document.hidden), 2000); });
  const waitForPainting = async where => {
    if (await painting()) return;
    const pause = { where, from: new Date().toISOString() }; out.pauses.push(pause); await save();
    while (!(await painting())) { if (await stopRequested()) throw new Error('stop requested'); await sleep(10000); }
    pause.to = new Date().toISOString(); await sleep(3000); await save();
  };
  const allowedOriginal = (id, p) => (cfg.originalPages || []).some(o => o.attachmentID === id && o.pageIndex === p);
  try {
    Services.prefs.setBoolPref(UPDATE_PREF, false);
    if (Zotero.PaperMirror.version !== cfg.prime.version) {
      const inst = await AddonManager.getInstallForFile(Zotero.File.pathToFile(DIR + cfg.prime.xpi));
      await inst.install(); await sleep(4000);
    }
    if (Zotero.PaperMirror.version !== cfg.prime.version) throw new Error('install failed: ' + Zotero.PaperMirror.version);
    Zotero.Prefs.set(PREF, false, true);
    for (const item of cfg.items) {
      if (await stopRequested()) throw new Error('stop requested');
      for (const r of [...(Zotero.Reader._readers || [])]) { try { win.Zotero_Tabs.close(r.tabID); } catch (e) {} }
      await sleep(1500);
      const reader = await Zotero.Reader.open(item.attachmentID); await reader._initPromise; await sleep(2500);
      await Zotero.PaperMirror.setMode('split'); await sleep(1500);
      const entry = { label: item.label, attachmentID: item.attachmentID, pages: [] };
      out.items.push(entry);
      for (const p of item.pageIndexes) {
        let page;
        for (let attempt = 1; attempt <= 3; attempt++) {
          await waitForPainting(item.label + ' p' + (p + 1));
          const t0 = Date.now();
          reader.navigate({ pageIndex: p });
          let last = -1, stable = 0, n = 0, busy = false;
          for (let t = 0; t < 180; t++) {
            await sleep(1000);
            const el = reader._tabContainer.querySelector(`.pm-repage[data-pm-page="${p}"]`);
            n = el ? el.querySelectorAll('.pm-repage-block').length : 0;
            busy = !!reader._tabContainer.querySelector('.pm-capsule[data-state="translating"], .pm-capsule.is-busy');
            const shellOk = n === 0 && allowedOriginal(item.attachmentID, p);
            if ((n > 0 || shellOk) && n === last && !busy) { if (++stable >= (shellOk ? 15 : 6)) break; } else stable = 0;
            last = n;
          }
          page = { pageIndex: p, blocks: n, busy, seconds: Math.round((Date.now() - t0) / 1000), attempt, stillPainting: await painting() };
          if (page.stillPainting && (n > 0 || allowedOriginal(item.attachmentID, p)) && !busy) break;
        }
        entry.pages.push(page); await save();
      }
      if (Zotero.PaperMirror.version !== cfg.prime.version) throw new Error(`running ${Zotero.PaperMirror.version}, expected ${cfg.prime.version}`);
      try { win.Zotero_Tabs.close(reader.tabID); } catch (e) {}
    }
  } catch (e) { out.errors.push(String(e && e.stack || e)); }
  finally {
    Zotero.Prefs.set(PREF, prev, true); Services.prefs.setBoolPref(UPDATE_PREF, prevUpdate);
    out.installed = Zotero.PaperMirror.version; out.localOnly = Zotero.Prefs.get(PREF, true); out.autoUpdate = Services.prefs.getBoolPref(UPDATE_PREF, true);
    out.finished = new Date().toISOString(); await save();
  }
  if (cfg.prime.then === 'ab' && !out.errors.length) return eval(await Zotero.File.getContentsAsync(ROOT + 'scripts/zotero/acceptance-ab.js'));
  return 'primed';
})()
