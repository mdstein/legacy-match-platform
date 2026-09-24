# Native launcher artwork

- `news-update.png`: unchanged image supplied by the user in
  `reference-launcher-design.zip`, `public/images/news-update.png`.
  Decorative launcher artwork, not a claim about new game content.
- `wordmark.svg`: B2G paths from the user's supplied `b2g-logo.tsx` component.
- Rank emblems: existing `apps/web/public/ranks/1.svg` through `18.svg`.
  See `docs/third-party-assets.md` for their existing provenance.
- Rajdhani Medium / Bold: Google Fonts' `ofl/rajdhani` directory,
  https://github.com/google/fonts/tree/main/ofl/rajdhani . SIL Open Font License
  retained in `fonts/OFL.txt`. Embedded process-private; no font installation.
- `packed/*.bgra`: deterministic build-time GDI packing via
  `node scripts/build-launcher-art.mjs`. Eight-byte little-endian width/height
  header, then opaque top-down BGRA pixels. No runtime network image downloads.

The reference's synthetic population/ping, fabricated patch notes and
timer-driven launch progress are intentionally not imported as product data.

## 0.2.31 source fidelity

- `avatar.png` and `news-map.png` are unchanged supplied images from
  `reference-launcher-design.zip`, `public/images/`. The soldier is a default
  decorative portrait, not a fetched Steam avatar; the map is editorial artwork.
- Hero packing preserves the original 1024×1024 aspect ratio, eliminating a
  build-time crop before the runtime cover crop.
- Live reference: https://b2g-omega.vercel.app/ . Hover rules were checked in
  `news-section.tsx`, `top-bar.tsx`, and `play-bar.tsx`: 500 ms / 5% hero zoom,
  150 ms control transitions, a filled Play symbol and an active launch spinner.
  Native progress uses Steam's download bytes and the real launch lifecycle.

Source archive SHA-256:
`f0ea14374b6fa3ae96c1a6828a2366ad9b8a9d6001ca4daa2b339d0b9540b096`.

Rajdhani Medium SHA-256:
`12ff7dcfe4c206e3875ac53b1762eab57de6a2fa7f5a86c26b97b88d6591eac2`.
Rajdhani Bold SHA-256:
`691470dd3286a14e9677940d0bf75796179841ba5215cbda1a2c8910a3226afd`.

## 0.2.27 reference type and packing

Rajdhani Regular/SemiBold and Geist Mono Regular/SemiBold are Fontsource
Latin 400/600 normal faces, obtained from the installed @fontsource/rajdhani
and @fontsource/geist-mono packages in the development-only reference harness.
The WOFF2 tables were decoded to TTF with fontTools, with no outline or naming
changes. Rajdhani uses the retained fonts/OFL.txt; Geist uses fonts/GeistMono-OFL.txt.
Both are embedded process-private, never installed into Windows. The shipped
launcher has no Fontsource, Tailwind, React, browser or Python dependency.

Packing now flattens the existing wordmark onto #080a08 and rank emblems onto
#101211 to match the measured reference fields. The supplied hero is unchanged;
its scrim is drawn in native destination coordinates so it stays behind the copy.

- `Rajdhani-Regular.ttf` SHA-256 `4860d575c238dede219f5bae2d0e50d00170ca57852d8f2b5f00ab0d17610be2`.
- `Rajdhani-SemiBold.ttf` SHA-256 `4f4fb0a0b732d4b59d25f185f3963d322b20049c51a4cc95c27c92e3ff7978c4`.
- `GeistMono-Regular.ttf` SHA-256 `615327fd38b366bd17bc0079de3e14683263f5eb5d29e36490db5a2480b0c228`.
- `GeistMono-SemiBold.ttf` SHA-256 `c125ec7e0bdd4586a3eb57adf341485a630f5fda7a0885f93949799b6cbf2b0a`.
