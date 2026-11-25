/*
 * PaperMirror on-device glyph clipping check (4.10).
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
 * resolution in a closed/open/closed sequence — as shown, overflow:visible,
 * and restored — and
 * every pixel whose luminance differs by more than 64 counts as clipped ink.
 * The capture origin is repeated at several sub-pixel phases because the
 * device grid a scrolled pane lands on, and therefore where the baseline and
 * the clip edge round, changes with the scroll position.
 *
 * Every measurement, including zeroes and unstable pairs, is retained. A
 * changed closed image or painted geometry marks the pair as noisy; it does not erase
 * its clipping count. Missing/unsettled pages and skipped blocks fail auditPass.
 *
 * Read-only apart from the temporary preference and the optional output file.
 */
(async (config = {}) => {
  const win = Zotero.getMainWindow(), doc = win.document, NS = 'http://www.w3.org/1999/xhtml';
  const PREF = 'extensions.zotero.bilingualReader.localOnlyMode';
  const phases = config.phases ?? [0, 0.25, 0.5, 0.75];
  const threshold = config.threshold ?? 64;
  if (!Array.isArray(phases) || !phases.length || phases.some(p => !Number.isFinite(p))) throw new Error('phases must be a nonempty finite array');
  if (!Number.isFinite(threshold) || threshold < 0 || threshold > 64) throw new Error('threshold must not exceed the release threshold (64)');
  const settleMs = config.settleMs ?? 500;
  const sleep = ms => new Promise(r => win.setTimeout(r, ms));
  const dpr = win.devicePixelRatio;
  const result = { tool: 'ink-clip-check', schemaVersion: 4, version: Zotero.PaperMirror && Zotero.PaperMirror.version,
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
  const difference = (a, b) => {
    if (a.length !== b.length) throw new Error('capture dimensions changed');
    let count = 0;
    for (let i = 0; i < a.length; i += 4) if (Math.abs(lum(a, i) - lum(b, i)) > threshold) count++;
    return count;
  };
  // Where the clipped ink is (device pixels from the capture origin), so a
  // reading can be traced to a glyph and an edge. Diagnostic only.
  const differingPixels = (a, b, width) => {
    const out = [];
    for (let i = 0; i < a.length && out.length < 64; i += 4) {
      const d = Math.abs(lum(a, i) - lum(b, i));
      if (d > threshold) out.push({ x: (i / 4) % width, y: Math.floor(i / 4 / width), difference: Math.round(d) });
    }
    return out;
  };
  const rectData = r => ({ left: r.left, top: r.top, width: r.width, height: r.height });
  // Include actual geometry and computed style: inline style alone misses
  // scrolling, inherited font loading, stylesheet changes and flow children.
  const geometry = node => [node, ...node.querySelectorAll('.pm-flow-piece')].map(n => {
    const c = win.getComputedStyle(n);
    return { rect: rectData(n.getBoundingClientRect()), text: n.textContent,
      font: [c.fontStyle, c.fontWeight, c.fontSize, c.fontFamily].join(' '),
      lineHeight: c.lineHeight, visibility: c.visibility, display: c.display,
      transform: c.transform, paddingTop: c.paddingTop, paddingBottom: c.paddingBottom,
      scrollTop: n.scrollTop, scrollLeft: n.scrollLeft, clientHeight: n.clientHeight, clientWidth: n.clientWidth,
      scrollHeight: n.scrollHeight, scrollWidth: n.scrollWidth };
  });
  const signature = nodes => JSON.stringify(nodes.map(n => [n.getAttribute('data-pm-block'), geometry(n)]));
  // Gecko changes scrollWidth/scrollHeight when overflow switches hidden ↔
  // visible even with identical painted geometry (on-device: 7→6→7 and
  // 16→15→16). Keep those readings, but do not call that reversible accounting
  // change layout drift. Client sizes, positions, style and scroll offsets
  // still must agree, and the complete closed geometry must be restored.
  const paintSignature = state => JSON.stringify(state.map(({ scrollWidth, scrollHeight, ...paint }) => paint));
  const extents = state => state.map(g => ({ scrollWidth: g.scrollWidth, scrollHeight: g.scrollHeight }));
  const settleNode = async node => {
    let last = '', stable = 0;
    for (let poll = 0; poll < 50; poll++) {
      await sleep(40);
      const sig = signature([node]);
      if (sig === last) { if (++stable >= 4) return true; } else stable = 0;
      last = sig;
    }
    return false;
  };
  const visible = e => e.style.visibility !== 'hidden' && win.getComputedStyle(e).visibility !== 'hidden' && !!e.textContent;
  const scroller = el => {
    for (let p = el.parentElement; p; p = p.parentElement) {
      const cs = win.getComputedStyle(p);
      if (/(auto|scroll)/.test(cs.overflowY) && p.scrollHeight > p.clientHeight + 2) return p;
    }
    return null;
  };
  // Optional exact glyph evidence for a suspect block (IDs are page-local).
  // It is read after the captures so changing a canvas font cannot influence
  // the images. No layout/style mutation or translation is involved.
  const fontEvidence = node => {
    if (!config.diagnosticBlockIDs?.includes(node.getAttribute('data-pm-block'))) return undefined;
    const evidence = [], range = doc.createRange(), walker = doc.createTreeWalker(node, 4);
    const probe = doc.createElementNS(NS, 'canvas').getContext('2d');
    let text;
    while ((text = walker.nextNode())) {
      const style = win.getComputedStyle(text.parentElement);
      const font = `${style.fontStyle} ${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
      let offset = 0;
      for (const glyph of Array.from(text.textContent || '')) {
        range.setStart(text, offset); offset += glyph.length; range.setEnd(text, offset);
        if (!glyph.trim()) continue;
        probe.font = font; probe.textBaseline = 'alphabetic';
        const m = probe.measureText(glyph);
        probe.font = `${style.fontStyle} ${style.fontWeight} 256px ${style.fontFamily}`;
        const reference = probe.measureText(glyph), k = parseFloat(style.fontSize) / 256;
        evidence.push({ glyph, font, lineHeight: style.lineHeight, rects: [...range.getClientRects()].map(rectData),
          canvas: { ascent: m.fontBoundingBoxAscent, descent: m.fontBoundingBoxDescent,
            inkAscent: m.actualBoundingBoxAscent, inkDescent: m.actualBoundingBoxDescent },
          reference: { ascent: reference.fontBoundingBoxAscent * k, descent: reference.fontBoundingBoxDescent * k } });
      }
    }
    return evidence;
  };
  const measure = async node => {
    let r = node.getBoundingClientRect();
    const sc = scroller(node);
    const inView = rr => { const v = sc ? sc.getBoundingClientRect() : { top: 0, bottom: win.innerHeight }; return rr.top - 4 >= v.top && rr.bottom + 4 <= v.bottom; };
    if (!inView(r)) node.scrollIntoView({ block: 'center', behavior: 'instant' });
    if (!await settleNode(node)) return { skipped: 'unsettled-node' };
    r = node.getBoundingClientRect();
    if (!inView(r)) return { skipped: 'offscreen', rect: rectData(r) };
    const pieces = [node, ...node.querySelectorAll('.pm-flow-piece')];
    const saved = pieces.map(p => p.style.overflow);
    const perPhase = [], phaseEvidence = [];
    const layout = geometry(node);
    try {
      for (const phase of phases) {
        const r = node.getBoundingClientRect();
        const x = r.left - 3, y = Math.floor((r.top - 3) * dpr) / dpr + phase / dpr, w = r.width + 6, h = r.height + 7;
        const beforeGeometry = geometry(node);
        const shown = grab(x, y, w, h);
        pieces.forEach(p => { p.style.overflow = 'visible'; });
        await sleep(20);
        const openGeometry = geometry(node);
        const full = grab(x, y, w, h);
        pieces.forEach((p, i) => { p.style.overflow = saved[i]; });
        await sleep(20);
        const afterGeometry = geometry(node);
        const restored = grab(x, y, w, h);
        const beforePixels = difference(shown, full), afterPixels = difference(restored, full);
        const closedDriftPixels = difference(shown, restored);
        const beforeRaw = JSON.stringify(beforeGeometry), openRaw = JSON.stringify(openGeometry), afterRaw = JSON.stringify(afterGeometry);
        const rawGeometryStable = beforeRaw === openRaw && beforeRaw === afterRaw;
        const geometryRestored = beforeRaw === afterRaw;
        const geometryStable = paintSignature(beforeGeometry) === paintSignature(openGeometry) && geometryRestored;
        const scrollExtentChanged = JSON.stringify(extents(beforeGeometry)) !== JSON.stringify(extents(openGeometry));
        // Never discard a nonzero reading, including when drift proves this
        // pair cannot establish clipping. Reruns are separate evidence files.
        perPhase.push(Math.max(beforePixels, afterPixels));
        phaseEvidence.push({ phase, beforePixels, afterPixels, closedDriftPixels, geometryStable, rawGeometryStable, geometryRestored,
          scrollExtentChanged, scrollExtents: scrollExtentChanged ? { closed: extents(beforeGeometry), open: extents(openGeometry), restored: extents(afterGeometry) } : undefined,
          geometryStates: !geometryStable ? { closed: beforeGeometry, open: openGeometry, restored: afterGeometry } : undefined,
          pixels: beforePixels || afterPixels ? differingPixels(beforePixels >= afterPixels ? shown : restored, full, Math.ceil(w * dpr)) : undefined,
          capture: { x, y, w, h } });
      }
    } finally { pieces.forEach((p, i) => { p.style.overflow = saved[i]; }); }
    return { clippedPixels: Math.max(...perPhase), perPhase, phaseEvidence, layout, fontEvidence: fontEvidence(node),
      noisy: phaseEvidence.some(p => p.closedDriftPixels > 0 || !p.geometryStable) };
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
      if (doc.fonts?.ready) await doc.fonts.ready;
      const host = reader._tabContainer;
      const pages = item.pageIndexes ?? [...Array(item.pages ?? 1).keys()];
      // Settled = the same non-empty set of blocks with unchanged visibility,
      // font size, line height and box height for `builtPolls` polls. A stable
      // block COUNT is not enough: the fit passes keep restyling blocks after
      // they appear, and measuring mid-pass reported thousands of phantom pixels.
      //
      // The plugin leaves a page as its original bitmap when it has nothing to
      // show there (every block preserved, or no cached translation in
      // local-only mode). That is a legitimate final state, but the same shell
      // also precedes every translated page and the DOM cannot tell the two
      // apart. Such a page is therefore reported separately (`original`),
      // needs a much longer unchanged window, and is visited a second time
      // after the rest of the paper; the caller must still show that the
      // baseline committed nothing there. A page with neither shell fails.
      const builtPolls = config.builtPolls ?? 10, shellPolls = config.shellPolls ?? 30;
      const blockIDs = el => [...el.querySelectorAll('.pm-repage-block')].map(n => n.getAttribute('data-pm-block'));
      const visit = async (p, patience) => {
        reader.navigate({ pageIndex: p });
        let pageEl = null, last = '', stable = 0, settled = false, original = false;
        for (let t = 0; t < 60 + patience; t++) {
          await sleep(settleMs);
          pageEl = host.querySelector(`.pm-repage[data-pm-page="${p}"]`);
          const blocks = pageEl ? [...pageEl.querySelectorAll('.pm-repage-block')] : [];
          const shell = !pageEl && !!host.querySelector(`.pm-repage-slot[data-pm-slot="${p}"] > .pm-repage[data-pm-original]`);
          const sig = shell ? 'original-shell' : signature(blocks);
          if ((blocks.length || shell) && sig === last) { if (++stable >= (shell ? patience : builtPolls)) { settled = true; original = shell; break; } } else stable = 0;
          last = sig;
        }
        await sleep(1000);
        const page = { pageIndex: p, found: !!pageEl || original, settled, original, blocks: [], committed: [], texts: {}, clipped: [], measurements: [] };
        if (pageEl) {
          const all = [...pageEl.querySelectorAll('.pm-repage-block')];
          page.blocks = all.map(n => n.getAttribute('data-pm-block'));
          // Block ids renumber when the structure changes; the text makes a
          // before/after comparison possible without guessing from ids.
          for (const n of all) page.texts[n.getAttribute('data-pm-block')] = (n.textContent || '').slice(0, 80);
          // Why a block is not shown: the plugin's own placement record.
          try {
            page.unplaced = (typeof pageEl.pmProbe === 'function' ? pageEl.pmProbe(false) : [])
              .filter(row => row.state !== 'committed').map(row => ({ id: row.id, state: row.state, reason: row.abandonReason,
                measurement: row.measurement, inkFailure: row.inkFailure, width: row.width, height: row.height }));
          } catch (e) { page.unplaced = [{ error: String(e) }]; }
          const shown = all.filter(visible);
          page.committed = shown.map(n => n.getAttribute('data-pm-block'));
          for (const node of shown) {
            try {
              const m = settled ? await measure(node) : { skipped: 'unsettled-page' };
              page.measurements.push({ id: node.getAttribute('data-pm-block'), ...m });
              if (m.skipped || m.clippedPixels > 0) page.clipped.push({ id: node.getAttribute('data-pm-block'), text: (node.textContent || '').slice(0, 24), ...m });
            } catch (e) { page.fault = String(e); }
          }
          // The page must still be the one that was measured: a rebuild during
          // the measurement (late translations) invalidates the whole reading.
          const now = host.querySelector(`.pm-repage[data-pm-page="${p}"]`);
          page.rebuilt = now !== pageEl || JSON.stringify(now ? blockIDs(now) : []) !== JSON.stringify(page.blocks);
        }
        return page;
      };
      for (const p of pages) {
        let page = await visit(p, shellPolls);
        for (let retry = 0; retry < 2 && page.rebuilt; retry++) { page = await visit(p, shellPolls); page.retries = retry + 1; }
        // 5.0.1+: the plugin's own record of this page's cache lookup (categories, counts, hash prefixes only).
        try { const t = Zotero.PaperMirror.cacheTrace?.(p); if (t && typeof t === 'object') page.cacheTrace = t; } catch (e) { /* older plugin */ }
        page.hidden = doc.hidden; // PaperMirror does not follow page changes while hidden (2.2.9)
        entry.pages.push(page);
        await save();
      }
      // Second look at pages that were still original bitmaps.
      for (let i = 0; i < entry.pages.length; i++) {
        if (!entry.pages[i].original) continue;
        let page = await visit(entry.pages[i].pageIndex, shellPolls);
        for (let retry = 0; retry < 2 && page.rebuilt; retry++) page = await visit(entry.pages[i].pageIndex, shellPolls);
        try { const t = Zotero.PaperMirror.cacheTrace?.(entry.pages[i].pageIndex); if (t && typeof t === 'object') page.cacheTrace = t; } catch (e) { /* older plugin */ }
        page.hidden = doc.hidden;
        page.secondLook = true; entry.pages[i] = page;
        await save();
      }
      for (const page of entry.pages) {
        if (!page.settled) result.errors.push(`${entry.label} p${page.pageIndex + 1}: ${page.found ? 'layout did not settle' : 'page not found'}`);
        if (page.rebuilt) result.errors.push(`${entry.label} p${page.pageIndex + 1}: page was rebuilt during measurement`);
        if (page.fault) result.errors.push(`${entry.label} p${page.pageIndex + 1}: ${page.fault}`);
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
      skipped: pages.reduce((s, p) => s + p.clipped.filter(c => c.skipped).length, 0),
      noisyBlocks: pages.reduce((s, p) => s + p.measurements.filter(m => m.noisy).length, 0),
      originalPages: pages.filter(p => p.original).length,
      unverifiedPages: pages.filter(p => !p.found || !p.settled || p.rebuilt).length
    };
    result.localOnlyRestored = Zotero.Prefs.get(PREF, true) === previous;
    result.auditPass = pages.length > 0 && !result.errors.length && !result.totals.clippedBlocks &&
      !result.totals.skipped && !result.totals.noisyBlocks && !result.totals.unverifiedPages && result.localOnlyRestored;
    result.finished = new Date().toISOString();
    await save();
  }
  return result;
})
