// Restore guard for scripts/zotero/acceptance-ab.js.
//
// The A/B run turns local-only mode on and add-on auto-update off, and puts
// both back in its finally block. When Zotero quits mid-run that block never
// runs: twice during the 5.1 check (2026-11-26) Zotero restarted and stayed in
// local-only mode with auto-update off until the prefs were reset by hand.
//
// So before changing anything the run writes the values it found to a guard
// file, keeps the list of step prefs in it current, and deletes it once the
// finally block has restored everything. A guard file that is still there when
// the next run starts means the last run never finished: its values are put
// back first, before the new run reads "previous" values.
//
// Evaluates to guard(file, { Zotero, Services, IOUtils }).
(() => {
  const LOCAL_ONLY = 'extensions.zotero.bilingualReader.localOnlyMode', AUTO_UPDATE = 'extensions.update.enabled';
  return (file, { Zotero, Services, IOUtils }) => {
    let state = null;
    const write = () => Zotero.File.putContentsAsync(file, JSON.stringify(state));
    return {
      // Undo a run that never reached its finally block. Returns what it restored, or null.
      async recover() {
        if (!(await IOUtils.exists(file))) return null;
        let saved;
        try { saved = JSON.parse(await Zotero.File.getContentsAsync(file)); } catch (e) { saved = null; }
        if (saved && typeof saved.localOnly === 'boolean') Zotero.Prefs.set(LOCAL_ONLY, saved.localOnly, true);
        if (saved && typeof saved.autoUpdate === 'boolean') Services.prefs.setBoolPref(AUTO_UPDATE, saved.autoUpdate);
        for (const k of (saved && saved.stepPrefs) || []) Zotero.Prefs.clear(k, true);
        await IOUtils.remove(file, { ignoreAbsent: true });
        return saved || { unreadable: true };
      },
      // Record the values to restore, before the run changes them.
      async arm(tag) {
        state = { tag, started: new Date().toISOString(), localOnly: Zotero.Prefs.get(LOCAL_ONLY, true), autoUpdate: Services.prefs.getBoolPref(AUTO_UPDATE, true), stepPrefs: [] };
        await write();
        return state;
      },
      // Keep the step prefs that are set right now in the guard file.
      async stepPrefs(keys) { if (state) { state.stepPrefs = [...keys]; await write(); } },
      // The finally block restored everything.
      async disarm() { state = null; await IOUtils.remove(file, { ignoreAbsent: true }); }
    };
  };
})()
