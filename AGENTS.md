# AGENTS.md — rules for anyone (human or AI) building in this repo

These rules apply to every change. When a task brief and this file disagree, ask before acting.

## Scope and safety
- One purpose per PR. Design changes are design only; logic changes are logic only.
- Change only the files the task names. Don't explore the whole repo; read the named files, `docs/design/SPEC.md` and the token names in `src/index.css`.
- Client-only work never touches `server.ts`, `src/server/*` or `tests/stage2/*`. If a client task seems to need one of them, stop and ask.
- Never merge, never push to `main`, and never change repository settings, secrets, Firestore rules or CI workflows.
- Never put secrets, tokens, passwords or private URLs in code, commits, comments or docs. This repo is public.

## Behaviour
- Don't change a flow unless the task says to: same handlers, requests and bodies, callbacks, state and hook order.
- Never auto-reload the page.
- Keep every existing user-facing string verbatim unless the task lists the exact change.

## Design and copy
- Follow the D1 design spec in `docs/design/SPEC.md`: tokens only (no raw palette classes or #hex), nothing under 12px, radii from the set, one flat primary button per screen, a 44px Close with `aria-label="Close"`, status shown with a word or icon, not by colour alone.
- Copy is gender-neutral and plain.
- No "e.g." example placeholders unless the task asks for them.

## Before you say "done"
- Run `npx tsc --noEmit` and `npm run build`.
- Run the client tests the task names (`npx tsx tests/client/<test>.mjs`).
- Run the design audit: `node scripts/design-audit.mjs --check`.
- Report the branch and full commit SHA, and which of these checks you ran. What you did not run is unverified; say so.
