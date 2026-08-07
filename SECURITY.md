# Security Policy

## Supported versions

The latest release is supported. This project is pre-1.0; fixes land on `main`.

## Reporting a vulnerability

Please open a
[private security advisory](https://github.com/wandonwe/papermirror-zotero/security/advisories/new)
rather than a public issue, and allow a little time for a fix before disclosure.

Especially interested in:

- Any path by which an API key could leak — into a log, an export, a note, a
  cache file, or a request to a provider other than the configured one.
- Any path by which content returned by a translation provider could be
  executed rather than displayed as text.
- Any request the plugin makes that a user did not ask for.

## Design commitments

- Bring your own key; no developer keys are bundled or shared.
- Keys are stored in the Mozilla Login Manager (the OS credential store), never
  in plain text in preferences, project files, logs, notes or exports.
- Keys, `Authorization` headers and full request headers are never logged.
  Requests carrying a PDF or a key are logged with a zero-length body.
- Model output is inserted as text nodes only — never as HTML, never evaluated.
- No telemetry. The Zotero database and account details never leave the machine.
- Custom endpoints are HTTPS by default, with an explicit local-only mode.
- The optional local PDF service is restricted to loopback addresses
  (`localhost`, `127.0.0.1`, `::1`) with no override, because those requests
  carry the API key.
