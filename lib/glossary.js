/**
 * The glossary — every word and number on the screen, defined where it appears.
 *
 * Every displayed state and metric must be derivable at the point of use. The
 * definitions therefore live on the server beside the constants they describe,
 * rather than drifting into separate documentation or presentation code.
 *
 * Two rules keep this honest:
 *
 *  1. Every entry that describes a threshold interpolates the ACTUAL constant
 *     from the module that enforces it. A hardcoded "10 minutes" in prose drifts
 *     away from the code the day someone tunes the constant; an interpolated one
 *     cannot.
 *  2. Every entry says whether the figure is MEASURED (read off disk),
 *     DERIVED (computed from measurements here) or ESTIMATED (priced from a
 *     table that may be stale), and estimates say so in the same breath.
 */

import {
  CACHE_READ_MULT,
  CACHE_WRITE_1H_MULT,
  CACHE_WRITE_5M_MULT,
  PRICE_TABLE_DATE,
  PRICE_TABLE_EXPIRY,
  PRICE_TABLE_SOURCE,
} from "./prices.js";
import {
  AGENT_SWARM,
  FLEET_BURN_FLOOR,
  FLEET_BURN_MULTIPLE,
  IDLE_MS,
  LIVE_MS,
  RUNAWAY_FLOOR_PER_MINUTE,
  RUNAWAY_MINUTES,
  RUNAWAY_MULTIPLE,
  STALL_MS,
} from "./state.js";
import { DEADHEAD_MS, STALL_FLOOR_TOKENS, STALL_WINDOW_MS } from "./stall.js";
import { REGISTRY_STALE_MS } from "./ingest.js";
import { livenessRule } from "./liveness.js";

/** How a figure came to exist. Shown as a badge beside every definition. */
export const KINDS = {
  measured: "MEASURED — read directly off this disk",
  derived: "DERIVED — computed here from measured figures",
  estimated: "ESTIMATED — priced from a bundled table, not a bill",
  declared: "DECLARED — asserted by a person or an agent, not measured",
};

function minutes(ms) {
  return Math.round(ms / 60_000);
}

/**
 * The same short form the screen uses, so a threshold quoted in the reference
 * is recognisable as the figure beside it. Trimming the trailing zeros keeps
 * round constants readable — "500k", not "500.0k" — while an interpolated live
 * threshold reads "22.96M" rather than "22.955036M".
 */
function tokensShort(n) {
  const v = Number(n) || 0;
  const fixed = (value, suffix) => String(Number(value.toFixed(2))) + suffix;
  if (v >= 1e9) return fixed(v / 1e9, "B");
  if (v >= 1e6) return fixed(v / 1e6, "M");
  if (v >= 1e3) return fixed(v / 1e3, "k");
  return String(Math.round(v));
}

/**
 * Build the glossary against the live instrument.
 *
 * @param {object} [input]
 * @param {number} [input.fleetThreshold] the BURNING threshold in force right now
 * @param {number} [input.fleetMedianPerMinute] the fleet's own 60-minute median
 */
export function buildGlossary(input) {
  const options = input || {};
  const threshold = Number(options.fleetThreshold) || 0;
  const median = Number(options.fleetMedianPerMinute) || 0;
  const live = livenessRule();

  const entries = [
    // ---- the liveness rule -------------------------------------------------
    // First entry on purpose: STATE is the leftmost column of the roster and
    // the word the owner reads before any number on this screen.
    {
      id: "liveness",
      term: "LIVE, and what it takes to earn it",
      kind: "measured",
      short: live.short,
      body: live.body,
      window: "recomputed every scan",
    },
    {
      id: "UNKNOWN",
      term: "UNKNOWN",
      kind: "declared",
      short:
        "A session exists on a machine this console cannot scan. Its liveness was not measured, so it is not asserted.",
      body: "This program reads one disk: its own. A session that declared itself from elsewhere is real evidence that a session exists, and no evidence at all about whether it is working right now. Rendering it LIVE, or WARM, or IDLE would all be claims nothing here can support, so the row says UNKNOWN and the facts under it name the machine and the moment of the declaration. If the session also declares a state of its own, that claim is shown as a claim — never promoted to this column.",
    },
    {
      id: "STALE",
      term: "STALE",
      kind: "declared",
      short:
        "A declaration that stopped being refreshed. Shown, not trusted — and never counted as live.",
      body:
        "A registration is expected to refresh itself; after " +
        minutes(REGISTRY_STALE_MS) +
        " minutes without an update it goes STALE. A session that crashed cannot retract its own claim to be running, so an unrefreshed claim has to decay on its own or the roster would keep a dead session live forever. STALE is not STALL: STALL is a MEASURED condition — a live process on this machine whose transcript has gone silent for " +
        minutes(STALL_MS) +
        " minutes — while STALE is only ever said about a declaration.",
    },
    // ---- the health banner -------------------------------------------------
    {
      id: "health",
      term: "the health banner",
      kind: "derived",
      short:
        "One word for the whole fleet. Precedence is strict: anything wrong beats idle capacity, idle capacity beats expense, expense beats normal.",
      body: [
        "ATTENTION — any session is in RUN, DEAD or STALL, or the scan failed, or a model in use has no price row, or a rate limit was rejected.",
        "STALLED — at least one session is LIVE but the whole fleet burned under " +
          tokensShort(STALL_FLOOR_TOKENS) +
          " tokens for " +
          minutes(STALL_WINDOW_MS) +
          " minutes. Paid capacity producing nothing.",
        "BURNING — five-minute fleet burn is at or above max(" +
          tokensShort(FLEET_BURN_FLOOR) +
          ", " +
          FLEET_BURN_MULTIPLE +
          "× the fleet's own 60-minute median × 5). Right now that threshold is " +
          tokensShort(Math.round(threshold)) +
          " tokens per 5 minutes" +
          (median > 0
            ? " (median " + tokensShort(Math.round(median)) + "/min)."
            : " (no median yet, so the floor applies)."),
        "NOMINAL — at least one session is live and none of the above fired.",
        "IDLE — no session's transcript has been written to in the last " +
          minutes(LIVE_MS) +
          " minutes.",
      ].join("\n"),
      window: "five-minute fleet burn, recomputed every scan",
    },
    {
      id: "NOMINAL",
      term: "NOMINAL",
      kind: "derived",
      short:
        "At least one session is live, and nothing is wrong, stalled or unusually expensive.",
      body:
        "A session counts as live while its transcript file was written to within the last " +
        minutes(LIVE_MS) +
        " minutes. NOMINAL is the absence of the other four conditions, not a measurement of its own — it means every alarm above it declined to fire.",
    },
    {
      id: "BURNING",
      term: "BURNING",
      kind: "derived",
      short:
        "The fleet's five-minute token burn crossed a threshold calibrated to its own recent median.",
      body:
        "The threshold is max(" +
        tokensShort(FLEET_BURN_FLOOR) +
        " tokens per 5 minutes, " +
        FLEET_BURN_MULTIPLE +
        "× the fleet's median tokens-per-minute over the last 60 minutes × 5). Calibrating to the fleet's own median is what stops a busy afternoon reading as an emergency. The threshold in force right now is " +
        Math.round(threshold).toLocaleString() +
        " tokens per 5 minutes.",
    },
    {
      id: "ATTENTION",
      term: "ATTENTION",
      kind: "derived",
      short: "Something is wrong, not merely expensive.",
      body:
        "Fires when any session is in RUN (sustained burn above " +
        RUNAWAY_MULTIPLE +
        "× its own median for " +
        RUNAWAY_MINUTES +
        " consecutive minutes, floor " +
        tokensShort(RUNAWAY_FLOOR_PER_MINUTE) +
        "/min, or more than " +
        AGENT_SWARM +
        " sub-agents live), DEAD (a pid this process watched running then watched vanish) or STALL (a live pid whose transcript has been silent for " +
        minutes(STALL_MS) +
        " minutes); or when the transcript scan errored, a model in use has no price row, or the vendor rejected a request for quota.",
    },
    {
      id: "STALLED",
      term: "STALLED",
      kind: "derived",
      short:
        "Sessions are live and the fleet is producing nothing. Idle capacity is the expensive failure.",
      body:
        "Fires when at least one session is LIVE or WARM and the whole fleet burned fewer than " +
        STALL_FLOOR_TOKENS.toLocaleString() +
        " tokens across the last " +
        minutes(STALL_WINDOW_MS) +
        " complete minutes. The banner names the likeliest cause from what is on disk: every sub-agent finished and nobody dispatched more, a live process whose transcript has gone silent (usually waiting for a paste), or a rejected quota.",
    },
    {
      id: "DEADHEAD",
      term: "DEADHEAD",
      kind: "derived",
      short:
        "One session running empty — alive, costing a seat, producing no tokens.",
      body:
        "A session is marked DEADHEAD when a live process is joined to it, no sub-agent is running, and it has produced no tokens for " +
        minutes(DEADHEAD_MS) +
        " minutes. Borrowed from the freight term for a vehicle moving with no load: the capacity is paid for and carrying nothing.",
    },

    // ---- cost --------------------------------------------------------------
    {
      id: "cost",
      term: "est $ / cost",
      kind: "estimated",
      short:
        "An estimate computed on this machine at published API list prices. It is NOT your subscription bill.",
      body:
        "Neither vendor writes a cost figure to disk, so there is nothing to read — every dollar here is this program multiplying measured tokens by a bundled rate table (" +
        PRICE_TABLE_SOURCE +
        ", dated " +
        PRICE_TABLE_DATE +
        ", next review " +
        PRICE_TABLE_EXPIRY +
        "). If you pay a flat subscription, these dollars are what the same work would have cost on the API — useful for comparing sessions to each other, not for reconciling an invoice. Past the review date the figures stay on screen with a drift warning beside them, because inventing a forward rate would be worse than an old one that says so.",
    },
    {
      id: "cache-read",
      term: "cache read",
      kind: "measured",
      short:
        "Reused prompt context. Most models charge " + CACHE_READ_MULT +
        "× the input rate; Fable 5.1 and Mythos 5.1 charge 0.025×.",
      body:
        "Cached context is read again on later requests while the model does work. A high cache-read share is not itself waste: reuse is cheaper than fresh input, although unnecessary context still costs money. Cache share of all tokens is different from input cache reuse (reads divided by reads + writes + fresh input). Compare similar workloads and outcomes; there is no universal target on this screen.",
    },
    {
      id: "cache-write",
      term: "cache write",
      kind: "measured",
      short:
        "Context written into the prompt cache. Billed at " +
        CACHE_WRITE_5M_MULT +
        "× input for a 5-minute entry, " +
        CACHE_WRITE_1H_MULT +
        "× for a 1-hour entry.",
      body:
        "A cache write is the premium paid once so that later turns can be cache reads. The 1-hour class is a SUBSET of cache write, not an addition, and it is priced separately at " +
        CACHE_WRITE_1H_MULT +
        "× — it appears in the row facts, never added into the column total.",
    },
    {
      id: "input",
      term: "input",
      kind: "measured",
      short: "Fresh prompt tokens that were not served from the cache.",
      body:
        "The baseline rate every other class is a multiple of: cache write is " +
        CACHE_WRITE_5M_MULT +
        "× or " +
        CACHE_WRITE_1H_MULT +
        "× this rate, cache read is " +
        CACHE_READ_MULT +
        "× it, and output has a rate of its own.",
    },
    {
      id: "output",
      term: "output",
      kind: "measured",
      short:
        "Tokens the model generated. The most expensive class per token by a wide margin.",
      body: "Thinking tokens are a subset of output and are shown in the row facts rather than added into the column, because they are already inside the output figure.",
    },
    {
      id: "classes",
      term: "the four token classes",
      kind: "measured",
      short:
        "input · output · cache write · cache read. Disjoint, and they sum to the row total.",
      body: "The classes are deliberately disjoint so that in + out + cache-write + cache-read equals the total on every row, for both vendors. Codex reports its cached and cache-write counters as subsets of input; they are carved back out here so the four cells add up to the total the row states. Two further figures — 1-hour cache writes and thinking tokens — are subsets of cache write and output respectively, so they live in the row facts and are never summed into a column.",
    },

    // ---- windows and scopes -----------------------------------------------
    {
      id: "5m",
      term: "the 5M column",
      kind: "measured",
      short:
        "Tokens this session produced in the last five minutes. The only figure on which the two vendors are honestly comparable.",
      body: "Everything else in the roster is scoped differently per vendor — Claude columns are today, Codex columns are the whole thread — but 5M is a measured token delta over the same wall-clock window for both, so it is what the roster sorts on and what the health banner reads.",
    },
    {
      id: "sigma",
      term: "Σ",
      kind: "measured",
      short:
        "Thread-cumulative. Exact, but for the whole life of that thread — never added into a period or daily total.",
      body: "Codex writes cumulative counters per thread rather than per response, so a Codex row's figures cover the thread's whole lifetime. Folding one 1.5-billion-token thread lifetime into a line headed with today's date once made that thread 99.8% of the day. Σ marks every such figure, and every total on this screen excludes them. 'Σ no table' in the cost column means something narrower: the tokens are exact, but no OpenAI price table is bundled here, so no dollar is claimed rather than a zero being printed.",
    },
    {
      id: "burn-units",
      term: "tok/min · tok/s",
      kind: "measured",
      short:
        "One measurement in two units, shown together. tok/min is read; tok/s is that same figure ÷ 60.",
      body: "The burn series is a ring of one-minute buckets, so tokens per minute is read directly off the series and is the native figure. Tokens per second is the same number divided by 60 for display — a different unit, never a different metric, and nothing about the fleet changes when you switch. Both are on screen at once, along with both dollar rates and both medians, so no reading is hidden behind a keystroke: click the burn figure, or press u, to swap which one is large. The choice persists. This explanation lives here rather than on the face of the panel, where it would be four lines of prose wrapped around two numbers.",
    },
    {
      id: "period",
      term: "the period selector",
      kind: "derived",
      short:
        "Every headline total is scoped to the period named beside it, never to 'today'.",
      body: "A fleet that runs overnight looks like it reset each morning when the whole screen is day-scoped. 'project lifecycle' means everything this instrument has a record of — source transcripts still on disk plus persisted five-minute snapshots — across EVERY project on this machine, starting at the coverage date shown under the chart. It is not one project and it is not the age of any repository.",
    },
    {
      id: "dedup",
      term: "dedup ×",
      kind: "derived",
      short:
        "How many usage lines were collapsed per counted response. Above 1.0 is normal and is the bug this instrument exists to avoid.",
      body: "Claude Code writes one API response as several transcript lines — one per content block, plus streaming snapshots — each repeating that response's cumulative usage. A captured validation corpus reproduced a 1.84× overcount when those lines were summed. Lines are collapsed by message id, keeping the element-wise high-water mark, so each response is counted exactly once. 'widest id span' is the largest gap observed between two lines of the same response, and it is published so the de-duplication window can be checked rather than assumed.",
    },

    // ---- progress and attribution -----------------------------------------
    {
      id: "progress",
      term: "project progress %",
      kind: "declared",
      short:
        "A human orchestrator's judgement, read from a file. Not measured, and it can go down.",
      body: "The percentage is written by the orchestrator into progress.json in this console's private history directory and read here unchanged; this console never computes it and never invents one when the file is absent. The TREND beside it is measured: each distinct value observed is appended with its timestamp, so the line is the real history of that estimate, including the days it moved backwards. The counters underneath it — merged PRs, commits, lines — are measured from local git and are the check on the estimate.",
    },
    {
      id: "board",
      term: "the coordination board",
      kind: "declared",
      short:
        "The muster ledger: what each session declared through the CLI, from whatever machine it runs on. Not measured here, and not inferred from anything.",
      body: "Every other panel on this screen measures this disk. This one carries coordination facts that were WRITTEN by a session — a package's id, who holds it, the paths it fenced, the branch and exact HEAD it last checkpointed, what it waits on, and whether its holder's lease has run out. A session on another machine appears here in full, because the ledger travels; that same session's tokens and processes do not, because they were never measured here. A package with no recorded branch reads \"no checkpoint yet\" rather than being drawn as progress, and a ledger that could not be read prints the reason in place of rows — an empty board and an unreadable one are different facts. The states themselves are defined by the protocol: open, assigned, in-progress, completed, released. Only `completed` unblocks a package that declared a dependency on this one; `released` gives the ground back without claiming any work was done.",
    },
    {
      id: "attribution",
      term: "tokens per merged PR",
      kind: "derived",
      short:
        "Token spend in the period divided by PRs merged in the same period. A ratio, not a verdict.",
      body: "Not all work produces a PR. A research session, a review, a debugging session that ends in a one-line fix and a long argument all spend tokens and merge nothing, and they are not 'inefficient' — the ratio is undefined for them, and this console prints no ratio rather than an infinity. Use it to compare like with like, and read it beside lines changed rather than instead of them.",
    },
    {
      id: "authorship",
      term: "by author / by session",
      kind: "derived",
      short:
        "Code is attributed by git author. Tokens are attributed by session, and to an author only where a session declared one.",
      body: "One human drives many sessions, so git authorship alone cannot split token spend. Sessions represented in the shared Muster ledger may declare an author, and those tokens are attributed only when the Console can join that declaration to measured local evidence. Otherwise the tokens are reported as unattributed rather than assigned to whoever happened to commit.",
    },
    {
      id: "roster",
      term: "the roster count",
      kind: "derived",
      short:
        "Sessions observed on this machine, plus sessions declared elsewhere, joined by session id where one was supplied. Every one of them is a row in the table.",
      body:
        "This machine can only scan its own disk, so a session on another machine is invisible to the scanner. Rather than omitting it, a session known from the shared Muster ledger is a row in the roster, carrying its machine and marked DECLARED rather than measured. A compatible retained local registration from an earlier Console installation is joined to a scanned row by session id rather than double counted, and goes stale after " +
        minutes(REGISTRY_STALE_MS) +
        " minutes without an update and says so. The line under the table is the arithmetic behind the count, so it can be checked rather than believed. To include another vendor, laptop, CI job, or human maintainer, have it join the same Muster fleet. The Console shows its shared coordination evidence while leaving host-local process and token measurements explicitly unavailable.",
    },
    {
      id: "cold",
      term: "COLD",
      kind: "derived",
      short:
        "A transcript untouched for over " +
        minutes(IDLE_MS) +
        " minutes. Folded out of the roster by default, and not counted as a session.",
      body: "Most COLD rows are finished Codex threads whose files are still on disk. They are real history and their tokens are real, but they are not sessions anybody is running, which is why the session count and the row count differ. Press c to unfold them.",
    },
    {
      id: "redaction",
      term: "‹redacted›",
      kind: "derived",
      short:
        "A credential shape was found in transcript text and masked on the server before the page ever saw it.",
      body: "Masking happens on the server, immediately before serialization, over the whole payload — not in CSS and not in the browser, either of which would ship the secret and merely hide it. The mark is deliberately visible: it is evidence the filter ran.",
    },
  ];

  const byId = new Map(entries.map((e) => [e.id, e]));
  return {
    entries,
    ids: entries.map((e) => e.id),
    kinds: KINDS,
    lookup: (id) => byId.get(id) || null,
    note: "Every threshold quoted here is interpolated from the constant that enforces it, so this text cannot drift away from the code.",
  };
}

/** The payload shape: no functions, so it survives JSON. */
export function glossaryPayload(input) {
  const g = buildGlossary(input);
  return { entries: g.entries, kinds: g.kinds, note: g.note };
}
