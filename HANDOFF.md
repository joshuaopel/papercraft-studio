# Papercraft Studio — Claude Code Handoff

## What this is

A browser-based papercraft miniature designer. Generates print-ready unfold sheets for dungeon-themed paper minis in the style of [this Etsy listing](https://www.etsy.com/listing/1681832544/dnd-goblin-camp-papercraft-printable). User adds parts (cubes, arm flaps, armor shells, accessories), controls dimensions, uploads images or colors per face, and exports a 300 DPI PNG sheet ready to print, cut, and fold.

Includes an AI pipeline that takes a concept image and generates per-face images via OpenAI (GPT-4o vision → DALL-E 3).

## Current state

Single-file React component at `papercraft.jsx`. Works in artifact previews but the OpenAI calls fail in the sandbox — that's why we're moving it to a real local project. The component itself is correct; only the runtime environment needs to change.

## What I want you to do first

1. **Scaffold a Vite + React project** in this folder (or a subfolder, your call)
2. **Wire up `papercraft.jsx`** as the main app
3. **Install dependencies** — the file imports from `react` and `lucide-react`, nothing else
4. **Get `npm run dev` working** and confirm the page loads
5. **Set up an `.env.local`-based OpenAI key flow** so the key isn't pasted into the UI every session — read it from `import.meta.env.VITE_OPENAI_API_KEY` and prefill the input if present. Keep the manual paste option as a fallback.

## Architecture decisions already made (don't re-derive these)

- **Single file by design** — easier to iterate on, easier to share. Don't split into 47 components unless I ask for it.
- **No build-time CSS** — styles are inline objects + one global CSS template string. Keep it that way.
- **Canvas-based rendering** — the unfold sheet is drawn to a `<canvas>` element. Don't switch to SVG; canvas is what makes the PNG export trivial.
- **Part topology is intentional**:
  - `cube` = 6 faces, cross unfold with tabs (standard papercraft layout)
  - `flap` = 2 faces side-by-side with top connector tab (for arms — F is outside of arm, B is inside)
  - `armor` = 4-face band (F/R/B/L) with closing tab, open top and bottom so it slides over a cube
  - `accessory` = same as flap but labeled differently (sword/shield/hat)
- **Layout uses `partMetrics()` to compute true bbox including tabs** — this was a bugfix. Don't shortcut around it.
- **Image fit on faces is "cover"** (preserve aspect, fill the face, crop overflow) — not "stretch."
- **AI pipeline is two-step**: GPT-4o vision writes per-face descriptions + a global style prompt, then DALL-E 3 generates each face image. DALL-E URLs expire in ~1hr so `applyGeneratedImage` fetches the image and converts to a base64 data URL before storing it on the face. Don't change this without understanding why.

## Known limitations / things I haven't done yet (open questions)

These are things to leave alone unless I explicitly ask:

1. **Armor doesn't auto-size to the body underneath.** If user resizes body, the armor stays its default. I want this eventually as a "Snap to body + 7mm" button on armor parts, but not yet.
2. **No serialization.** State is in-memory only. No save/load of designs. Would be nice to add a JSON export/import.
3. **Reference-conditioned image generation isn't possible with DALL-E 3** — it can't see the concept image, only descriptions of it. Replacing DALL-E with `gpt-image-1` or a Replicate Flux endpoint would give true reference matching. Don't do this yet.
4. **Tents, cylinders, pyramids** — not supported. Only dungeon-dweller minis for now.
5. **No undo/redo.** Probably want this eventually.
6. **PDF export** — currently PNG only. PDF would need `jsPDF` or similar. PNG prints fine, so this is low priority.

## File structure I want

```
papercraft-studio/
├── .env.local                 # VITE_OPENAI_API_KEY=sk-...
├── .gitignore                 # include .env.local
├── package.json
├── vite.config.js
├── index.html
├── src/
│   ├── main.jsx
│   ├── papercraft.jsx         # the main component (already provided)
│   └── index.css              # can be empty or just reset styles
└── HANDOFF.md                 # this file
```

## What to verify before saying "done"

- [ ] `npm run dev` starts cleanly
- [ ] Page renders with default Body + Head parts in the unfold sheet
- [ ] Adding/removing parts works
- [ ] Resizing dimensions updates the preview without clipping tabs
- [ ] Uploading an image to a face shows on the unfold
- [ ] **Most importantly:** OpenAI calls succeed when `VITE_OPENAI_API_KEY` is set in `.env.local`. Test with the concept image and a simple character description. The vision step should complete in ~10 seconds, then face images generate sequentially.
- [ ] Export PNG produces a printable sheet with all tabs visible

## Things I might ask for next (so you can think ahead)

- A "Snap armor to body" auto-sizing button
- Save/load designs as JSON
- Multiple characters on one sheet (a goblin camp, like the Etsy listing)
- Better preview — a 3D-ish folded preview alongside the flat unfold
- Switch to `gpt-image-1` for true reference-matched image generation

## My context (so you know who you're working with)

I'm a 20+ year game industry vet — AAA 3D art, then a decade at Accenture Song running AI/3D R&D. I prototype in Lovable, Bezi, and similar. I know my way around frontend, just don't want to babysit scaffolding. Be direct, skip the explanation of what `npm` is. Show me the diffs and the commands, not a tutorial.

When something is genuinely uncertain or you've made a judgment call, call it out. Don't bury caveats.
