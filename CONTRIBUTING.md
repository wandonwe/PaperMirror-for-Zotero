# Contributing

Thanks for taking a look. This is a small project with a few firm rules; they
exist because breaking them has already cost real debugging time.

## Ground rules

1. **Never bundle an API key.** Not in source, not in a fixture, not in a
   default preference. Keys are the user's, stored in the OS credential store,
   and sent only to the provider currently configured.
2. **Never log keys, `Authorization` headers or full request headers.** Requests
   carrying a PDF or a key set `logBodyLength: 0`.
3. **Never execute anything a model returned.** Translations become text nodes.
   `innerHTML` is not used for model output, ever.
4. **Do not delete a test to make the build pass.** If a test is wrong, fix the
   test and say why in the commit.
5. **Do not change the plugin ID** (`zotero-bilingual-reader@local`) — existing
   installs are keyed by it.
6. **Keep reader internals in one file.** Anything undocumented that Zotero
   might change lives in `src/reader/zoteroReaderAdapter.ts`.

## Getting set up

```bash
npm install
npm test
npm run dev-install   # builds and installs into a local Zotero profile
```

Zotero 9.0.x is the target. The plugin is a bootstrap extension running inside
`Cu.Sandbox`, which has a fixed global whitelist — `AbortController` is absent,
for instance, and is polyfilled in `src/utils/abortPolyfill.ts`.

## Tests

`node:test`, run through `scripts/test.mjs`. Pure logic — layout, segmentation,
filtering, wrapping — is unit-tested without a DOM; that is deliberate, and new
geometry or heuristics should arrive with tests that state the rule in prose:

```ts
test('a full-width block does not merge the two columns', () => { … })
```

## Commits

Present tense, one concern per commit, and say *why* when the change is not
obvious from the diff. Conventional prefixes (`fix:`, `feat:`, `docs:`,
`refactor:`, `test:`) are used but not enforced.

## Releasing

```bash
npm version patch      # or minor — updates package.json
# sync manifest.json to the same version
npm test && npm run package
git tag -a v0.1.9 -m "…"
```

Update `CHANGELOG.md` in the same commit as the version bump, and attach the
`.xpi` from `dist/` to the GitHub release. `updates.json` is what Zotero polls
for automatic updates; bump it when a release should reach existing installs.
