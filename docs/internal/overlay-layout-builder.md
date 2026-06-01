# OBS Overlay Layout Builder

**Status:** Planned — not started  
**Priority:** Medium  
**Owner:** TBD

---

## Problem

Hosts streaming to YouTube or recording video get a generic-looking overlay.
There is no way to brand it — no custom background, no logo, no banner, no
color scheme. For creators, consistent visual identity across streams matters.

The overlay is already configurable at the URL level (`?show=speakers,chat,boost`),
but only in terms of which panels are visible, not how they look.

---

## Constraints

- **No new backend.** The server should not store layout configs.
- **OBS compatibility.** OBS opens a browser source at a URL. The layout must
  travel in that URL — localStorage is not shared between the host's browser
  and OBS's embedded browser.
- **Dynamic participant count.** The number of speakers on stage changes during
  a stream. Any layout system must handle 1–8 speakers gracefully.

---

## Approach

### Storage
- Layout config is a plain JSON object saved to **localStorage** (keyed by
  room name or a user-chosen profile name).
- Host can **export** the config as a `.json` file and **import** one.
- When generating the OBS URL, the config is **base64-encoded** into a
  `?layout=<base64>` query param. The OBS overlay decodes it on load.
- The `ObsPanel` (already inside the SDK) generates the OBS URL — it will
  gain a "Customize" button that opens the layout builder.

### URL size budget
A typical Phase 1 config is ~600–800 bytes of JSON, ~1000 bytes base64.
OBS browser sources support URLs up to ~2000 chars without issues. Safe.

---

## Phase 1 Spec — Form-Based Config

No drag-and-drop canvas. A structured form that covers the most impactful
branding options. Covers ~80% of the use case with ~20% of the complexity.

### Layout config schema (JSON)

```ts
interface OverlayLayoutConfig {
  version: 1;

  background: {
    type: 'color' | 'gradient' | 'image';
    color?: string;          // CSS color, e.g. "#0d0d12"
    gradientFrom?: string;
    gradientTo?: string;
    gradientAngle?: number;  // degrees, default 135
    imageUrl?: string;       // remote URL or data URI
    imageFit?: 'cover' | 'contain' | 'fill';
  };

  banner?: {
    imageUrl: string;
    position: 'top' | 'bottom';
    height?: number;         // px, default 80
  };

  accentColor?: string;      // CSS color — used for tile borders, boost overlay

  speakers: {
    template: 'solo' | 'side-by-side' | 'grid' | 'spotlight';
    // spotlight = one large tile + smaller row below
    showNames?: boolean;     // default true
    tileRounding?: number;   // border-radius px, default 12
    borderWidth?: number;    // px, default 2
  };

  chat?: {
    visible: boolean;
    position: 'left' | 'right';  // default 'right'
    width?: number;              // % of overlay width, default 28
  };

  boosts?: {
    visible: boolean;
  };

  watermark?: {
    imageUrl: string;
    position: 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right';
    size?: number;           // px, default 48
    opacity?: number;        // 0–1, default 0.6
  };
}
```

### Builder UI (`OverlayLayoutBuilder` component)

Opened from the `ObsPanel` via a "🎨 Customize" button. Renders as a
portal dialog (same pattern as `SendBoostDialog`).

**Sections:**

1. **Background**
   - Radio: Solid color / Gradient / Image URL
   - Color pickers (solid or from/to for gradient)
   - Gradient angle slider
   - Image URL input + fit selector

2. **Banner**
   - Toggle: show/hide
   - Image URL input
   - Position: top / bottom
   - Height slider (40–120 px)

3. **Speakers**
   - Template picker (4 visual thumbnails: Solo, Side by side, Grid, Spotlight)
   - Show names: toggle
   - Tile corner rounding: slider
   - Border width: slider
   - Accent color picker (shared with boost overlay border)

4. **Chat**
   - Toggle: show/hide
   - Position: left / right
   - Width: slider (15–40%)

5. **Boosts feed**
   - Toggle: show/hide

6. **Watermark / Logo**
   - Image URL input
   - Corner picker (4-quadrant button)
   - Size + opacity sliders

**Footer actions:**
- `Save` — writes to localStorage
- `Export JSON` — triggers download of `.json` file
- `Import JSON` — file input that loads a config
- `Copy OBS URL` — generates the full OBS URL with layout encoded, copies to clipboard
- `Reset to defaults` — clears the config

### Live preview

A scaled-down (e.g. 40%) static mockup inside the builder that updates as
the host changes settings. Uses CSS to render the background, banner, and
placeholder speaker tiles — no actual LiveKit connection needed in the builder.

### OBS overlay changes

`ObsOverlay` already reads `?show=...` from the URL. It will additionally
read `?layout=<base64>` and apply the config:

- Background applied as a CSS style on the root element
- Banner rendered as a fixed strip
- Speaker grid template applied via a CSS class on the stage
- Chat position applied via flex-direction
- Watermark rendered as an absolutely-positioned `<img>`
- Accent color applied as a CSS custom property (`--hh-accent`)

---

## Phase 2 — Full Drag-and-Drop Canvas (future)

- Free-form canvas with snap-to-grid
- Fixed "slots" that participants fill as they join
- Resize handles on every element
- Layer ordering (z-index drag)
- Multiple saved layout profiles
- Effectively a mini StreamElements — several weeks of work

Not planned for any specific milestone.

---

## Open Questions

- Should layout profiles be named and support multiple slots
  (e.g. "Gaming layout", "Interview layout")?
- Should the watermark support text (stream title, social handle)
  in addition to images?
- Should the accent color apply to the boost overlay cards as well,
  or keep them always red?
