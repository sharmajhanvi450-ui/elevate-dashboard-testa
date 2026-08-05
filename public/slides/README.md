# Promo slides

Full-screen poster slides shown on the TV Board between the three data boards.

## Adding a slide
1. Drop the image file in this folder.
2. Add its path to `PROMO_SLIDES` at the top of the script in `public/tv-board.html`,
   e.g. `"/slides/my-poster.png"`.

## Removing a slide
Delete the line from `PROMO_SLIDES` — or just delete the file. A slide whose
file is missing is skipped automatically rather than showing a blank screen.

## Notes
- Landscape images work best; they are scaled to fit (never cropped) on a white
  background, so any aspect ratio is safe.
- Each slide shows for the same 30 seconds as a data board.
