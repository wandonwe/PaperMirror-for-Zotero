# Brand icons

Official vector logos for the translation-service picker, vendored from
[lobe-icons](https://github.com/lobehub/lobe-icons) (`@lobehub/icons-static-svg`,
MIT license). The marks themselves are trademarks of their respective owners
and are used here nominatively — to identify the service the reader is
selecting, nothing more.

Monochrome marks (`openai.svg`, `groq.svg`, `ollama.svg`, `openrouter.svg`)
use `fill="currentColor"`, so they follow the pane's text colour in both
light and dark themes. The rest carry their official brand colours.
`kimi.svg` is `kimi-color.svg` with its white wordmark switched to
`currentColor` (the white original is designed for a dark tile and vanishes
on light backgrounds); the blue accent dot keeps its official colour.

To refresh: `npm pack @lobehub/icons-static-svg`, copy the `*-color.svg`
(or plain mono) variants over the files here, keeping these filenames.
