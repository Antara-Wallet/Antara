# ANTARA art direction

## Campaign media kit — October 9, 2026

`media/antara-campaign-2026-10/index.html` is a standalone campaign review gallery, separate from the desktop wallet. It contains four complete, downloadable cinematic PNG banners and editable draft captions. Fonts and the app emblem are bundled for offline use. Changes to captions affect text exports; the finished PNG typography remains part of each generated banner.

| Banner | Message | Artwork |
| --- | --- | --- |
| `art/01-protection.png` | Protection, at the core. | Obsidian sanctuary, silver columns and a cobalt-lit vault |
| `art/02-multisig.png` | One signature isn't enough. | Three sculptural alpha keys around a black marble reserve |
| `art/03-multichain.png` | Your world. Connected. | Ethereum monument and bridges between celestial portals |
| `art/04-sovereignty.png` | Keep your ownership. | Marble Greek guardian with a silver alpha monolith |

All four were generated with the built-in image-generation tool, inspected for legibility and branding, and saved unchanged at their returned dimensions of 1672 × 941. `provenance-protection.json` and `provenance-world.json` contain the exact prompts, reference-image roles, original generated-file paths and output hashes. The current app emblem and cinematic artwork were visual references. These are campaign illustrations, not screenshots or evidence of live security enforcement. The copy does not claim funded acceptance tests, an audit, active geofencing/device enforcement, or working gas sponsorship.

## Protection as the primary product focus

The portfolio's two artwork cards lead to protection layers and independent vault approvals. Protection and Vaults sit immediately after Portfolio in navigation. A dedicated Protection page separates wallet authentication, vault custody, location, devices, withdrawal delays, and recovery; the trading rail is hidden on that page. Generated sanctuary imagery supports the controls without replacing them.

Status labels reflect the evidence available to the interface. Signing in is not evidence of MFA enrollment or a verified vault. Location and device restrictions remain explicitly marked as not enforced in the new signing path. There is no invented security score or global protected badge.

ANTARA retains the generated artwork created under the former AETHRA name. Current assets live in `public/antara`; the original prompts below preserve their wording and source paths as provenance. The rename does not imply that the images were regenerated.

## Interface typography and ornament revision — 2026-10-08

Space Grotesk Variable is the display face for the wordmark, headings, and primary amounts. Inter Variable remains the body and control face, with JetBrains Mono for addresses and small metadata. Fonts are bundled locally. The previous Cinzel and other serif stacks have been removed throughout the current wallet and retained screens.

Decorative wireframe orbits, sidebar astrolabe, circular vault seal, and schematic custody illustration have been removed. Empty wallet states use the generated ANTARA emblem. Crosschain context uses a simple From/To strip with the selected networks and tokens. The generated observatory and sanctuary artwork carries the celestial identity; functional navigation icons and token symbols remain. Surfaces stay black and charcoal, with blue reserved for details.

## ANTARA emblem

`public/antara/emblem.png` is the production ANTARA symbol, generated with the built-in image-generation tool on 2026-10-09. The selected 1254 × 1254 PNG is an opaque render on near-black. Its folded silver alpha / A silhouette and cobalt interior connect the Greek celestial identity with the application's black-and-blue palette. The ANTARA wordmark is rendered separately in the interface. The selected asset was copied without raster editing. Earlier transparent renders introduced edge artifacts; the final opaque rendering preserves the sculptural concept with clean contours and is used directly in the black interface. No image-generation API key is needed at runtime.

Source: `C:/Users/PC/.codex/generated_images/01a11e82-ac22-7d93-95a3-5a9984b335de/exec-97add232-90b2-4046-ba7a-a010cfbc76ac.png`.

Native platform icons in `src-tauri/icons` are packaging derivatives of the selected emblem, including the Windows ICO, rather than a replacement vector mark. To regenerate them from the current asset path, use `npm run tauri -- icon public/antara/emblem.png --output src-tauri/icons`.

Final selected prompt (built-in tool mode, `transparent_background: false`; the earlier alpha emblem was supplied as a concept reference):

```text
Use case: logo-brand.
Reference image role: visual identity and sculptural form inspiration for the final AETHRA wallet emblem. Re-render this exact distinctive brand concept, a sleek Greek capital alpha / A made of elegant interlocked folded silver ribbons with a luminous cobalt-blue inner fold and open triangular aperture.
This is ONE finished premium app-icon artwork on a perfectly solid near-black background (#030508). The background must be opaque and uniformly flat, including the open aperture. DO NOT remove the background. DO NOT produce transparency or a cutout. We want the flawless original render directly against black.
The mark retains the pointed tapering legs, gracefully swept curved crossbar, refined slightly curved outer sides, tactile smooth icy silver planes and one rich cobalt inner plane. Architectural precision, sophisticated cinematic luxury, extreme graphic clarity. Strong recognizable silhouette, spare large planes, no small detail. Frontal, centered in a square composition, 10% empty margin all around. Clean immaculate smooth contours, zero particles, zero flecks, zero white fringe, zero noise along the outline. High quality studio product render of a solid polished silver sculpture, smooth materials, soft contained white light across silver surfaces. Controlled blue highlight INSIDE the symbol only.
No text, no wordmark, no sparkle, no dust, no stars, no planet, no outer glow, no shadows outside the symbol, no vignetting, no decorative frame, no badge, no background gradient, no texture. Solid near-black #030508 background across the entire image. One final beautiful symbol, no alternatives or logo sheets.
```

## Celestial observatory revision — 2026-10-08 (original AETHRA artwork)

Two original, full-bleed 1672 × 941 PNG backgrounds were generated with the built-in image-generation tool (`transparent_background: false`), visually inspected, and copied into the application without raster editing. Both are opaque cinematic artwork with dark left-hand space for live interface content. There is no image-generation API dependency at runtime.

- `public/antara/observatory.png`: a pale Greek goddess with cobalt eclipse and orbital light, with a layered observatory landscape. Source: `C:/Users/PC/.codex/generated_images/01a11f03-1224-73d3-80c3-8a07a44b32d0/exec-e04d8574-41f5-43d6-aded-0aff8f1e5df4.png`.
- `public/antara/sanctuary.png`: a monumental Greek celestial vault portal, stone causeway and silver mist. Source: `C:/Users/PC/.codex/generated_images/01a11f03-1224-73d3-80c3-8a07a44b32d0/exec-3b5045b0-f828-40e8-9383-6733180b82bf.png`.

Final observatory prompt (built-in tool mode):

```text
Use case: stylized-concept.
Asset type: actual finished wide cinematic background artwork for AETHRA, a premium native desktop wallet; not a UI mockup.
Primary request: A breathtaking monumental pale silver Greek goddess marble bust fills the RIGHT THIRD of a 16:9 composition. Her face is in side profile looking toward the upper left. Sculpted flowing hair, serene almost otherworldly expression, strong classical features and intricate tactile stone carving. Behind the head a vast electric cobalt celestial eclipse and a delicate luminous orbit arc, like a blue halo around a distant planet. Infinite near-black navy cosmos, sparse tiny stars and very subtle suspended blue dust, almost no nebula. Chiaroscuro cinematic cinematography, rich obsidian shadows, visible silver stone surfaces, ice blue rim light. An impossibly refined ancient-future observatory atmosphere. Ultra high-end film/game key art with physical, volumetric light and extraordinary depth.
Composition/framing: Landscape 16:9, preferably 2048x1152 or larger. Keep LEFT 52% largely empty very dark uninterrupted navy/black with faint stars for UI overlays. Statue takes right 38%, entire head visible, face at about 75% horizontal and 40% vertical, chest flowing out bottom edge. Keep brightest blue light behind the head on far right. A low mist layer across lower edge adds depth. Do not put statue in middle or left.
Palette: 85% near-black, charcoal and midnight navy, silver marble, selective vivid cobalt.
Constraints: no text, no letters, no logo, no border, no panels, no interface, no watermark. No purple, pink or warm orange. No cartoon, no generic colorful nebula wallpaper. Full-bleed opaque background.
```

Final sanctuary prompt (built-in tool mode):

```text
Use case: stylized-concept.
Asset type: finished cinematic background artwork for the vault section of AETHRA, a premium native desktop wallet, full bleed landscape image.
Primary request: An immense ancient Greek celestial sanctuary suspended in a dark cosmic abyss. The focal architecture is on the RIGHT: a colossal circular portal of machined dark stone and cool silver marble, held between two monumental fluted Greek columns, with a razor-thin ring of electric cobalt light and a mysterious black interior. Subtle ancient Greek geometric engraving without readable letters. A long dark polished stone causeway and steps lead toward the portal, faint blue floor reflections, wispy translucent silver mist around the base. Portal is a sacred secure vault, atmospheric and awe-inspiring. Faraway tiny stars visible beyond the sanctuary. No people. Extreme cinematic depth and tactile stone, physically realistic light, sophisticated blockbuster science fiction world design.
Composition/framing: Landscape 16:9, preferably 2048x1152 or larger. Architecture anchored at 78% horizontal and 50% vertical. Keep LEFT 55% predominantly near-black navy with only very faint depth of columns and fog for overlay text. Wide architectural lens, low viewpoint. At 900x250 banner crop, the ring, columns and silver doorway should still read clearly in right third. Brightest light is a fine blue ring at far right, not a floodlight. The far left should remain beautifully dark with negative space.
Color palette: obsidian black, midnight navy, cool silver, restrained vivid cobalt.
Constraints: no text, no letters, no logo, no UI, no frames, no watermark. No purple, pink, warm orange or oversaturated nebula. Not cartoon, not a video game screenshot with HUD, no characters. Full bleed opaque background.
```

## Existing cinematic imagery

The application keeps the original desktop wallet composition: compact navigation, wallet selector, portfolio balance/actions, asset list, and a side swap panel. Interface surfaces are neutral black and charcoal. Blue belongs to controls, selected details, orbital light, and the celestial artwork; it must not become a broad background wash. Greek glyphs and slow artwork motion retain the celestial theme and honor reduced-motion preferences.

The portfolio header follows the user's compact wallet reference: a shallow charcoal balance card, prominent USDC amount with adjacent privacy control, and four equally sized action pills. The oversized welcome headline is removed. Observatory art is subdued behind a fine contour texture; the Greek inscription and blue accents preserve ANTARA's identity. Disconnected balances remain unknown, and no fictional dollar performance or balance-history chart is introduced. The actions wrap into two columns in narrow windows.

`public/solares/horizon.png` was generated with the built-in image-generation tool and copied into this repository. It remains in the legacy wallet background preset and original onboarding artwork. The current desktop uses the Observatory assets above. No image-generation API key is required at runtime.

Final prompt:

> Cinematic atmospheric background artwork for a dark desktop wallet's compact balance card and onboarding art. Extremely wide 3:1 composition. Vast black-blue outer space; the right third shows a dark planet's curved limb with a thin glacier-blue atmospheric crescent, distant blue-white sun, delicate volumetric haze, and sparse stars. The left two thirds are nearly black navy negative space for interface text. Filmic photoreal orbital cinematography, serene scale, restrained HDR, fine grain, deep blacks, cobalt and ice-blue highlights. No text, letters, interface, logos, borders, neon grids, decorative rings, purple, warm colors, or clutter.

## Helios cinematic revision

`public/solares/helios.png` is the previous cinematic desktop artwork, superseded by the Observatory revision above. It was generated with the built-in image-generation tool and copied into the repository without raster editing. The image is a 1774 × 887 PNG: a photoreal Greek marble bust with cobalt orbital light on the right and black negative space on the left. No image-generation API key is needed at runtime. The original assets remain available for existing references.

Source: `C:/Users/PC/.codex/generated_images/01a11e77-7265-7432-8680-5e19bb28adab/exec-166b5f85-6e01-4598-98ad-5875c9415209.png`.

Final prompt (built-in tool mode):

```text
Use case: stylized-concept
Asset type: premium cinematic background art for a desktop crypto wallet, wide 2:1 landscape composition.
Primary request: A breathtaking, ultra-premium cinematic portrait of an ancient Greek Apollo / Helios marble bust emerging from a pitch-black cosmic void. The sculpture occupies ONLY the RIGHT third of the image, with its crown of curly hair near upper-right, sculpted face turned slightly left in three-quarter view, and shoulders fading into black near the bottom. A precise thin electric cobalt-blue orbital halo sweeps behind the head with an elegant elliptical angle, luminous at the edges and partially occluded by the sculpture. At least the LEFT 55 PERCENT of the entire image must be almost completely flat black negative space, subtly merging into the right-side subject, so actual wallet UI can be overlaid later. No foreground objects or light streaks on the left half.
Style/medium: astonishingly detailed photoreal luxury cinematic 3D art direction, real marble pores and subtle weathering, dark polished stone and satin marble, tactile, sculptural, museum-quality Greek statue, extreme chiaroscuro. The face is dignified and anonymous, not a known person. Fine blue rimlighting across the right face, curls and shoulders, a soft icy-blue grazing light on nose and cheek, most surfaces submerged in velvety black. Sparsely placed star-like particles and subtle volumetric atmosphere only around the bust on the right. Luxurious film-level material response, real shadow depth, restrained atmospheric bloom, tack-sharp facial detail against silky black.
Color palette: TRUE BLACK and obsidian, electric cobalt blue, cold ice-blue highlights, almost no other colors. No purple, no gold, no teal.
Composition/framing: wide 2:1, camera at bust eye level, bust fully visible from crown to upper chest on RIGHT third, face turned toward negative space. The circular halo behind it creates a strong memorable silhouette. No box, frame or vignette border. Image must extend flush to all edges. This is art only, not a website mockup.
Constraints: no words, no text, no typography, no logo, no watermarks, no UI, no buttons, no illustrations, no cartoon, no vector, no cheap neon cyberpunk outlines, no busy galaxy wallpaper, no pastel gradients, no blurry plastic statue. Incredible sophistication and quiet dramatic visual power.
```
