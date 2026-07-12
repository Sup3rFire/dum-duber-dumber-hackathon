# Popup palette swap design

## Goal

Replace the popup's current red/pink `Pile on the Crap` palette with poop-brown tones and its purple/lilac `Cut the Crap` palette with a deep, readable mustard-yellow palette.

## Scope

- Update only `popup.html` CSS custom properties and the slider's intermediate gradient stops.
- Apply the brown endpoint to every existing pile-on accent: mode label, endpoint label, and words-piled-on statistic.
- Apply the mustard endpoint to every existing cut-the-crap accent: mode label, endpoint label, words-cut statistic, and settings link.
- Replace the pink and lilac slider transitions with a soft tan and pale yellow respectively.
- Preserve the white background, dark body text, gray muted text, neutral slider center, dimensions, typography, and behavior.

## Palette

| Purpose | Color |
| --- | --- |
| Pile on the Crap endpoint | `#7A4B21` rich poop brown |
| Pile-on slider transition | `#D9C2A6` soft tan |
| Cut the Crap endpoint | `#B59A00` clear piss yellow |
| Cut-the-crap slider transition | `#F1E7A6` pale yellow |

## Verification

Inspect `popup.html` to confirm no red, pink, purple, or lilac accent values remain in the popup stylesheet; ensure all existing `.crap`, `.decrap`, `.add`, `.cut`, footer, and slider styles still resolve through the updated palette.
