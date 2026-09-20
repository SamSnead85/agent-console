# Contributing

Use Node 18+ and Git. There are no dependencies to install. Run `npm test` and
`npm run smoke:pack` before proposing a release change. Add focused regressions
for usage-accounting or privacy defects; use synthetic fixtures only.

Keep the interface compact and readable. Check changed surfaces at desktop and
phone widths. Every metric needs a source, scope, and definition; unknown is not
zero. Keep new dependencies and background activity justified and explicit.

Submit changes through a pull request explaining the user-visible result and
verification. Do not include local history, transcripts, screenshots of real
sessions, credentials, or customer data.
