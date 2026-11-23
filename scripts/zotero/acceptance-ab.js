// On-device A/B acceptance for PaperMirror in Zotero (Tools > Developer > Run JavaScript).
//
// Load with:  eval(Zotero.File.getContents('<repo>/scripts/zotero/acceptance-ab.js'))
// after copying this file and a config to <repo>/output/ (see acceptance-ab.example.json):
//   output/pm-run.config.json  tag, phases, items, steps [{name, xpi, version}],
//                              finalXpi/finalVersion (installed at the end, also on error),
//                              warmup {attachmentID, pageIndex}, originalPages, shellPolls
//   output/<xpi files named in steps>
// Results: output/<tag>-<step>.json (same format as ink-clip-check.js) and
// output/<tag>-status.json (progress, pauses, retries, restore state).
//
// Cache only: local-only mode is on and Zotero.HTTP.request is replaced by a
// function that refuses every request for the whole run; both are restored in
// a finally block. If Zotero quits mid-run that block cannot run: check the
// installed version and extensions.zotero.bilingualReader.localOnlyMode after.
//
// Robustness (learnt in the 4.10 releases):
// - one paper at a time; after each, requestAnimationFrame must still fire.
//   A locked or sleeping screen stops painting and voids every reading, so the
//   run pauses until painting resumes and measures that paper again;
// - right after an install the first paper restored its cache late and its
//   pages stayed original bitmaps: a warm-up paper is opened first, and an
//   original page outside cfg.originalPages is treated as invalid and retried;
// - create output/<tag>-STOP to abort; the finally block still restores everything;
// - add-on auto-update is off during the run: in the 5.0.0 post-release run
//   Zotero updated the reinstalled 4.10.2 back to 5.0.0 mid-run, and the
//   "4.10.2" step measured 5.0.0. Each item also checks the running version.
(async () => {
  // Repository root: the folder that holds scripts/ and output/.
  const ROOT = '/Users/wangdongwei/Documents/Developer/PaperMirror for Zotero/', DIR = ROOT + 'output/';
  const cfg = JSON.parse(await Zotero.File.getContentsAsync(DIR + 'pm-run.config.json'));
  const win = Zotero.getMainWindow(), sleep = ms => new Promise(r => win.setTimeout(r, ms));
  const { AddonManager } = ChromeUtils.importESModule('resource://gre/modules/AddonManager.sys.mjs');
  const run = eval(await Zotero.File.getContentsAsync(ROOT + 'scripts/zotero/ink-clip-check.js'));
  const stopRequested = () => IOUtils.exists(DIR + cfg.tag + '-STOP');
  const painting = () => new Promise(r => { let ok = false; win.requestAnimationFrame(() => { ok = true; r(true); }); win.setTimeout(() => r(ok), 2000); });
  const install = async (file, ver) => {
    const inst = await AddonManager.getInstallForFile(Zotero.File.pathToFile(DIR + file));
    await inst.install(); await sleep(4000);
    if (Zotero.PaperMirror.version !== ver) throw new Error('install failed: ' + Zotero.PaperMirror.version);
    // Warm-up: right after an install the first paper restored its cache too
    // late and its pages stayed original bitmaps. Open one paper and wait for
    // a translated page before measuring anything.
    const w = cfg.warmup; if (!w) return;
    const reader = await Zotero.Reader.open(w.attachmentID); await reader._initPromise; await sleep(2500);
    await Zotero.PaperMirror.setMode('split'); reader.navigate({ pageIndex: w.pageIndex });
    let ok = false;
    for (let t = 0; t < 90 && !ok; t++) { await sleep(1000); ok = !!reader._tabContainer.querySelector(`.pm-repage[data-pm-page="${w.pageIndex}"] .pm-repage-block`); }
    status.warmups = (status.warmups || []).concat({ ver, ok, at: new Date().toISOString() });
    try { await Zotero.PaperMirror.setMode('original'); } catch (e) {}
    try { win.Zotero_Tabs.close(reader.tabID); } catch (e) {}
    await sleep(2000);
  };
  const PREF = 'extensions.zotero.bilingualReader.localOnlyMode', prev = Zotero.Prefs.get(PREF, true);
  const UPDATE_PREF = 'extensions.update.enabled', prevUpdate = Services.prefs.getBoolPref(UPDATE_PREF, true);
  const realRequest = Zotero.HTTP.request; let blocked = 0;
  const status = { tool: 'pm-ab', started: new Date().toISOString(), startVersion: Zotero.PaperMirror.version, runs: [], pauses: [], retries: [], errors: [], closedTabs: [] };
  const save = () => Zotero.File.putContentsAsync(DIR + cfg.tag + '-status.json', JSON.stringify(status));
  const waitForPainting = async where => {
    if (await painting()) return;
    const pause = { where, from: new Date().toISOString() }; status.pauses.push(pause); await save();
    while (!(await painting())) { if (await stopRequested()) throw new Error('stop requested'); await sleep(10000); }
    pause.to = new Date().toISOString(); await sleep(3000); await save();
  };
  const totalsOf = pages => ({
    pages: pages.length, blocks: pages.reduce((s, p) => s + p.blocks.length, 0), committed: pages.reduce((s, p) => s + p.committed.length, 0),
    clippedBlocks: pages.reduce((s, p) => s + p.clipped.filter(c => c.clippedPixels > 0).length, 0),
    clippedPixels: pages.reduce((s, p) => s + p.clipped.reduce((t, c) => t + (c.clippedPixels || 0), 0), 0),
    skipped: pages.reduce((s, p) => s + p.clipped.filter(c => c.skipped).length, 0),
    noisyBlocks: pages.reduce((s, p) => s + p.measurements.filter(m => m.noisy).length, 0),
    originalPages: pages.filter(p => p.original).length, unverifiedPages: pages.filter(p => !p.found || !p.settled || p.rebuilt).length });
  try { if (win.windowState === win.STATE_MINIMIZED) { win.restore(); status.restoredWindow = true; await sleep(2000); } } catch (e) {}
  status.env = { dpr: win.devicePixelRatio, inner: [win.innerWidth, win.innerHeight], dark: win.matchMedia('(prefers-color-scheme: dark)').matches };
  for (const r of [...(Zotero.Reader._readers || [])]) if (cfg.items.some(i => i.attachmentID === r.itemID) && r.tabID) { try { win.Zotero_Tabs.close(r.tabID); status.closedTabs.push(r.itemID); } catch (e) {} }
  await sleep(1500); await save();
  try {
    Zotero.Prefs.set(PREF, true, true);
    Services.prefs.setBoolPref(UPDATE_PREF, false);
    Zotero.HTTP.request = async () => { blocked++; throw new Error('blocked during audit'); };
    for (const step of cfg.steps) {
      if (await stopRequested()) throw new Error('stop requested');
      await install(step.xpi, step.version);
      const merged = { tool: 'ink-clip-check', version: step.version, items: [], errors: [], phases: cfg.phases, started: new Date().toISOString() };
      for (const item of cfg.items) {
        let r;
        for (let attempt = 1; attempt <= 4; attempt++) {
          if (await stopRequested()) throw new Error('stop requested');
          await waitForPainting(step.name + ' ' + item.label);
          r = await run({ items: [item], output: DIR + cfg.tag + '-scratch.json', phases: cfg.phases, shellPolls: cfg.shellPolls ?? 60 });
          const stillPainting = await painting();
          // A page may be an original bitmap only where nothing is translatable
          // (cfg.originalPages, e.g. pages holding only a journal footer).
          const allowed = new Set((cfg.originalPages || []).filter(o => o.attachmentID === item.attachmentID).map(o => o.pageIndex));
          const bad = (r.items[0]?.pages ?? []).filter(p => (!p.settled && !p.original) || p.rebuilt || p.fault || (p.original && (!stillPainting || !allowed.has(p.pageIndex))));
          if (stillPainting && !bad.length && !r.errors.some(e => e.startsWith('fatal'))) break;
          status.retries.push({ step: step.name, item: item.label, attempt, stillPainting, bad: bad.map(p => p.pageIndex) }); await save();
          if (stillPainting && attempt >= 3) break; // painting throughout: keep the reading, it is listed in retries
        }
        if (Zotero.PaperMirror.version !== step.version) throw new Error(`${step.name}: running ${Zotero.PaperMirror.version}, expected ${step.version}`);
        merged.items.push(r.items[0]); merged.errors.push(...r.errors);
        merged.totals = totalsOf(merged.items.flatMap(i => i.pages));
        await Zotero.File.putContentsAsync(DIR + cfg.tag + '-' + step.name + '.json', JSON.stringify(merged));
      }
      merged.finished = new Date().toISOString();
      await Zotero.File.putContentsAsync(DIR + cfg.tag + '-' + step.name + '.json', JSON.stringify(merged));
      status.runs.push({ name: step.name, version: step.version, totals: merged.totals, errors: merged.errors }); await save();
    }
  } catch (e) { status.errors.push(String(e)); }
  finally {
    Zotero.HTTP.request = realRequest; Zotero.Prefs.set(PREF, prev, true); Services.prefs.setBoolPref(UPDATE_PREF, prevUpdate);
    try { await install(cfg.finalXpi, cfg.finalVersion); } catch (e) { status.errors.push('restore: ' + e); }
    status.installed = Zotero.PaperMirror.version; status.blockedHTTP = blocked; status.httpRestored = Zotero.HTTP.request === realRequest;
    status.localOnly = Zotero.Prefs.get(PREF, true); status.autoUpdate = Services.prefs.getBoolPref(UPDATE_PREF, true); status.finished = new Date().toISOString(); await save();
  }
  return JSON.stringify(status);
})()
