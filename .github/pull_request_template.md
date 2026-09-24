## What changes for the user

<!-- What someone running the console, or a reporter, will notice. Screenshots from `--demo` only. -->

## How it was verified

- [ ] `npm test` passes (it runs on Linux, macOS and Windows in CI)
- [ ] Changed screens checked at 1440×900, 1280×800 and phone width, in light and dark, from the keyboard, with no console errors (or: no UI change)
- [ ] Anything new is visible in `--demo`

## The bar ([docs/PRINCIPLES.md](../docs/PRINCIPLES.md))

- [ ] No runtime dependency added; nothing new runs at install
- [ ] No request to any host the user did not point the console at
- [ ] Nothing new leaves a machine, or: it is opt-in, `docs/COLLECTOR-CONTRACT.md` names it, and the privacy canary in `test/hub-e2e.test.js` reads it
- [ ] Figures still reconcile with the conformance suite; unknown is never shown as zero
- [ ] A line under Unreleased in `CHANGELOG.md`, or: [ ] No user-visible change
- [ ] Screenshots under `docs/` retaken from `--demo`, or: [ ] The screenshots still match

## Public-facing only

This repository is public: the diff, every commit in it, and this description are published.

- [ ] Fixtures and screenshots are synthetic: no real transcripts, and no paths, hostnames, usernames, email addresses, tokens or join codes
- [ ] No names of people, customers or internal projects, and no internal work codes in the title
- [ ] Images carry no metadata (`node scripts/public-safety/strip-images.mjs <file>`)
