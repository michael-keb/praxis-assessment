# Fonts

| File | Font | Weights |
| --- | --- | --- |
| `geist-sans-latin-wght-normal.woff2` | Geist Sans, © The Geist Project Authors | 100–900 (variable) |
| `geist-mono-latin-wght-normal.woff2` | Geist Mono, © The Geist Project Authors | 100–900 (variable) |

Both fonts are licensed under the SIL Open Font License 1.1, which allows embedding them in
documents such as the standalone `index.html`. Copied on 13 Oct 2026: Geist Sans is the Latin
subset Next.js ships (`next/dist/next-devtools/server/font/geist-latin.woff2`), Geist Mono is
`@fontsource-variable/geist-mono` 5.2.7. Upstream: https://github.com/vercel/geist-font.
`../fonts.css` declares them; `../build.mjs` embeds them.

Until v0.4 the system used Space Grotesk and JetBrains Mono. v0.5 replaced both (see `../README.md`).
