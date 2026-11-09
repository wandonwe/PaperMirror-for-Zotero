/*
 * PaperMirror on-device glyph clipping check (4.8).
 *
 * Runs inside Zotero: Tools → Developer → Run JavaScript, with
 * "Run as async function" ticked:
 *
 *   const run = eval(await Zotero.File.getContentsAsync('/path/to/scripts/zotero/ink-clip-check.js'));
 *   return await run({ items: [{ label: 'Kitagawa 2021', attachmentID: 2699, pages: 13 }],
 *                      output: '/path/to/ink-clip-result.json' });
 *
 * For every listed PDF attachment it opens the reader, switches PaperMirror to
 * split mode and restores each page from the translation cache. Local-only mode
 * is forced on for the whole run, so a cache miss or a compress-and-retry round
 * cannot reach a cloud provider; the previous setting is restored afterwards and
 * every tab the script opened is closed again.
 *
 * Each committed translation block is rasterised with drawWindow at device
 * resolution twice — as shown (overflow:hidden) and with overflow:visible — and
 * every pixel whose luminance differs by more than 64 counts as clipped ink.
 * The capture origin is repeated at several sub-pixel phases because the
 * device grid a scrolled pane lands on, and therefore where the baseline and
 * the clip edge round, changes with the scroll position.
 *
 * Read-only apart from the temporary preference and the optional output file.
 */
(async (config = {}) => {
  const win = Zotero.getMainWindow(), doc = win.document, NS = 'http://www.w3.org/1999/xhtml';
  const PREF = 'extensions.zotero.bilingualReader.localOnlyMode';
  const phases = config.phases ?? [0, 0.25, 0.5, 0.75];
  const threshold = config.threshold ?? 64;
  const settleMs = config.settleMs ?? 500;
  const sleep = ms => new Promise(r => win.setTimeout(r, ms));
  const dpr = win.devicePixelRatio;
  const result = { tool: 'ink-clip-check', version: Zotero.PaperMirror && Zotero.PaperMirror.version,
    zotero: Zotero.version, dpr, phases, threshold, started: new Date().toISOString(), items: [], errors: [] };
  const save = async () => { if (config.output) await Zotero.File.putContentsAsync(config.output, JSON.stringify(result)); };
  if (!Zotero.PaperMirror) { result.errors.push('PaperMirror is not installed'); await save(); return result; }

  const canvas = doc.createElementNS(NS, 'canvas'), ctx = canvas.getContext('2d');
  const grab = (x, y, w, h) => {
    canvas.width = Math.ceil(w * dpr); canvas.height = Math.ceil(h * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.drawWindow(win, x, y, w, h, 'rgb(255,255,255)');
    return ctx.getImageData(0, 0, canvas.width, canvas.height).data;
  };
  const lum = (d, i) => 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
  const visible = e => e.style.visibility !== 'hidden' && win.getComputedStyle(e).visibility !== 'hidden' && !!e.textContent;
  const scroller = el => {
    for (let p = el.parentElement; p; p = p.parentElement) {
      const cs = win.getComputedStyle(p);
      if (/(auto|scroll)/.test(cs.overflowY) && p.scrollHeight > p.clientHeight + 2) return p;
    }
    return null;
  };
  const measure = async node => {
    let r = node.getBoundingClientRect();
    const sc = scroller(node);
    const inView = rr => { const v = sc ? sc.getBoundingClientRect() : { top: 0, bottom: win.innerHeight }; return rr.top - 4 >= v.top && rr.bottom + 4 <= v.bottom; };
    if (!inView(r)) { node.scrollIntoView({ block: 'center' }); await sleep(250); r = node.getBoundingClientRect(); if (!inView(r)) return { skipped: 'offscreen' }; }
    const pieces = [node, ...node.querySelectorAll('.pm-flow-piece')];
    const saved = pieces.map(p => p.style.overflow);
    const perPhase = [];
    try {
      for (const phase of phases) {
        const x = r.left - 3, y = Math.floor((r.top - 3) * dpr) / dpr + phase / dpr, w = r.width + 6, h = r.height + 7;
        const shown = grab(x, y, w, h);
        pieces.forEach(p => { p.style.overflow = 'visible'; });
        await sleep(20);
        const full = grab(x, y, w, h);
        pieces.forEach((p, i) => { p.style.overflow = saved[i]; });
        await sleep(10);
        let n = 0;
        for (let i = 0; i < shown.length; i += 4) if (Math.abs(lum(shown, i) - lum(full, i)) > threshold) n++;
        perPhase.push(n);
      }
    } finally { pieces.forEach((p, i) => { p.style.overflow = saved[i]; }); }
    return { clippedPixels: Math.max(...perPhase), perPhase };
  };

  const previous = Zotero.Prefs.get(PREF, true);
  const opened = [];
  try {
    Zotero.Prefs.set(PREF, true, true);
    for (const item of config.items ?? []) {
      const entry = { label: item.label ?? String(item.attachmentID), attachmentID: item.attachmentID, pages: [] };
      result.items.push(entry);
      const reader = await Zotero.Reader.open(item.attachmentID);
      opened.push(reader.tabID);
      await reader._initPromise; await sleep(2500);
      await Zotero.PaperMirror.setMode('split'); await sleep(2000);
      const host = reader._tabContainer;
      const pages = item.pageIndexes ?? [...Array(item.pages ?? 1).keys()];
      for (const p of pages) {
        reader.navigate({ pageIndex: p });
        // Settled = the same non-empty set of blocks with unchanged visibility,
        // font size, line height and box height for six polls. A stable block
        // COUNT is not enough: the fit passes keep restyling blocks after they
        // appear, and measuring mid-pass reported thousands of phantom pixels.
        let pageEl = null, last = '', stable = 0;
        for (let t = 0; t < 60; t++) {
          await sleep(settleMs);
          pageEl = host.querySelector(`.pm-repage[data-pm-page="${p}"]`);
          const blocks = pageEl ? [...pageEl.querySelectorAll('.pm-repage-block')] : [];
          const sig = blocks.map(n => [n.getAttribute('data-pm-block'), n.style.visibility, n.style.fontSize, n.style.lineHeight, n.style.height].join(':')).join('|');
          if (blocks.length && sig === last) { if (++stable >= 6) break; } else stable = 0;
          last = sig;
        }
        await sleep(1000);
        const page = { pageIndex: p, found: !!pageEl, blocks: [], committed: [], clipped: [] };
        entry.pages.push(page);
        if (pageEl) {
          const all = [...pageEl.querySelectorAll('.pm-repage-block')];
          page.blocks = all.map(n => n.getAttribute('data-pm-block'));
          const shown = all.filter(visible);
          page.committed = shown.map(n => n.getAttribute('data-pm-block'));
          for (const node of shown) {
            try {
              const m = await measure(node);
              if (m.skipped || m.clippedPixels > 0) page.clipped.push({ id: node.getAttribute('data-pm-block'), text: (node.textContent || '').slice(0, 24), ...m });
            } catch (e) { result.errors.push(`${entry.label} p${p + 1}: ${e}`); }
          }
        }
        await save();
      }
      try { await Zotero.PaperMirror.setMode('original'); } catch (e) { /* tab closes below */ }
    }
  } catch (e) {
    result.errors.push(`fatal: ${e}`);
  } finally {
    Zotero.Prefs.set(PREF, previous, true);
    for (const tab of opened) { try { win.Zotero_Tabs.close(tab); } catch (e) { /* already closed */ } }
    const pages = result.items.flatMap(i => i.pages);
    result.totals = {
      pages: pages.length,
      blocks: pages.reduce((s, p) => s + p.blocks.length, 0),
      committed: pages.reduce((s, p) => s + p.committed.length, 0),
      clippedBlocks: pages.reduce((s, p) => s + p.clipped.filter(c => c.clippedPixels > 0).length, 0),
      clippedPixels: pages.reduce((s, p) => s + p.clipped.reduce((t, c) => t + (c.clippedPixels || 0), 0), 0),
      skipped: pages.reduce((s, p) => s + p.clipped.filter(c => c.skipped).length, 0)
    };
    result.localOnlyRestored = Zotero.Prefs.get(PREF, true) === previous;
    result.finished = new Date().toISOString();
    await save();
  }
  return result;
})
