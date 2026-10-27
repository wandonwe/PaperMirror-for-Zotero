# Privacy

## What leaves your machine

Translation sends the text of requested pages, including nearby prefetched
pages, to the engines you configured. With a provider pool enabled, requests
may be shared across the selected engines. Deep explanations send the selected
passage, a short excerpt of surrounding source text, and the current document's
display title for context. Automatic selection explanation can be turned off in
Settings; it uses the same provider endpoint restrictions as page translation.

Your Zotero database, other library records, account details, local file paths,
annotations, and saved notes are not included in these requests. Configured
cloud endpoints use HTTPS unless you explicitly allow HTTP. Local-only mode
restricts both translation and explanation requests to loopback hosts.

## Telemetry

There is none. The plugin makes no analytics, crash-reporting or update-ping
requests of its own. (Zotero's own add-on update check reads `updates.json`,
like every other plugin.)

## API keys

- **Bring your own.** No developer keys are bundled with the plugin, and none
  are shared between users.
- Stored in the **Mozilla Login Manager** — the operating system's credential
  store. Never written to preferences in plain text, to project files, to logs,
  to notes, or to settings exports.
- Sent **only** to the provider currently configured. Switching providers does
  not carry a key across.
- Never logged. API keys, `Authorization` headers and full request headers are
  excluded from all log output; requests that carry a PDF or a key are logged
  with a zero-length body.

## Caching

Translations are cached locally so that reopening a paper costs nothing. Cache
entries are keyed by file hash, page, language pair, provider, model, prompt
version and a hash of the source text — so changing any of them produces a fresh
translation rather than a stale one. Clear the cache from **Settings →
PaperMirror → 缓存**.

Cache files hold the full translated text, so they are written with owner-only
permissions (files `0600`, their directories `0700`) to keep other local
accounts on a shared machine from reading them. This is best-effort: on Windows,
where POSIX permission bits do not apply, the operating system's own file
permissions govern instead.

Full paper text and full translations are not written to logs by default.

During a reading session, lightweight page archives may temporarily hold both
original text and translations on disk so content can be restored after memory
eviction. Their directory is restricted to `0700` before writing and files to
`0600` where supported, matching the cache's owner-only boundary. Archives are
removed when the session closes. Failed PDF writes or attachment imports also
attempt to remove their temporary export files; cleanup is best-effort.

## Uninstalling

Removing the plugin deletes the private data it created: the local cache
directory (translated text), the API key stored in the Mozilla Login Manager,
and all of the plugin's preferences — including the plain-text fallback key, if
the credential store was ever unavailable and one had to be written. This
cleanup runs only on an actual uninstall, not when the plugin is merely disabled
or upgraded, and it is best-effort — it never blocks the uninstall itself.

## Model output

Whatever a provider returns is inserted as **text nodes only**. HTML and
JavaScript in a response are never parsed or executed.

## Custom and local endpoints

- Custom endpoints must be HTTPS unless you explicitly allow plain HTTP.
- A local-only mode restricts traffic to your own machine.
- The plugin can contact a local model endpoint that you configure, such as
  Ollama. It does not start a local service itself.
- The earlier optional full-PDF BabelDOC bridge was removed in 2.1.6; PDF export
  is performed inside the plugin and does not upload the PDF to that bridge.

## Your responsibility

Sending a paper to a third-party translation service means that service
processes it. Make sure you are permitted to do that with the document in
question, and check the provider's data-retention policy — some train on
submitted content by default.
