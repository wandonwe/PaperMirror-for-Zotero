/*
 * Read-only getPageData request-realm diagnostic, run inside Zotero.
 * Tools → Developer → Run JavaScript, tick "Run as async function":
 *
 * const run = eval(await Zotero.File.getContentsAsync('/path/to/page-data-realm-check.js'));
 * return await run({ items: [{label: 'Paper', attachmentID: 123, pageIndexes: [0]}],
 *                    output: '/path/to/output/page-data-realm.json' });
 *
 * Each page is read four times: chrome literal, content Object, cloneInto,
 * chrome literal again. The repeated failure after successful reads separates
 * a request-realm failure from a worker that was merely not ready. This tool
 * does not translate pages or modify the plugin's extraction strategy.
 * Output contains counts and error names, never paper text or exception stacks.
 */
(async (config = {}) => {
  const PREF = 'extensions.zotero.bilingualReader.localOnlyMode';
  const previous = Zotero.Prefs.get(PREF, true), main = Zotero.getMainWindow();
  const unwrap = value => value?.wrappedJSObject ?? value;
  const errorName = error => /^[A-Za-z][A-Za-z0-9_]{0,79}$/.test(String(error?.name ?? ''))
    ? String(error.name) : 'Error';
  const result = { tool: 'page-data-realm-check', zotero: Zotero.version,
    plugin: Zotero.PaperMirror?.version, started: new Date().toISOString(), rows: [], errors: [] };
  const opened = [];
  const save = async () => {
    if (config.output) await Zotero.File.putContentsAsync(config.output, JSON.stringify(result, null, 2));
  };
  const attempt = async (doc, label, request) => {
    const started = Date.now();
    let timer;
    try {
      const data = await Promise.race([
        doc.getPageData(request()),
        new Promise((_, reject) => {
          timer = main.setTimeout(() => {
            const e = new Error('Timed out'); e.name = 'TimeoutError'; reject(e);
          }, config.timeoutMs ?? 8000);
        })
      ]);
      const chars = unwrap(data)?.chars;
      if (!chars || typeof chars.length !== 'number') return { label, ok: false, name: 'NoCharsArray' };
      return { label, ok: true, milliseconds: Date.now() - started,
        chars: chars.length,
        textLength: Array.from(chars, c => String(c.c ?? '')).join('').length,
        hasLineBreaks: Array.from(chars).filter(c => c.lineBreakAfter).length };
    } catch (e) {
      return { label, ok: false, milliseconds: Date.now() - started, name: errorName(e) };
    } finally { if (timer !== undefined) main.clearTimeout(timer); }
  };
  try {
    Zotero.Prefs.set(PREF, true, true);
    for (const item of config.items ?? []) {
      const existing = Zotero.Reader._readers?.find(r => r.itemID === item.attachmentID);
      const reader = await Zotero.Reader.open(item.attachmentID);
      if (!existing) opened.push(reader.tabID);
      await reader._initPromise;
      let win, doc;
      for (let waited = 0; waited <= (config.timeoutMs ?? 8000); waited += 50) {
        win = unwrap(reader._internalReader?._primaryView?._iframeWindow);
        doc = unwrap(unwrap(win?.PDFViewerApplication)?.pdfDocument);
        if (typeof doc?.getPageData === 'function') break;
        await new Promise(resolve => main.setTimeout(resolve, 50));
      }
      if (typeof doc?.getPageData !== 'function') {
        result.errors.push({ label: item.label, name: 'MissingPageDataAPI' }); continue;
      }
      for (const pageIndex of item.pageIndexes ?? [0]) {
        const row = { label: item.label ?? String(item.attachmentID), pageIndex, tests: [] };
        result.rows.push(row);
        row.tests.push(await attempt(doc, 'chrome object', () => ({ pageIndex })));
        row.tests.push(await attempt(doc, 'content Object', () => {
          const data = new win.Object(); data.pageIndex = pageIndex; return data;
        }));
        row.tests.push(await attempt(doc, 'Cu.cloneInto', () => {
          const cu = typeof Cu !== 'undefined' ? Cu : Components.utils;
          return cu.cloneInto({ pageIndex }, win);
        }));
        row.tests.push(await attempt(doc, 'chrome object repeat', () => ({ pageIndex })));
        await save();
      }
    }
  } catch (e) { result.errors.push({ name: errorName(e) }); }
  finally {
    Zotero.Prefs.set(PREF, previous, true);
    for (const id of opened) { try { main.Zotero_Tabs.close(id); } catch { /* already closed */ } }
    result.localOnlyRestored = Zotero.Prefs.get(PREF, true) === previous;
    result.finished = new Date().toISOString();
    await save();
  }
  return result;
})
