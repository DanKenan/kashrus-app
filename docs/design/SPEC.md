# Shutfey · D1 Design Spec — Ink & Seal · Calm Command

**SIGNED by the design council (Muse, ChatGPT, Tab), Oct 20, 2026.** This file is the law for Shutfey's appearance: a new colour, size, radius, shadow or duration enters only by amending this file in a reviewed PR. It sits under the signed vision ("Ink & Seal · Calm Command", Oct 20, 2026) and adds nothing the vision did not promise. Drafted by Tab from main `8c7093c`, debated in two council rounds, landed by D1 on main `2b1150e`. The council's decisions on the 19 open points are recorded in §11; the two that were Don's (Q2, Q14) were confirmed by Don on Oct 20, 2026 (7:35 AM ET).

D1's own rule: this spec and the tokens enter the repo; **no screen changes**. D1 edits no component or runtime file (not `App.tsx`, `KioskLogin.tsx`, `main.tsx` or any view); later design steps (D2–D7) apply the spec screen by screen, each with before/after screenshots.

What the signed vision already fixes (not open): DM Sans for everything; Frank Ruhl Libre only for Hebrew (the Hebrew date and the lockup); warm paper, espresso ink, one gold accent; gold only for the one main action and for confirmed completion; red/amber/green only for status, always with an icon or words; body never under 16, labels never under 12, bold only for titles and buttons; a designed night palette; motion 120/200/320 ms, one curve, no bounce, no confetti, press on every tap, off for reduced motion; never show success before the save is confirmed; the seal means "done and confirmed by a named person", never "kosher"; small seal + subtle warm tint on done, never a fully gold card; broken seal only for serious states; "Day closed · 1 open" never turns gold; one chime, kiosk only; gender-neutral role wording; screenshots at three sizes and the messy-content test on every redesign; "the spec is the law".

---

## 1. Colour tokens

The app already has these tokens in `src/index.css` (OKLCH, flipping with `.dark`). The hex below is computed from the code's own OKLCH values, so the spec matches what ships today. Contrast is WCAG 2.x, computed (not estimated). AA = 4.5:1 text, 3:1 large text (≥24 px, or ≥18.7 px bold) and UI/graphics.

### 1a. Day (light) — existing tokens

| Token | Hex (from code) | Role | Contrast (computed) |
|---|---|---|---|
| `paper` | #F8F4ED | page background | — |
| `surface` | #FFFEFC | cards, sheets, header | — |
| `sunken` | #F2ECE3 | inputs, wells, selected tab | — |
| `line` | #E0D7CA | hairline dividers (decorative) | 1.41 on surface — decorative only |
| `line-strong` | #C7B9A7 | emphasised borders (decorative) | 1.91 on surface — **not enough for a component edge**; interactive edges use `line-control` (§1c) |
| `ink` | #30241B | main text | 13.74 paper · 14.95 surface · 12.83 sunken ✅ |
| `ink-soft` | #61574C | secondary text people must read | 6.44 paper · 7.00 surface · 6.01 sunken ✅ |
| `ink-faint` | #8D8479 | icons, placeholders, disabled **only** | 3.36 paper · 3.65 surface — **not for text** (UI 3:1 ✅) |
| `gold` | #B97600 | seal fill, focus ring, progress fill, icons | 3.39 paper · 3.68 surface — graphics ✅, **not for text** |
| `gold-deep` | #955500 | primary button fill, gold text/links | 5.35 paper · 5.82 surface ✅ · white on it 5.87 ✅ |
| `gold-ink` | #6F3700 | text on a gold wash | 8.16 on gold-wash ✅ |
| `gold-wash` | #FFECCE | gold tint backgrounds (used in 81 places today) | — |

### 1b. Night (dark) — existing tokens

The app **defaults to the night theme** today (`App.tsx:41`), so for most first-time users this is the face of Shutfey; the spec designs both themes with equal care. (Decision Q2, Don-confirmed: the night default stays; D1 does not touch it.)

| Token | Hex (from code) | Contrast (computed) |
|---|---|---|
| `paper` | #241C15 | — |
| `surface` | #30261E | — |
| `sunken` | #1D1610 | — |
| `line` / `line-strong` | #493C31 / #665546 | 1.39 / 2.08 on surface — decorative only, as by day; interactive edges use `line-control` |
| `ink` | #EFEBE4 | 14.12 paper · 12.43 surface ✅ |
| `ink-soft` | #B9B0A5 | 7.84 paper · 6.90 surface ✅ |
| `ink-faint` | #898075 | 4.32 paper · 3.80 surface — not for text |
| `gold` | #E3A73D | 7.88 paper · 6.94 surface ✅ (text-safe at night) |
| `gold-deep` | #CF9122 | 5.43 surface ✅ · night primary button: ink-dark #241C15 on it 6.17 ✅ |
| `gold-ink` / `gold-wash` | #FED184 / #3F280A | 9.65 ✅ |

### 1c. New tokens D1 would add (unused by screens in D1, so nothing changes visibly)

| Token | Day | Night | Role | Contrast (computed) |
|---|---|---|---|---|
| `ok` / `ok-bg` | #166534 / #E8F3EC | #7BD3A0 / #1E3326 | status: done/ok | day 6.27 · night 7.49 ✅ |
| `warn` / `warn-bg` | #92400E / #FEF3E2 | #F2BE6B / #3A2A12 | status: due soon / attention | day 6.46 · night 8.13 ✅ |
| `bad` / `bad-bg` | #B91C1C / #FDECEC | #F49A92 / #3F1F1C | status: overdue, serious, errors | day 5.66 · night 6.94 ✅ |
| `done-tint` | #FBF3E4 | #382B1C | the subtle warm tint on a done card | ink on it 13.66 day / 11.55 night ✅; vs surface 1.09 / 1.08 (deliberately subtle — the seal carries the meaning, not the tint) |
| `scrim` | #1A120A at 60 % | same | modal backdrop (already used as a raw hex in 13 files) | — |
| `line-control` | #8D8479 | #898075 | the border of an interactive control (input, select, checkbox, outlined button) — its own token so it can move without touching `ink-faint` | 3.65 day · 3.80 night on surface ✅ (WCAG 1.4.11, 3:1) |
| `avatar-fallback` | #955500 (= `gold-deep`) | #CF9122 (= night `gold-deep`) | the background of an avatar whose user has no stored colour; initials in white (day, 5.87 ✅) / #241C15 (night, 6.17 ✅) | ✅ |

Day status values are the ones in Tab's review and the council mock-ups; night values were checked by the council (Decisions Q3, Q4). Contrast is always judged on the actual foreground/background pair in **both** themes, never on one theme or a nearby token.

### 1d. Colour rules
- One accent: gold. Gold appears only on (a) the one primary action per screen, (b) a confirmed seal / done state, (c) progress fill, (d) the focus ring. No gold decoration.
- Text is `ink` or `ink-soft`. `ink-faint` and `gold` (day) never carry text people must read. Gold text by day = `gold-deep`.
- Status colours never stand alone: always an icon **and** a word ("Overdue", "Due 7:30 PM").
- No raw palette colours in new code (no `emerald-*`, `rose-*`, `#hex`) — only tokens. Today the code has ~780 raw Tailwind colour uses (emerald 286, rose 256, white 149…) and 13 files with a raw modal hex; D1 records that baseline with a read-only audit script (`scripts/design-audit.mjs`: counts raw colours, sizes under 12 px and raw durations; prints a table; never rewrites code) and the ratchet rule: **the counts may go down, never up**. Report-only in its own non-blocking CI job for the first PRs; made blocking by a later reviewed PR. (Decision Q9)
- Avatars: the per-user `avatarColor` stays (it is user data); the three fallbacks (#d97706, #b45309, #3b82f6) become `avatar-fallback` when D4/D7 touch those files. Initials on avatars must reach 4.5:1 or use ink text. (Decision Q10)
- Category colours (the OKLCH hue system in `index.css` L165–220) stay as they are; categories are identity, not status, and must never use pure red/amber/green hues for meaning.

## 2. Type

DM Sans (variable, already bundled). Frank Ruhl Libre only for Hebrew. JetBrains Mono only for codes/IDs (already bundled; used 15 times).

| Token | Size / line height | Weight | Use |
|---|---|---|---|
| `text-xs` | 12 / 16 | 500–600 | labels, metadata, chips — **the floor** |
| `text-sm` | 14 / 20 | 400–500 | secondary text, table cells on desk |
| `text-base` | 16 / 24 | 400 | body — **body floor everywhere** |
| `text-xl` | 20 / 28 | 600 | card titles, kiosk body text |
| `text-2xl` | 24 / 32 | 600–700 | screen titles |
| `text-3xl` | 30 / 36 | 700 | desk page titles, big numbers |

These equal Tailwind 4's defaults, so no new utilities are needed for the core scale. `text-lg` (18) is outside the signed scale (7 uses today).

Kiosk display sizes (Decision Q5): `k-body` 20/28 (everything on the kiosk that is not a title) · `k-title` 28/36 (the task name on a kiosk card or expanded row, so it reads at arm's length) · `k-display` 36/44 (PIN dots, names on the PIN screen) · `k-hero` 64/72 (counts) · `k-clock` 128/128 (rest screen clock). Applied in D3a.

Minimum sizes per device: phone and tablet body 16, labels 12; desk body 16, dense table cells 14, labels 12; kiosk body 20, labels 16 (read at arm's length). Nothing below 12 anywhere. Today: 430× 12 px, plus **150× 11 px, 93× 10 px, 18× 9 px, 2× 8 px** — all below the signed floor; recorded as the D1 baseline, fixed in D3a/D4/D6/D7. Weights: 400 body, 500 labels, 600 titles/buttons; 700 only for big numbers and screen titles. Today the code uses `font-bold` 332×, `font-black` 55×; the signed rule ("bold only for titles and buttons") makes most of these later fixes, not D1 work.
- Numbers that update (times, counts) use tabular figures (`tnum`, already exists).
- Uppercase tracked eyebrows: 12 px, 600, +0.08em, max one per card.
- Hebrew: Frank Ruhl Libre (variable, Hebrew subset only), loaded with `unicode-range: U+0590–05FF, U+FB1D–FB4F` so it costs nothing until Hebrew appears; digits and Latin inside a Hebrew run stay DM Sans; Hebrew runs get `dir="rtl"` / `unicode-bidi: isolate` so mixed lines don't scramble. Whether user-entered Hebrew (task names, venue names) also uses Frank Ruhl, or only the Hebrew date and lockup as the log says, is **Q1**.

## 3. Spacing, radius, elevation

Spacing (4 px grid): 4 · 8 · 12 · 16 · 24 · 32 · 48 · 64. Card padding 16 (phone) / 24 (desk, kiosk). Gap between rows 8; between sections 24–32. Touch targets: ≥44 px phone/desk, ≥48 phone primary, **64 px kiosk** (the signed 64 px gold check). Half-steps (`p-3.5`, 14 px) are legacy: allowed where they exist, not in new code. (Decision Q7)

Radius (Decision Q7): `r-sm` 6 (chips' inner bits, focus) · `r-md` 8 (inputs, small buttons) · `r-lg` 12 (cards, buttons — the mock-ups' value) · `r-xl` 16 (sheets, modals) · `r-2xl` 24 (kiosk panels) · `full` (avatars, pills, the seal). Today's 20/28 px one-offs (20 uses) fold into 16/24 later.

Elevation — the existing `tactile-*` utilities, given roles (Decision Q8: three roles; `tactile-3/5` retire in D7):
- `e0` flat — rows inside a card, list items.
- `e1` = `tactile-1` — resting card (99 uses today).
- `e2` = `tactile-2` — raised: sticky header, dropdown, hovered card.
- `e3` = `tactile-4` — modal, sheet, kiosk overlay.
- `tactile-3` and `tactile-5` (21 uses) are legacy; folded in during D7.
- Night: same roles, the existing dark shadows. Never animate `box-shadow` per frame (the existing `lift` rule already says so).

## 4. Motion

| Token | Value | Use |
|---|---|---|
| `dur-fast` | 120 ms | press, toggles, colour changes |
| `dur-base` | 200 ms | fades, small moves, chips |
| `dur-slow` | 320 ms | sheets, the seal settling, page-level |
| `ease` | `cubic-bezier(0.22, 1, 0.36, 1)` | the one curve (already used by `lift`, `slide-up`, `pop-in` and `TaskCardView`) — no overshoot, so no bounce |

- Press: pressable controls (buttons, chips, kiosk keys, cards that act as buttons) scale to **0.97** on press over `dur-fast`; never text inputs, table rows or whole panels. Today CSS uses 0.965 and `TaskFilterBar` a 0.94 spring that can overshoot; both go when D3b/D7 touch them. (Decision Q11)
- No springs, no bounce, no confetti, no shake. (`canvas-confetti` is in `package.json` but imported nowhere — left alone in D1; `animate-shake` is used in 3 places but defined nowhere, so it does nothing today — left alone in D1, resolved in D7: the class is removed, not defined.)
- One soft chime, kiosk only, through the tablet's own volume, never the only signal (the seal and the words carry the meaning); the sound itself is specified and added in D3b.
- Reduced motion: the existing CSS rule (`index.css` L263–268) covers CSS; JS animations from `motion/react` are not covered by it. **Mandatory for D3b** (the first PR that ships JS motion to the spec): wrap the app in `MotionConfig reducedMotion="user"` and verify with reduced motion on. Not in D1, which touches no runtime file. (Decision Q12)
- Loading: skeletons in the shape of the content, never a spinner for content. A button that is saving keeps its size, shows "Saving…" and is disabled; a small inline indicator inside it is allowed. (Decision Q13) Today: 6 `animate-spin`, 5 `animate-pulse`.
- **Success only after the server confirms.** The task toggle today is optimistic (`App.tsx` L508–523): the row flips before the save returns. The rule for D3b: an optimistic row may show the *saving* state, but the seal, tint, chime and "Recorded. Thank you, Moshe." wait for the confirmed response; on failure the row returns and shows the error. This is **display, not logic**: the save request, its timing and the data do not change; only what is drawn before and after the response. Any change to the mutation itself would be a separate functional PR. (Decision Q14, Don-confirmed Oct 20, 2026)

## 5. The seal

One master drawing (drawn in D2), never redrawn per screen. The check inside uses the logo's check stroke.

| State | Look | When |
|---|---|---|
| **Open** | thin ring in `line-strong` (night `ink-faint`), no fill; as a progress ring it fills in `gold` with existing tasks done. The open ring never carries state on its own — the adjacent words are the state | anything not yet confirmed |
| **Saving** | the open ring, no seal yet; label "Saving…" | between tap and server confirmation |
| **Done (confirmed)** | `gold` disc + check in white (day; white on gold 3.71 ✅ as a graphic) or `paper` ink (night; 7.88 ✅), with name + time beside it ("Moshe · 7:42 PM") when the record carries them; card gets `done-tint` | confirmed by a named person, after the server's response |
| **Broken (serious)** | `bad` ring broken by a gap, no check, with a word ("Incident open") | only an explicitly identified serious exception drawn from existing status information (an open incident, a serious alert); routine open tasks, ordinary alerts and minor incidents never get a broken seal |
| **Day closed · N open** | open ring + ink text "Day closed · 1 open" — never gold | only where an existing recorded state establishes that the day is closed; otherwise it is a progress state from existing task data ("3 of 12 done") |

Ordinary errors (wrong PIN, failed save) are **not** seals: plain `bad` text + icon ("That PIN didn't match. 3 tries left.").
Sizes (Decision Q15): 16 (history/ledger rows) · 24 (phone/desk task rows) · 40 (kiosk rows) · 120 (sign-in emblem, splash). Minimum 16; below that use a plain check icon. The 64 px kiosk control is the gold *button*, not the seal.
Never: the seal next to the word "kosher", on a certificate-like layout, or as decoration; a fully gold card.

## 6. Iconography
- `lucide-react` only (already used in 35 files). Stroke 2, the library default — no per-icon stroke overrides. (Decision Q16)
- Sizes: 16 inline with 12–14 px text, 20 with 16 px text and in buttons, 24 in navigation, 32 on the kiosk. Today most icons are 14 px (`w-3.5`, 147 uses) — off this scale; fixed later.
- Icons take `ink-soft` (or `ink-faint` when decorative); status icons take their status colour; an icon is never the only carrier of meaning (pair with a word or an accessible label).
- No emoji in the interface. The seal is the only custom glyph; the logo is D2's.

## 7. Copy and voice
- Short, warm, plain. Sentence case. One idea per line.
- Use names: "Good evening, Moshe." "Recorded. Thank you, Moshe." Undo label: "Undo".
- Errors say what happened and what to do: "That PIN didn't match. 3 tries left." "Couldn't save. Check the connection and try again." Never blame, never codes.
- Time words: "Today", "This shift" — never "Tonight" (venues run mornings and overnight).
- Gender-neutral (Don, Oct 19, rule U/AF): role names or "they/their"; never "his/her". Role words are the app's own: Admin, Coordinator, Mashgiach (plural mashgichim) — "Mashgiach" is the professional title and is used for every person in the role regardless of gender; no pronouns attach to it. (Decision Q17)
- The seal's words: "Done", "Confirmed by Eli", "Day closed · 1 open". Never "kosher", "certified" or "approved" for a seal.
- Hebrew text is shown, not translated; no Hebrew interface (rejected as a feature).
- Product name: "Shutfey" / "Shutfey · שותפי" (lockup, D2). Earlier product names are retired as of D2 (see git history).

## 8. Logo and agency-logo criteria (for D2 and step 12)
- Logo: Don's mark (Oct 14, 2026 — three partners above the pot, with the check), traced to SVG and recoloured to the palette in D2 (V3: ink / gold-deep / gold; night cream / gold-deep / gold). The drawing is not redrawn per screen. Default theme: day (Don, Oct 20 2026).
- Agency logo (step 12, Decision Q18): a **32 px-high bounding box** in the header, proportions preserved, width capped at 120 px; a mark that would be wider or unreadable at that height falls back to the agency's short code in `ink` text. It sits to the left of the Shutfey mark (right in RTL), separated by a 1 px `line` divider; the two carry equal visual weight, not identical dimensions. Never distorted, never recoloured gold, never inside or touching the seal, never on a tinted tile. On phones under 390 px the agency mark collapses to the short code first; the Shutfey mark stays.

## 9. Components (minimum set)
- **Button** primary: `gold-deep` fill, white 16/600 text (night: `gold-deep` fill, `#241C15` text), `r-lg`, 44 desk / 48 phone / 64 kiosk tall. One per screen. Secondary: `surface`, 1 px border, `ink` text. Quiet: text only, `ink-soft`. Danger: `bad` outline, only in settings and confirm dialogs.
- **Input**: `sunken` fill, `r-md`, 16 px text (also stops iOS zoom), visible label above (12–14 px `ink-soft`), focus ring `gold` 2 px, border `line-control` (Decision Q6; applied in D7).
- **Card**: `surface`, 1 px `line`, `r-lg`, `e1`, padding 16/24.
- **Chip**: 24 px tall, `full` radius, 12/600; status chips use `*-bg` + `*` text + icon.
- **Row / task row**: one line by default, two at most, then tap for details; long names truncate with an ellipsis, never overflow; the seal or check sits at the end (start in RTL).
- **States** (button, input, interactive row — every one of them has all six): *focus* — 2 px `gold` ring, 2 px offset, keyboard and tap alike; *hover* (pointer devices only) — `e2` for cards, a `sunken` wash for rows, 4 % darker fill for buttons; *pressed* — scale 0.97 over `dur-fast`; *disabled* — 50 % opacity, no shadow, no press, cursor not-allowed, never removed from the layout; *loading* — same size, label "Saving…" or a skeleton, disabled; *error* — `bad` text + icon under the control, border `bad`, never colour alone.
- **Responsive principles** (layout itself is D3a/D4/D6): 320 px is the minimum width that must not break; 390×844 is the reference phone; 1024×768 the tablet and 1180×820 the kiosk tablet; 1440×900 the desk. Content reflows, never shrinks below the type floor; one column under 640 px; the primary action stays reachable by thumb on phones (bottom 40 % of the screen).

## 10. Screenshot and messy-data rules (added to the pre-review checklist)
- Every PR that changes appearance attaches screenshots at **390×844 (phone)**, **1024×768 and 1180×820 (tablet/kiosk)** and **1440×900 (desk)**, day **and** night, before and after.
- Each is taken with the shared messy-content set (`shutfey-d1-messy-content-fixtures.txt`): 100-character task names, 15+ kiosk tasks, Hebrew and mixed-direction text, two-line venue names, several alerts at once, empty records, long incident text, larger text (browser zoom 200 % / iOS largest), reduced motion on.
- A design that only works with sample data is not finished.
- **The spec is the law:** a new colour, size, radius, shadow or duration enters only by amending this file in a reviewed PR; reviewers reject raw values. A PR that adds a raw colour or a size under 12 px fails review.
- A screenshot that cannot be taken as specified (a state that needs hardware, a flow that needs a paired device) is **documented in the PR as an exception**, never manufactured or faked.
- D1 itself produces screenshots **identical** to main (pixel diff = 0) at phone, tablet and desk, day and night; the only allowed difference is the removed Plus Jakarta Sans request, which draws nothing. (Decision Q19)

---

## 11. Council decisions on the 19 open points (Oct 20, 2026)

| # | Decision |
|---|---|
| Q1 | Frank Ruhl Libre for the Hebrew date and the lockup only, through the `font-hebrew` utility; never appended to `--font-sans`, so user-entered Hebrew keeps the system sans. Revisit after real Hebrew data is seen. |
| Q2 | **Don-confirmed (Oct 20, 2026: "Either")**: night stays the default theme; D1 does not touch `App.tsx`. |
| Q3 | Day status colours: #166534 / #92400E / #B91C1C (the review's values, AA by day). |
| Q4 | Night status colours: #7BD3A0 / #F2BE6B / #F49A92 (checked, 7.49 / 8.13 / 6.94). |
| Q5 | Kiosk sizes 20/28/36/64/128; task name on a kiosk card = `k-title` 28; everything else `k-body` 20. Applied in D3a. |
| Q6 | A dedicated `line-control` token for interactive edges (day 3.65:1, night 3.80:1 on surface). Applied in D7. |
| Q7 | Radius 6/8/12/16/24/full; spacing half-steps and 20/28 px radii are legacy, not for new code. |
| Q8 | Three elevation roles (`tactile-1/2/4`); `tactile-3/5` retire in D7. |
| Q9 | Read-only audit script + ratchet (counts never go up), report-only in a non-blocking CI job first. |
| Q10 | Dedicated `avatar-fallback` token, D1 value = `gold-deep`. Stored per-user colours untouched. |
| Q11 | Press-scale 0.97 on pressable controls only. |
| Q12 | `MotionConfig reducedMotion="user"` is mandatory for D3b, not D1. |
| Q13 | A small inline indicator inside a saving button is allowed. |
| Q14 | **Don-confirmed (Oct 20, 2026: "Ok")**: "success only after confirmation" is display, not logic — request, timing and data unchanged; D3b draws Saving… until the response, then the seal. |
| Q15 | Seal sizes 16 / 24 / 40 / 120; the 64 px kiosk control is a button. |
| Q16 | Icon stroke 2. |
| Q17 | "Mashgiach" stays as the neutral professional title. |
| Q18 | Agency logo: 32 px bounding box, proportions kept, 120 px max width, short-code fallback, left of the mark (right in RTL) with a 1 px divider. |
| Q19 | D1 visual budget: zero pixel change; only the unused Plus Jakarta Sans request is removed. |

## 12. Recorded for later (not D1)
- `animate-shake` (3 uses, undefined) — remove in D7. `tactile-3/5`, radius 20/28, `text-lg`, sizes under 12 px, `font-black`, raw `emerald/rose/white` colours, the three avatar fallbacks, the raw modal hex (13 files) — fixed by the D-step that touches each screen; the audit script tracks the counts.
- `MotionConfig reducedMotion="user"` — D3b. The chime — D3b. The optimistic toggle's display — D3b (Q14).
- `canvas-confetti` in `package.json`, unused — removed by whichever PR next touches dependencies.

Signatures: Agreed — Muse · Agreed — ChatGPT · Agreed — Tab (Oct 20, 2026).
