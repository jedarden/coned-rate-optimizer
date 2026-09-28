# Analytics — the privacy contract

Bead `conedrat-291cf831` · 2026-09-28

The site intentionally uses **Cloudflare Web Analytics** — cookie-less, no
fingerprinting, no cross-site tracking — to answer two questions: how many
people visit, and whether they can get through the core flow (load the sample,
parse a file, succeed). Anonymous pageview and interaction events may reach
Cloudflare. This document is the contract for the second part: which events may
be sent, what they may contain (nothing but a name), and how both are
mechanically enforced. The GBC data-handling boundary lives separately in
[`gbc-data-boundary.md`](gbc-data-boundary.md). The boundary is precise:
**file imports make no application-server data request, and no file, usage, or
billing content is sent to the application server or included in analytics.**

## The contract

**File-path boundary.** Loading the static app and rate data still makes the
ordinary requests needed to render the page, but importing a local file never
uploads the file or parsed usage/billing data to this site's application
server. The Cloudflare beacon is a separate, intentional analytics path: it
may receive an anonymous pageview and the bare allowlisted event names below.

**One sender.** The only code allowed to touch the Cloudflare beacon sender
(`window._cf`) is `public/analytics.js` — the choke point. The page loads the
beacon itself with a bare site token; nothing else on the page references
Cloudflare's endpoint.

**Three events, name-only.** The complete allowlist:

| Event | Fires when | Fields |
|---|---|---|
| `sample_click` | the visitor pressed "Try the sample data" | **none — the bare name only** |
| `parse_success` | a usage file (or the connected feed) parsed and rendered | **none — the bare name only** |
| `parse_error` | a usage file failed to parse | **none — the bare name only** |

An event is a single static string passed to the beacon and nothing else: no
second argument, no dimensions, no properties, no values. That means:

- **No interval data** — no kWh readings, timestamps, or load shapes.
- **No billing data** — no dollar figures, totals, or bill components.
- **No account identifiers** — no ConEd account numbers, meter ids, or profiles.
- **No tokens** — not the GBC access token, not the analytics token (that one
  is public-by-design: it ships in the page source), never the former.
- **No filenames** — `parse_error` is the tempting one: the on-screen message
  names the file and the parse fault, and the event carries *none of it*.
- **No raw file content** — never a snippet, prefix, or sample of your export.

**Names are static, or they don't ship.** An event name may never be composed,
suffixed, or concatenated from runtime data. `analytics.track()` drops any
name not on the allowlist — a composed name fails closed — and discards every
argument after the name, so no future caller can attach a payload without
changing this file (and its tests) deliberately.

**Fire-and-forget.** If the beacon is absent — blocked by the visitor or the
feature-detect failing — tracking is a silent no-op. Analytics can never
error the page or block the analysis.

## How it's enforced

`test/analytics-privacy.js` (part of `scripts/definition-of-done.sh`, hence
also of the deploy gate) proves the contract rather than trusting it:

1. **Allowlist equality** — `ALLOWED_EVENTS` in `public/analytics.js` is
   exactly `{sample_click, parse_success, parse_error}`; no undeclared event
   can exist.
2. **Name-only send** — with the sender stubbed, each allowed event arrives as
   exactly one call with exactly one argument: the bare name.
3. **The contamination battery** — every forbidden class above (filename, raw
   fixture content, an interval row, billing figures, an account id, a GBC
   token, the parse-error message) is offered to `track()` as extra arguments
   for all three events; the test asserts none of it reaches the sender.
4. **Fail-closed names** — composed names (`'parse_error_' + filename`), a
   filename used as a name, empty/missing, and typo'd names are all dropped.
5. **Static scan** — across every `.js` file in `public/` and `functions/`,
   the sender (`_cf`, `cloudflareinsights`, `sendBeacon`) is touched only
   inside `analytics.js`; the choke point can't be bypassed.
6. **Call-site shape** — every `.track(` call site passes a single static
   string literal, and the set of literals equals the allowlist, so the code
   and this document cannot drift apart in either direction.
7. **Beacon config** — `index.html` carries exactly one beacon whose
   `data-cf-beacon` config is `{"token"}` only.

Adding an event is a deliberate, reviewed act: a new `ALLOWED_EVENTS` entry
plus a new static call site — and this document updated in the same change, or
tests 1 and 6 fail. Adding *fields* is impossible without rewriting the
choke point, which tests 2–5 reject.

## Why so sparse

The funnel needs only counts: how many tried the sample, how many parses
succeeded, how many failed. Those three numbers say whether the product works.
Anything more specific — *which* file failed, *whose* usage was big, *what* a
bill totaled — would buy nothing for the product. The raw file, parsed usage,
and billing contents remain on the device; the deliberate exception is only
the anonymous pageview/allowlisted event signal described above.
