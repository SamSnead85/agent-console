# Changelog

## Unreleased

- The lanes pane is never left standing empty: when the day's lanes leave it
  room, the lanes idle for more than an hour fill it, dimmed, under a hairline
  that names them cold, with the rest in the Cold fold; when every lane of the
  day fits with room to spare, the card hugs its rows and this machine's
  Projects fold opens in the room until the reader opens or closes a fold by
  hand; with no lane at all the pane is the hatched void with its reason and
  "Nothing is estimated in its place". The UI probe holds the gap under the
  last row to 48px at 1440 and 1920 on the demo, a synthetic month and a
  four-lane hub.
- Team's alert head prints the day's count from the hub's own counter
  (`alertsToday`), exact, and says "· 100 kept" when the list it draws is
  shorter — never the length of the kept list as the day's figure. Projects'
  sessions, live and subagent counts come from the hub's per-project rollup
  over every lane on this machine, so the band, the strip and the Sessions
  head agree.
- The "24 h" group label over the four day columns has a row of its own inside
  the lane header, whole at every width. The strip's clock, scan note and
  presenter controls sit on a plate of the strip's own dark, so quiet ink reads
  over the brightest part of the artwork; the probe samples the pixels behind
  them and holds 4.5:1.
- Closing a sheet returns focus to the row that opened it inside its own
  container: a Team table row is never mistaken for the band's row for the
  same person, a lane opened with Enter gets its focus back, and a row
  repainted away hands the focus to its section's head, never to the body.
  Focus then survives the next poll: when the Team tables, the band's rows or
  the Projects lists are rebuilt under the row the keyboard is on, its
  successor takes the focus, so a place in a table is never lost to a
  repaint (the probe checks past the next poll).
- While presenting, a person's or project's door (`data-inspect`) carries the
  same opaque token as the address, so no name remains in any attribute; the
  probe scans every attribute value, not only the text.
- One quiet line per pane once any figure in it is a floor — "+ a floor · 3
  messages not counted" under the by-machine rows, in the spend legend and
  beside the class legend — never a bare "+" with no legend, never a zero
  count named as a cause.
- The burn rate's money is in the tokens' unit ($/min beside tok/min, $/s
  beside tok/s; the hour on hover): one denominator per line. The lane
  inspector's context history is a stepped area with the flag threshold as a
  hairline and the peak named, not a row of bars. The Projects Live column
  prints a measured 0 and keeps "—" for unknown. A period read from the daily
  rollup marks sessions "—" per cell with the sentence once in the pane's hint
  and on the column head, and an empty hour prints a counted 0. A long project
  name in an inspector's session rows gives way inside its own cell with its
  whole on hover. The join page's Copy with nothing to copy is drawn out, not
  in the accent.
- `scripts/ui-probes.mjs` no longer waits for a network that is never idle
  (the console polls every two seconds): each page is waited for by its own
  reading, every section fails by name instead of aborting the run, and the
  last line counts checks and failures for the gate to read.
- Every row's activity is the wave: the Console lanes, the Projects and
  Sessions tables, the Team People and Machines tables and the inspector's
  hour draw the same soft line over the chart's light as the activity chart,
  the newest step lit while the row is live, dim when its machine is silent
  or gone; a row with nothing in the window is a flat dotted baseline with
  its reason on hover, never a zero wave. No bar spark remains.
- The Doing column draws coverage, not a boolean (docs/COLLECTOR-CONTRACT.md,
  "What the console shows for them"): tool counts are zero only under
  complete coverage; under partial coverage what is held is a floor, marked
  `+` with the figure and the time sharing began on hover, and nothing held
  is "tool not held since …", unavailable rather than idle; a machine whose
  reporter does not share, does not say, or has not been heard since the
  console started is "tool not shared", "tool not declared" or "tool not
  heard", each with the reporter's own reason. The lane inspector's Tools
  block and the agent tree's foot say the same.
- Team's Machines rows and the machine inspector say what each machine
  shares (alerts over the hour, tool activity over five minutes) — on the
  status line when it shares everything, on a line of its own in warn when
  it does not — and flag entries the console refused for being dated in the
  future, when there are any.
- "No alert" is claimed only from the time alerts are held
  (`alertsCoverage.since`): the Attention hero reads "No alert since 6:38
  PM" with the reason, its stat says "since" rather than "last hour", the
  alerts sheet's caption and Team's alert count say "known since", the
  machine inspector says since when its own alerts are held, and the
  sixty-minute strip is hatched up to that time.
- The Attention card's timeline has an axis row of its own ("60 min ago ·
  2 alerts · now") inside the card's padding, never cut by the card's edge;
  the alert rows above it are one line each, the lane's name giving way with
  the whole row on hover; the stat drops its least important parts whole when
  the caption is tight. The spend spectrum's legend keeps each item on one
  line and flows the items as whole units.
- The Console chart's hatched cap on the step still filling is drawn: its
  rect shared the id `cCap` with the Tokens caption and was never reached.
  The Tokens caption's "daily totals kept since …" note drops whole when the
  caption is tight, with the window's definition on hover.
- Presenting aliases the address of an open inspector (`#team/person/<token>`,
  a token of the session's own, resolved on the way back) and the
  add-a-machine sheet: no name in its people list, stand-ins in the link's
  explanation and the joined line, the restart command stepped back.

- The strip is the approved band's hero again, compact: 76px on the substrate
  with the artwork reading from a third of the way across, the instrument's
  name in the display sans and the view beside it, and everything else on the
  same line. The first band is one height whatever the reading says, so a
  partial estimate's notes never push the lanes down: eight lane rows stay
  whole above their footer at 1440×900 under a real alert load, and the
  compact frame (1280×800, 1366×768, 1024×768) folds the second band to one
  row — the alert and its factor, the cost bar, the burn and its dollars, the
  rest in the alerts sheet — and every caption to its short form, so it keeps
  eight rows too (six is the floor at 1024). The status bar is one line.
- Nothing cut mid-word: the fold summaries and the strip's scope line are
  ordered parts that drop whole from the least important when the frame is
  tight, with the whole line on hover; the tool is a chip before the model
  name, whole at every width; Doing and Machine have the room a tool, its
  recency and its pace need; the "24 h" group label is a bracket over its
  four columns.
- Git nobody could read is a void with the hub's reason everywhere the
  console used to say "0 commits": the Effort and Shipped summaries, the
  Projects figures, the effort line and the fold tables.
- Every money figure with records the reporter could not count is a floor,
  marked with the number ("partial" in the Team tables and the machine
  inspector, "+" in the band's machine rows) and counted on hover; the chart
  legend and the spend spectrum say "est." on every dollar and mark a partial
  estimate.
- The period control moves Team and Projects whole: by tool, by person, each
  row's activity wave and the table heads follow it; thirty days say sessions
  are not kept rather than showing the day's count under a month's caption. A
  folder outside Git, and a period without sessions or branches, are said once
  over the table, each cell a plain void with its reason on hover.
- Closing a sheet returns focus to what opened it even after the rows were
  repainted: the opener is found again by what names it. The context button
  opens the lane's inspector at its Context section (one door, one content),
  and an address opens one sheet at a time. Projects' breakdown card carries
  spend per merge; Projects and Team end where their rows end, never stretched
  into an empty tile, and Team's last card carries the last thirty days, one
  row each — the day's tokens, its share, the machine that carried it — so a
  one-machine fleet on a large frame is still a full instrument. The join
  page names its steps in plain labels, and a link without a code disables
  Copy and says why. On the phone the fold rows alone carry the summaries and
  the state and name stay while the figures scroll.
- `scripts/ui-probes.mjs` counts the lane rows drawn whole above the footer at
  1440, 1280 and 1024, checks caption and status-bar heights, the fold
  summaries and model names for clipping, the 12px floor with a sheet open,
  focus return after a sheet stayed open, and runs against a synthetic month
  beside the demo (`--also`), in CI too.
- The console is a set of instruments on a tray, not a page: every pane is a
  card with its own light, rim and shadow that lifts under the pointer and
  settles under a press, in the dark theme and the light one; the strip that
  names the console sits on the substrate the approved band used. Figures are
  set in the display sans with tabular numerals and quieter units; mono is
  kept for ids, models, branches, hashes and times.
- Every series is a wave. Team's activity by machine and Projects' activity by
  project are layered waves from the hub's own per-machine and per-project
  series at the chart's resolution, and follow the period control with every
  other figure (no more "kept for the hour only"). The burn's last hour and the
  week under the day's figure are waves too. The step still filling is drawn
  at what was measured, with a hatched cap up to what it would be at this
  pace, and the hover says "so far" and "projected".
- The first screen at 1440×900 holds eight lane rows under a real alert load:
  the second band is one height and folds what does not fit behind "n more",
  the lanes card takes the height the bands leave and scrolls inside itself,
  and the four folds (Cold, Projects, Effort, Shipped) become one strip of
  summaries under the lanes that opens each fold.
- Attention leads with the worst alert as its hero — its lane, its tokens in
  five minutes and how many times its own normal — then the rest as compact
  rows; alerts raised earlier today sit under a rule and are never counted as
  live; "no alert" is said only for the machines that share their alerts, and
  the unwatched ones are named.
- Every count is over every lane the hub knows, not the eighty it draws:
  sessions by tool, by person and by project, subagents, and "80 of N shown"
  when the list is cut. Per machine is the hub's own denominator (the
  machines heard in the period, from their own estimates); per person names
  the people with a current machine.
- Every money figure carries its status: a floor is marked "+" and named
  partial, an unpriced one is named, on Projects too; the lanes' four day
  columns carry one "24 h" label whatever the period; coverage a machine's
  version never reported is a void with its reason, never 0; branches and
  sessions on 30 days say "not kept" with the reason; a folder outside Git
  says so once across its Git cells.
- Doing reads from tool activity where a machine shares it — "Edit · 31 s ·
  2/min", "shell failing 3/5" — and says "tool not shared" where it does not;
  the agent tree carries the lane's tool results (ok and error counts).
- Presenting: P (or the palette) swaps every project, branch, machine and
  person for a stable stand-in, hides internal figures and the console's
  addresses, and stamps PRESENTING in the strip.
- Keyboard and screen readers: every lane row is a named, focusable door
  (Enter opens it), J/K and the arrows move focus between rows, closing a
  sheet returns focus to what opened it, the palette is a combobox with a
  listbox and an active descendant, the presenter controls keep one name each
  with aria-pressed, every cell button is a 24px target, and axe-core WCAG
  2.2 AA passes on every page, theme and width (`scripts/ui-probes.mjs`,
  run in CI).
- The join page is built in the console's grammar: the strip, one card per
  step, the command with its check folded behind "Show the check", the
  restart command folded, a theme toggle, and the DEMO stamp only when the
  console says it is a demonstration.
- The Team canvas lists today's alerts by machine under the join links;
  Projects lists Effort and Shipped under the sessions, so no frame stands
  empty. Docked sheets are sized to what they hold. The phone lane row leads
  with the name (its branch on a second line) and fades its right edge while
  there is more to the right.

- The period control moves Team's and Projects' counts and sparklines too.
  `/api/console` gives sessions and tokens by tool, machine and person for
  every period (`laneTotals.periods`), and each machine and person a
  sparkline per period at the chart's own resolution; each Projects row
  carries its sparkline for the requested period. Thirty days are read from
  the daily rollup, which keeps no sessions: their session counts are null
  with the reason, never the day's count under a month's caption.
- Git figures nobody could read are unknown, not zero: with no project in a
  Git repository the console can read, the Projects totals (commits, lines,
  PR-linked commits) are null with the reason, and the screen shows a dash.
- `npm run lint`: every JavaScript file parses and every JSON file is valid.
- Alerts are dated by the transcript line that raised them, not by when it
  was read, and the stall's five minutes are measured on that clock too. An
  alert older than the hour, or raised while a first run replays history, is
  `historical`: listed as earlier, never counted as live, and never a desktop
  notification. A first start over a month of transcripts no longer fills the
  last hour with a month of loops.
- A spike or a stall says how far above normal it is: the session's tokens in
  the five minutes ending with the alert, its own median five minutes over
  the day before, and the factor between them. Every alert names its lane.
- Joined machines can send their alerts (`--share-alerts`) and their tool
  activity (`--share-tool-activity`), each off unless passed, each counts,
  kinds, minutes and salted hashes only (docs/COLLECTOR-CONTRACT.md). The
  console says how many current machines are watched for alerts and names the
  ones that are not, instead of reading their silence as "no alert".
- Shared alerts and activity are counted once, per machine, and only where
  they are covered. Every report says what its run shares (`share`); a
  machine that turns sharing off, a reporter older than 0.4 and the minutes
  before the console last started are unavailable with their reason, never
  zero (`activityCoverage` on each lane, `sharing` on each machine,
  `alertsCoverage.since`, `reason` and `byDevice`). Activity travels as
  contributions with salted ids: a resent report, a later batch that failed
  or a restarted reporter adds nothing, two contributions to one minute both
  count, and the same session on two machines stays two readings. What the
  console has not acknowledged is kept in the reporter's cursor file, written
  with the transcript positions it came from, and sent again under the same
  ids. Coverage starts when the console hears "on", never earlier, since a
  run with sharing off may have read past activity nobody counted; and what
  the reporter's bounded outbox has to drop travels as a loss marker
  (`lost`), so those minutes read partial (`outbox-overflow`), never whole.
- One clock rule for alerts and activity: a minute, an alert or a last tool
  more than two minutes ahead is refused and counted on its machine, never
  stored, so it never becomes "now"; the five-minute window has two edges.
- Claude Code tool results and Codex tool calls reach the activity and alert
  readers. They carry no usage, so the reader used to skip them: most results
  and Codex calls went uncounted, and a stall alert missed the tool successes
  it is measured against. Token accounting still never sees these lines.
- Tool activity, counts only: each tool call is mapped on the machine to one
  of eight kinds (read, edit, shell, search, web, agent, mcp, other) — never
  its name, arguments, output, a path or an MCP server's name — and each
  result to ok or error. Each lane carries its last five minutes of calls by
  kind, its results and its last tool; a machine that does not share them is
  marked as such, not shown as idle.
- Every period is stacked by machine (and, on Projects, by project) at the
  chart's own resolution — 3 minutes, 15 minutes, 2 hours, a day — over the
  same span as the headline, so the bands add up to it. The week is also given
  by this console's local calendar day, with its time zone named.
- Counts over every lane, not only the 80 sent: sessions by tool, machine,
  person and project, subagents, and the lanes the list folds away. A
  subagent whose root last reported more than a day ago is folded under it
  instead of becoming a lane of its own.
- Projects: a project is its folder's hash, so two folders called `app` are two
  rows, each with its parent folder's name; Git is read once per repository.
  Each project's estimate says whether it is priced, partial (a floor) or
  unpriced, and the payload's total says the same. The payload carries the
  whole team's totals for every period at the same clock, and says whether
  its period keeps branches and sessions (30 days does not).
- Per machine names its denominator: the machines heard within the period and
  not removed, from their own figures. A machine whose reporter never said
  what it could not count has unknown drops (null), never 0, and the console
  knows since when each machine has said.
- OTel: a point sent again is dropped by its series and time, cumulative
  points are counted as ignored, and each telemetry source names what its
  token total adds up. A series is its resource, scope, metric and point
  attributes in canonical order, kept only as a salted hash: a retry with its
  attributes reordered is dropped, and two resources (two
  `service.instance.id`s) with the same point at the same time both count.
- `claude-haiku-4-5` prices through its published alias of
  `claude-haiku-4-5-20251001`; every model the benchmark generator writes has
  a price.
- Fixtures and schemas for building against the next payloads:
  `fixtures/console-v0.4.json`, `fixtures/projects-v0.4.json`,
  `docs/console-v0.4.schema.json`, `docs/projects-v0.4.schema.json`
  (`node scripts/api-fixtures.mjs` regenerates the fixtures from the demo).
- README: a "No Node.js?" path under Start here, and the nine standalone
  files listed under Checking a download.
- The day's alerts are counted, not read off the list: `/api/console`
  `alertsToday` counts every alert raised or accepted today, by its own time
  on the console's calendar, and keeps the count in the state directory
  across restarts. The retained list stops at 100 per machine; a busy day no
  longer reads "100 alerts". `kept` names how many the list still holds,
  `lastHour` the live ones of the hour.
- Projects counts sessions as the Console counts lanes: a subagent thread,
  at any depth, is folded into its top-level session, and counted apart as
  `subagents` on each row and on the payload. The Projects band and the
  lanes no longer give two numbers for the sessions on this machine.
- Team's counts for a minute period give every current machine, person and
  tool a row: an hour with nothing in it is a counted 0, and only the daily
  rollup's sessions are null ("not kept").
- A partial interval names its true cause: "console restarted" only when the
  machine's first "on" came within one live report interval of the
  console's start; heard later, or after an "off", it is "sharing started".

## 0.3.0 — 2026-09-25

- Six things the screen said that were not so. On Team and Projects the
  period control sits beside the figure it moves, and the hour chart is
  captioned as the hour it always shows. The spend spectrum's COST and
  TOKENS names sit in their own column beside their bars instead of over
  each other. On a phone the lanes' footer stays in frame under the
  sideways scroller and wraps, the spend legend wraps instead of cutting a
  word, and a lane row leads with state, five minutes, the estimate and
  when it last reported. A model split's names are never cut, and the
  Projects Est. column says its unit once, in the header. Every Attention
  row is a door — to its lane, or to the alert list that carries it —
  by pointer and by keyboard. Projects fills its frame: the sessions behind
  the projects take the height the table leaves.
- Three residuals the final captures still showed. Projects' Effort lines
  wrap their figures whole under the label instead of cutting a 30-day
  estimate or the word after a number. Every row that opens an inspector —
  the machines on Console and in the agent tree, the people on Team, the
  projects' share and spend rows — is a 24px target (WCAG 2.5.8) at the
  same type size. On a phone the hour axis caption takes its own line
  whole, a person's machine row says its status whole under the name, and
  the lanes' state column holds the DEMO stamp inside it beside
  the generated LIVE, IDLE and SILENT states at every width.
- The lane grid fits a 1241–1439px frame whole. The 124px state column
  had pushed the desk grid past the frame at 1366, so the header read L
  for LAST and the Last values were hidden, and at 1241 the Machine
  column too. Between 1241 and 1439 every lane track is held at what its
  widest header or value needs, with an 8px gap: all fourteen columns
  stay, nothing is folded, cut or hidden, and the frame at 1241 still has
  room. The Last column is 60px at every width, the width of a clock time,
  and a silent lane's Last is that time alone — the state column already
  says SILENT — with the sentence on hover. On a phone the four on-screen
  columns sit 8px apart so Last ends inside the scroller, and between 1241
  and 1439 the project name keeps a share of its cell that holds it whole.
- The instrument is denser and says less twice. The lanes carry a Doing
  column (the lane's newest alert, its subagents at work, a cache signal, a
  growing context, or its state in a word — never a prompt or a path), the
  lane burning hardest is outlined, and the lanes' footer stays in frame
  while they scroll. The four token classes read in one order everywhere,
  by price per token. The spend spectrum names its two bars; the burn chart
  hatches the span after a machine went silent, the same way the tokens
  chart does; Attention lists every alert as a row over a sixty-minute
  strip; the week under the day's figure names its busiest day. Team's band
  carries the team's models, tools and messages by person, its tables sit on
  30px rows, Remove confirms inside the machine's inspector, and a silent
  machine's figures are stamped last known. Projects folds Effort into the
  figure pane, drops the Shipped restatement, gives each project its own
  hour and lists the sessions behind it; a cell the hub cannot fill says
  why in a word, never a dash. The status bar carries the reading's
  provenance (price table, what was not counted, retention, scan time). The
  URL carries every open sheet both ways. On a phone the strip is three
  short rows with the presenter controls as glyphs, a lane row opens the
  lane's own inspector, and the Team rows carry tokens, cache and cost.
- The three views are one instrument on a graphite ground, not a navy page:
  panes step off the band with a rim and an inset, the strip is shared and
  names the view, and at desk width the page never scrolls — the canvas of
  lanes and rows scrolls under the band. Team and Projects are bands too:
  the figure, the last hour stacked by machine or by project (the lanes'
  own sparks, regrouped), share bars, then dense rows where every row opens
  its machine, person or project beside the canvas; sheets dock at the right
  and carry the URL. ⌘K reaches every view, machine, lane and action with
  the unreachable ones struck through and reasoned; 1–3, [ ], J/K, ↵, T and
  ? work from anywhere. Every figure carries its source and as-of on hover,
  every generated row its own DEMO stamp, and a phone gets one header line,
  a bottom bar and lanes that scroll sideways under their own header.
- Preserve missing token classes in lane totals, including subagents, and
  leave historical cost unsplit when current rates do not reconcile with its
  saved estimate. The burn chart labels its median as active minutes only;
  local Git no longer divides fleet spend by local commits.
- `/api/console` splits each series step, the period's estimate, and each
  lane's day by token class (`series.*.classes`, `cost.byClass`,
  `lanes[].tokensDayByClass`, `lanes[].costDay`); dollars that cannot be
  told apart by class are carried as `unsplitUsd`, never spread.
- Quote Node entry paths and reporter restart options literally in the platform's
  shell, so special characters in installation or state paths stay part of the path.
- Separate telemetry read and ingest credentials with independent live
  rotation. Exporters must use `metrics-token --scope ingest`.
- Add `policy status --json` for installed-file/source drift checks; protect
  recognized policy writes and ask before uninspected interpreter execution.
  Status explicitly distinguishes installed configuration from runtime proof.

What your agents are doing, not only what they spent: context and cache
health, live alerts and an agent tree in each lane; a project policy you can
apply and remove; optional local metrics; totals that follow the selected
period; and reporters that keep going in the background and survive a
console's restart.

**Upgrading from 0.2.1 or 0.2.2.** Coming from 0.2.1, this release includes
0.2.2's security fixes (below): everyone signs in to the console once more
after upgrading, and a second start proves it holds the console's key instead
of sending it. Upgrade the console before its reporters: a 0.3.0 reporter's
records carry `tier` and `cumulative` keys that a 0.2.x console refuses
(joining pins a reporter to its console's version, so this happens only when a
reporter is upgraded by hand). A console whose machines join over Tailscale or other
carrier-grade NAT addresses (100.64.0.0/10) must now be started with
`--allow-cgnat`. A Prometheus scraper of `/metrics` needs the token that
`metrics-token` prints. The burn is now a fifteen-minute average.

**Seeing what agents are doing**

- **Context and cache health in each lane.** The Context column shows each
  session's latest complete input reading; open it for the last 16 readings,
  growth and possible cache breaks, with a dated list-price estimate of what a
  break cost. These are observed patterns, not a proven cause.
- **Live alerts** for repeated identical tool calls, a spend spike against the
  session's recent median, and spend without an observed successful tool
  result. Thresholds are set with `--alert-repeat`, `--alert-spike-factor` and
  `--alert-stall-minutes`; `--desktop-alerts` opts in to native notifications,
  which name the signal and never include tool arguments. Alerts stay on this
  machine.
- **An agent tree in each lane**: the orchestrator and its subagents, each with
  its model, observed tokens and duration. The outcome is "unknown" until a
  result is recorded; activity is not treated as success.
- **Spend in the window of the work**: Projects shows estimated spend per local
  commit and per integration into the default branch in the same period,
  labelled as correlation, not attribution. Anything unpriced leaves the ratio
  unknown.
- **A shared analysis core**, `@lockedinlabs/agent-console/analysis` (version
  1): the same dependency-free functions the console uses for context health,
  alerts, the agent tree, spend per outcome, the policy file and interop, for
  other Node.js programs. [docs/ANALYSIS.md](docs/ANALYSIS.md) is the contract.

**Project policy**

- **An optional `agent-policy.yaml`** (or JSON) with a published schema and a
  shared parser; unknown fields fail validation.
- **`policy diff`, `apply` and `remove`** (run with the release's full
  command, like every other command; `policy --help` prints the usage) compile the policy into
  repository-scoped Claude Code agents, settings and a local hook, with private
  backups so `remove` restores the files that were there before. Starting the
  console installs nothing. [docs/policy.md](docs/policy.md) says what is
  enforced and what is not.
- All three refuse a symlinked `.claude` path and never write the user-level
  Claude directory, compared by file identity, so a miscased or firmlinked
  path on macOS is refused too. The hook classifies quoted (including `$'…'`),
  wrapped and `sh -c` commands (after `-o`, `-O` and `+` options) and here-strings,
  interpreters on the right of a pipe however they are written, secret files
  handed to any program that prints them, force pushes through git aliases
  and push settings, and deletes after a `cd` or through a symbolic link out
  of the repository. It decides within five seconds on a worker thread and
  asks or denies when it cannot load its classifier or runs out of time.
  `policy remove` says `removed` for files it deleted and takes away the
  directories apply created.

**Metrics and telemetry (opt-in)**

- **`--interop`** adds a Telemetry panel with Claude Code OpenTelemetry and
  AI-gateway token readings, kept apart from transcript totals so a request is
  never counted twice, a local Prometheus `/metrics` endpoint and a Grafana
  dashboard. [docs/INTEROP.md](docs/INTEROP.md) has setup and formats.
- `/metrics` and telemetry ingest take **separate scoped credentials**, printed
  by `metrics-token --scope read|ingest`. Each supports independent `--rotate`;
  the console key itself is never accepted.
  A `--demo` console prints its token at start and stamps `/metrics` DEMO.

**Joining and security**

- **Every command the console and the join page print checks the release file
  against the release's `SHA256SUMS`** before running anything, and keeps the
  checked file in `~/.agent-console/releases/`. The check's SHA-256 is
  published in the README and each release's notes, with a short command that
  prints the SHA-256 of the check in any command pasted into it, so whoever is
  sent a command can compare the whole check. The join page shows the whole
  command (only the code masked), and its restart line is a complete command
  with its own Copy button.
- **A join by link is never held off by other machines' attempts**, however
  many addresses one device uses; the total of sixty per ten minutes guards
  only the typed code, and an address over its own limit does not count
  toward it. A global IPv6 address counts by its /64; a unique-local or
  link-local one counts by itself.
- **Carrier-grade NAT (100.64.0.0/10, also Tailscale's range) is no longer
  private by default.** Start the console with `--allow-cgnat` to accept it;
  the start banner says so when it sees such an address.
- **Signed out, a console can print a new sign-in link** in its own window,
  from the button on its sign-in page or from a second start. A demo console
  can be signed into again without a restart.

**Accounting**

- **Fixed: a message a forked subagent copied from its parent is counted
  once.** Copies, including ones cut off mid-stream, were counted again in each
  fork's file, so input, cache and message counts could be overstated. A
  Claude message is now sent as its running per-class maximum under one id,
  and the console keeps the largest reading it holds, so two machines that met
  a fork's copy in a different order, or a machine that lost its cursor, give
  the same total.
- **A Codex thread resumed by a newer Codex is counted from its records** from
  its first own record on; only a record for a response already counted is
  reported as late.
- **Drops follow their transcripts**: a deleted or replaced transcript takes
  its drops with it, and a line Claude Code rewrites with all-zero usage is not
  a drop.
- **Partial periods say so**: 7 days with `--retention-days` below 7, and 30
  days when usage arrives after its day passed minute retention (counted as
  `pastRetention`).
- **Nothing is dropped silently.** Every transcript line that carries usage and
  cannot be counted is counted by reason, sent with each report, and shown
  beside the figures and on its machine's row in Team, as are records the
  console itself could not keep.
- **Codex per-response usage records are counted**, one per response,
  including requests the running total never shows, such as compaction.
- **Model ids are kept exactly**, including Bedrock and Vertex forms, instead of
  becoming `unknown`. A transcript line too long to read has its usage
  recovered where possible, and is reported when it is not. Usage that grows on
  a line already counted is counted; usage rewritten lower is reported.
- **Consistent period totals.** The period switch (1H, 24H, 7D and the new 30D)
  drives the headline tokens, cost, messages, model list and machine list, and
  Team and Projects offer the same periods with the same edges. The Console
  chart follows the selected period. Team and Projects retain their explicitly
  labelled last-hour activity charts. 30 days come from daily totals the
  console keeps for 400 days, after its minute detail is pruned.
- **Fast mode is priced at its published rates**, and any other service tier
  is left unpriced instead of being priced at the standard rate.
- Input is labelled "uncached input", the cache-write split by lifetime is
  shown, Team shows "no priced model" rather than $0.00 when nothing is priced,
  and the JSON counts priced and unpriced messages and records separately.
- **Projects counts only your commits**: those authored with the repository's
  `user.email`, so a fresh clone no longer credits other people's work to this
  machine. "PRs merged" is now "commits referencing #N", which is what it
  counts.
- The accounting spec is 1.1 and the conformance suite 1.1.0, with a case with
  exact expected totals for each of these. Records carry a new `cumulative`
  key ([docs/COLLECTOR-CONTRACT.md](docs/COLLECTOR-CONTRACT.md)).

**Reporters and machines**

- **`--background` and a periodic mode.** A reporter can keep running after its
  window closes, and one reporting less often than every minute shows as
  "reporting periodically" instead of flapping to silent.
  [docs/BACKGROUND.md](docs/BACKGROUND.md) has launchd, systemd and Task
  Scheduler examples for starting it at login.
- **One reporter per state directory, for its whole life**: a second one is
  refused and names the one that is running. New `stop` command. A lock is
  honoured only for a process that is really a reporter, so a reused process
  id is never refused or signalled. A reporter stopped by `stop` or `leave`
  says so in its own window, and `--once` says it reports once.
- **`leave` tells the console** and stops a reporter running in another window;
  the console shows the machine as having left, not as silent.
- **Joining the same console again keeps the machine's entry and history**
  instead of adding a second machine with the same name, also after `leave`
  when the new link names the same person and machine.
- **Reporters survive a console's port change.** The console keeps its
  reporting port across restarts, and a reporter that loses its console looks
  for the same pinned certificate on nearby ports. A console with a new
  certificate is reported as "certificate changed", not "cannot reach".
- **A second start finds this console on the port it moved to** when the
  default port was busy, instead of starting another console on the same
  data.
- **Removed machines no longer count as silent** in the chart's "incomplete"
  label, the burn's "left out" list or "N of M machines". For two minutes
  after a restart, a machine that was reporting shows as "Reconnecting".

**The console**

- **The burn is the average of the last fifteen minutes**, not five, so one
  burst of agent traffic does not swing it. A lane's "tokens · 5 min" is
  unchanged.
- **One meaning of "session" on every view**: a top-level session, with its
  subagents counted apart, over "the last 24 h" rather than "today". "1 person",
  not "1 people".
- **Pause motion stops the animation, not the data.** Figures keep updating
  while paused, without moving.
- **Add a machine gives the exact command** to restart a this-machine-only
  console on the network. The week's line no longer runs through the hero's
  label.
- **Mistakes are refused, not ignored**: an unknown command (`joni`), an
  unknown option (`--intervall`), a value out of range (`--interval abc`), a
  `--name` or `--person` without a value, and a mistyped `metrics-token`
  option (which no longer prints the token; `metrics-token --help` prints its
  usage). `--help` lists the `policy` command.
- **The Machines panel, lane footer and Team say what they cover**: the chosen
  period, idle lanes hidden after an hour, machines that left apart from ones
  that were removed, and each agent's outcome as "outcome unknown · no result
  recorded" until one is.
- **Input the console changes is said**: a machine name it cannot use, a
  duplicate name for the same person, and a link duration outside 5 to 60
  minutes. With `--json`, errors are JSON lines, and the console prints an
  event when a machine joins or leaves.
**Durability and release acceptance**

- Published installation checks fail on missing packages and run after release
  assets upload. Development availability may explicitly report a pending
  release; it no longer presents a missing download as a verified installation.
- Release packaging verifies the selected source's main-branch ancestry and
  successful CI, public-safety and performance checks before producing assets.
- Usage batches are indexed only after successful persistence. Failed writes
  preserve earlier batches, allow safe retries, and recover incomplete final
  lines before rebuilding the index after a restart.
- Only one hub can own a state directory, including when different listening
  ports or directory aliases are used. A crashed owner's lock can be recovered;
  an owner that cannot be verified is never displaced automatically.
- [Architecture diagrams](docs/ARCHITECTURE.md) document collection, enrollment,
  trust boundaries, delivery controls and the separate future MCP integration.

**Distribution**

- **Standalone executables, for a computer without Node.js.** Each release
  carries one file per platform — macOS (Apple silicon and Intel), Linux (x64
  and arm64) and Windows (x64) — that is Node.js 24 with the release package
  inside. Each is built and started on its own platform in CI, listed in
  `SHA256SUMS` and covered by the release's build attestation. The macOS and
  Windows files are unsigned until a signing identity is configured, and the
  release page says so beside each one; `docs/executables.md` has the
  Gatekeeper and SmartScreen steps.
- Run as a standalone executable, the commands the console prints name the
  executable instead of `node`, by its bare name when `PATH` finds it.
- **Everything is built only after the release's source is authorized.** The
  tag must be a main commit whose own main-push CI, public-safety and
  performance checks passed; then the package, executables and hub image are
  built from it. The package's published-install acceptance still runs if the
  executables fail, and a separate check fails to say they are missing.
- **Install scripts** (`install.sh`, `install.ps1`) fetch the executable for
  the computer and the release's `SHA256SUMS`, and install nothing unless the
  SHA-256 matches. Each release installs its executables with them on every
  platform, checks the version they print, and on Linux their attestation.
- **npm** receives the exact package file on the release, after it installed on
  macOS, Linux and Windows, checked against `SHA256SUMS` and its attestation,
  with npm provenance. A tag push alone publishes nothing; without the owner's
  `NPM_TOKEN` the release says so and skips npm.
- **A Homebrew formula** rendered only from a release's archive checksums
  (`scripts/render-homebrew-formula.mjs`), for a tap the owner creates.
- **A team hub image** for Linux amd64 and arm64 (arm64 built under QEMU), non-root,
  with a `HEALTHCHECK` on its join page. Pull requests build and start both
  architectures; a release pushes only the version tag, after starting it, and
  attests the pushed digest.
- **A download page** (`site/`), built from the latest release's verified facts.
  The standalone executables, npm and Homebrew are shown as "coming" until the
  release, the registry or the tap really serves them. It deploys only when
  GitHub Pages is enabled for the repository.

## 0.2.2 — 2026-09-24

Security fixes, accounting you can reconcile, and a console that is nearly
free when idle. Upgrade from 0.2.1: this release fixes three security issues,
described in advisory
[GHSA-grq6-4rfv-hxhj](https://github.com/SamSnead85/agent-console/security/advisories/GHSA-grq6-4rfv-hxhj).

**Security**

- **The join page checks the whole link before it offers a command.** It
  rebuilds the link from the parts it checked and puts it in single quotes, and
  gives no command for a link it cannot vouch for. The console's commands use
  single quotes too, and the reporter accepts a link with the quotes that
  cmd.exe passes through.
- **Add a machine leads with the command to send.** It is built on the
  console's own computer; the link, which opens a page served over plain HTTP,
  is the alternative. `SECURITY.md` explains the choice.
- **A second start never sends the console's key.** It proves it can read the
  key instead, and prints a sign-in link or opens the browser only for a
  console that proved it holds the same key. Something else answering on the
  port is told nothing, and the second start says so.
- **Each browser has its own session.** Sessions are random, last 30 days and
  end with the new **Sign out**; the console keeps only a verifier of each, and
  a new key ends them all. Each console's cookie has a name of its own, so
  signing in to one console on a computer no longer signs you out of another.
  Everyone signs in once more after upgrading.

**Accounting**

- **[docs/accounting.md](docs/accounting.md)** defines one token event, what
  is counted once (streaming, re-written lines, retries, resumed sessions,
  compaction, subagents, copies), Codex's cumulative counters, classes and
  cache lifetimes, models, windows and time zones, who a session belongs to,
  team roll-up and cost.
- **A conformance suite**, `@lockedinlabs/agent-console/conformance`: synthetic
  logs for five machines and two people, exact expected totals summed from
  ground truth, and the collector's own output for other receivers to replay.
- **Fixed: a streamed Claude response is dated by its first line.** Its later
  increments were dated by their own lines, so a response that crossed a
  window edge was split across two windows.
- **Fixed: a Codex counter that restarts is counted.** The restarting request,
  including every forked child's first own request, was dropped as coverage
  debt.
- **Fixed: "last 24 hours" is exactly the last 1,440 minutes.** The console's
  day included one extra minute and any record dated ahead of the hub's clock.
- The hub keeps 5-minute, 1-hour and unknown-lifetime cache writes apart, and
  `lib/hub/accounting.js` reports exact totals for any whole-minute window by
  team, person, machine, model, session and session tree.

**Performance**

- **Faster, and nearly free when idle.** On a month of heavy history (a
  million transcript lines), the first read takes half the time and half the
  memory, and the console keeps answering while it runs. An idle console used
  a quarter of a CPU core and rewrote tens of megabytes every five seconds;
  it now uses under 3% and writes nothing. Unchanged transcripts are not
  reopened, the cursor no longer grows with history, and lines no record
  reads are not parsed. Every record is byte for byte the same. A benchmark
  on synthetic history (`bench/`) and a budget CI enforces are in
  [docs/PERFORMANCE.md](docs/PERFORMANCE.md).

**How the project is kept**

- **[docs/PRINCIPLES.md](docs/PRINCIPLES.md)**: the bar every change meets,
  and where CI checks it. New checks: the README's install line is run
  against the published release; every console option is started in
  `--demo`; a pull request that changes what people run adds a changelog line,
  and one that changes the interface retakes or confirms its screenshots.
  SECURITY.md now says how quickly a report is answered and fixed.
- **A public-safety gate on every push and pull request.** gitleaks checks each
  new commit and the tree. `npm run check:public` refuses absolute home paths,
  private email addresses, machine network names, credential shapes, image
  metadata, and names on a private denylist that CI reads from a repository
  secret, in files, in every line a commit added, in commit identities and in
  a pull request's title and body. It reports where and which rule, never the
  text. `scripts/public-safety/strip-images.mjs` removes image metadata without
  re-encoding.
- **The privacy canary covers everything that leaves a machine**: whole
  requests (path and headers as well as body), every answer the hub sends
  back, every read the console serves, and the hub's own transcripts, which
  must never leave through the reporting port. A new GET route that the
  canary does not read fails the suite.

**Fixed**

- **About one generated certificate in 256 was invalid,** so a hub could fail
  to start at random.

## 0.2.1 — 2026-09-23

Safer by default, and the fixes from a first-time install.

**Security**

- **Agent Console now comes only from its GitHub release.** The console no
  longer serves the package to machines that join, and every command it prints
  installs the release over HTTPS. From this release on, CI builds each release's
  package with a published SHA-256 and a signed build attestation.
- **Reports are encrypted and pinned.** Joining and reporting go over TLS to a
  certificate the console makes for itself; the join link carries its
  fingerprint, and the reporter talks to that certificate only.
- **The console is signed in, and never on the network.** It listens on
  127.0.0.1 on its own port and needs a sign-in cookie; `--open` and the
  sign-in link printed at start set it. Other machines use a separate port
  (normally 6788) that serves only joining and reporting, refuses callers
  outside private networks unless `--allow-public`, and refuses proxied requests
  to the console.
- **Joining is harder to guess.** Links carry a 128-bit code that lives at most
  an hour; attempts are counted before they are read.
- **The console checks every record's exact shape**, keeps usage one file per
  day, reads it back line by line, and limits each machine to 250,000 records a
  day, so a bad or hostile reporter cannot stop it from starting.
- **The reporter trusts nothing it is sent.** It checks every identifier a
  console returns and strips control characters before printing. Project hashes
  use a key only the reporting machine holds. Leaving out
  `--share-project-names` stops names at once, and `leave` deletes everything
  the enrolment left behind.

**Fixed**

- A machine with a large history now finishes uploading. It keeps every batch
  the console accepted, resumes where it stopped, honours the console's pacing,
  and shows "catching up · N of M records" meanwhile. The console no longer
  shows it as "Reporting · now" until everything has arrived.
- The reporter says what actually went wrong instead of always "cannot reach
  the hub".
- Messages count API responses, not transcript lines (the count was 64% high
  for Claude). Tokens were never affected.
- The burn rate shows "unpriced" instead of "$0.00/hour" for models without a
  verified price.
- A busy port: a second start points at the console already running; another
  program on the default port moves the console to the next free one.
- The first read of a long history shows its progress, and the browser opens
  after two seconds.

**Added**

- Claude Opus 5.5 pricing, from Anthropic's published pricing page
  (checked 2026-09-22).
- `--version`, clearer install steps, the full LockedIn Labs lockup in the
  README, and the community and licence files an open-source project needs.

**Changed**

- Machines that joined a 0.2.0 console join again with a new link.
- The v0.1 detail endpoints (`/api`, `/api/history`) and the embeddable panel
  are gone; the Projects view now reads the console's own data.

## 0.2.0 — 2026-09-22

Many machines, one console. Agent Console now shows the AI coding agents on
every computer you connect, in LockedIn Labs' console design.

- **Connect other computers by link.** One computer runs the console (the hub);
  **Add a machine** makes a join link with a single-use code that expires in 30
  minutes. The other computer opens it and runs one command — `npx` fetches
  Agent Console from the hub itself — and it starts reporting within seconds.
  Each machine gets its own device token, stored privately on that machine and
  kept on the hub only as a verifier; **Remove** revokes it at once. The console
  shows who joined and when.
- **A team view.** The total across every machine, and per machine and per
  person — tokens, share, cache read and cache write shares, model split and
  list-price cost, over 24 hours or 7 days. One person's several machines (or
  several accounts) roll up into one row; a transcript copied between machines
  is counted once.
- **The console, redesigned.** The terminal look is gone. IBM Plex (shipped with
  the package, SIL OFL 1.1), a graphite ground, one cobalt accent, colour only
  for state, light and dark themes. The band shows tokens for the last 24 hours
  with the cache read / cache write / output / input split and each class's share
  of all tokens; tokens over time (1H · 24H · 7D); burn right now in tok/min and
  tok/s with per-model share and spend; and one lane per session with its model,
  hour of activity, five-minute tokens, subagents and machine. Show unavailable
  and Pause motion sit in the band's header. One animation loop, text redrawn at
  most eight times a second, `prefers-reduced-motion` honoured.
- **Gaps shown as gaps.** A machine that stops reporting shows when it was last heard
  from, is left out of "right now" by name, and its lanes read unknown rather
  than zero; the chart marks where it becomes incomplete. A missing token class
  makes a total a floor, and an unpriced model is excluded from dollars and named.
- **The collector.** LockedIn Labs' dependency-free collector is now part of the
  package (`lib/collector/`, with its tests and [contract](docs/COLLECTOR-CONTRACT.md)):
  portable salted record identity, cursors per destination, a write-ahead spool,
  bounded retries, and a verified offline price table covering current Claude
  and OpenAI models.
- **Privacy, proven.** Only counts, model ids, timestamps and salted hashes leave
  a machine. An end-to-end test runs real reporter and hub processes over
  canary-filled transcripts and checks every byte on the wire and on disk.
  `--share-project-names` is the one opt-in, and sends a folder's name, never
  its path.
- **Network posture.** The hub still binds `127.0.0.1` by default. `--listen`
  opens only the join page, the package, the join exchange and token-checked
  reporting to other computers, with a printed warning; the console and every
  administrative action answer only on the hub's own computer.
- **Demo mode** is a synthetic team of five machines, stamped DEMO on every
  view, reading nothing and accepting no machine.
- **Projects** (tokens and Git delivery evidence for the hub's own computer) is
  one click away instead of on the first screen.

Breaking: Node.js 22 or newer is required. The v0.1 session-roster page and its
browser modules are removed; `/api`, `/api/history` and `<agent-console-panel>`
still work.

Limits: the reporter runs while its window is open (no background service is
installed); on Windows, CI covers the hub, collector, joining and reporting but
not yet the Projects view; the hub serves plain HTTP, so use it on a network you
trust or behind a VPN or tunnel.

## 0.1.0 — 2026-09-20

First public standalone Agent Console release. The local observability console
is available without a coordination CLI, ledger, account, or build step.

- Preserve the dark instrument-panel interface, session trees, token composition,
  history, activity signals, and delivery evidence.
- Add verified Fable 5.1/Mythos 5.1 pricing with their model-specific cache rates.
- Preserve unknown subagent costs and exclude metadata journals from agent counts.
- Make legacy coordination opt-in; keep the default demo focused on local usage.
- Add explicit transcript-root configuration and clearer device/Claude scope.
- Add exact bucket details to the history chart on hover.
- Publish installable GitHub release artifacts, source, synthetic screenshots,
  measurement documentation, and automated macOS/Linux checks.

Limits: Codex costs and combined period totals, native installers, multi-device
collection, and team aggregation are not implemented in this release.
