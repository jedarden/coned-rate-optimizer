#!/usr/bin/env bash
#
# starvation-triage.sh — deterministic triage of NEEDLE pluck starvation alerts.
#
# A pluck starvation alert ("Pluck found no candidates but open beads exist")
# is self-refuting when its own embedded counts read "**Open beads:** 0". This
# script resolves such a bead with no human input by (1) detecting the
# workspace's bead backend, (2) enumerating ground truth with explicit
# per-status queries, (3) reading the pluck diagnostics artifact
# (.beads/diagnostics/pluck-diagnostics.json) for what pluck sees NOW,
# (4) running `bead doctor`, and (5) applying a fixed decision rule. It only
# ever drives the bead CLI — it never touches anything under .beads/ by hand.
#
# Usage:
#   starvation-triage.sh --bead <id> [--workspace <dir>] [--apply]
#                        [--limit N] [--json-out <file>]
#                        [--plucks-json <file>]
#
#   --bead ID        The starvation-alert bead to triage. Required.
#   --workspace DIR  Workspace holding the bead store (default: cwd).
#   --apply          Act on the decision (close a false positive, or annotate
#                    an alert that must stay open). Without it the script only
#                    classifies and prints what it would do.
#   --limit N        Per-query row cap passed to `bead list` (default 10000).
#                    If a query returns this many rows the counts are treated
#                    as truncated and no close is performed.
#   --json-out FILE  Also write the machine-readable result as JSON.
#   --plucks-json FILE  Read pluck evidence from FILE instead of the live
#                    artifact. Testing override only; production runs read
#                    <workspace>/.beads/diagnostics/pluck-diagnostics.json.
#
# Decision rule (deterministic, no human input):
#
#   not starvation-shaped            -> classify NOT_STARVATION_ALERT, never act
#   already closed                   -> classify from the alert's embedded data
#                                       only (EMBEDDED_ZERO -> FALSE_POSITIVE_
#                                       CLOSED, else CLOSED_NEEDS_REVIEW); no
#                                       action either way
#   doctor unhealthy                 -> DOCTOR_UNHEALTHY, no close (counts may
#                                       be unreliable)
#   list output truncated            -> LIST_TRUNCATED, no close
#   fresh pluck evidence (artifact
#   age <= 86400s), final_candidate_
#   count > 0, ready_frontier OK,
#   open beads exist (excl. alert)   -> FALSE_POSITIVE_PLUCK_LIVE — pluck is
#                                       finding candidates despite open beads,
#                                       so the alert's starvation claim is
#                                       refuted by present-day evidence; on
#                                       --apply, close citing the artifact
#   fresh pluck evidence, final_
#   candidate_count == 0, work in
#   progress                         -> GENUINE_STARVATION_PLUCK_LIVE — a real
#                                       starvation; on --apply, attach the
#                                       artifact counts and leave open so the
#                                       normal dispatch path acts on it
#   otherwise (stale/absent/no
#   evidence), open beads (excluding
#   the alert bead itself) == 0      -> FALSE_POSITIVE; on --apply, close with
#                                       the evidence: per-status counts, doctor
#                                       result, and the contradiction between
#                                       the alert's prose and its embedded data
#   otherwise, open beads exist
#   (excluding the alert bead)       -> EMBEDDED_ZERO_BUT_WORK_EXISTS (embedded
#                                       count 0) or GENUINE_STARVATION — stale
#                                       or real but not dismissible; on
#                                       --apply, attach the per-bead list and
#                                       leave the alert open for normal dispatch
#
# Pluck evidence is only trusted when the artifact is fresh (<= 86400s old, to
# match NEEDLE's fingerprint-suppression window) and `bead doctor`'s
# ready_frontier scope reads OK; anything else falls through to the
# ground-truth-only branches above, which never close a workspace that still
# holds dispatchable work.
#
# Exit codes:
#   0  triage decision reached
#   2  usage / target-bead error
#   3  backend detection failed (no bead command was run)
#   4  revision conflict while applying (re-run to retry)
#
# Backend detection (before ANY bead command — the CLIs are not
# interchangeable and running the wrong one silently corrupts the store):
#   .beads/config.json + `bead_cli: backend: bead-rs` in .needle.yaml -> bead-rs (`bead`)
#   .beads/config.yaml                                                -> bf (unsupported here)
#   both markers, or neither                                          -> ambiguous, refuse

set -u
set -o pipefail

PROGNAME="$(basename "$0")"

usage() {
    # Every leading comment line after the shebang — never goes stale as the
    # header grows.
    awk 'NR == 1 { next } /^#/ { sub(/^# \{0,1\}/, ""); print; next } { exit }' "$0"
}

die() { # die <exit-code> <message>
    echo "$PROGNAME: $2" >&2
    exit "$1"
}

BEAD_ID=""
WORKSPACE=""
APPLY=0
LIMIT=10000
JSON_OUT=""
PLUCKS_JSON_OVERRIDE=""

while [ $# -gt 0 ]; do
    case "$1" in
        --bead)    [ $# -ge 2 ] || die 2 "--bead requires a value";  BEAD_ID="$2";    shift 2 ;;
        --workspace) [ $# -ge 2 ] || die 2 "--workspace requires a value"; WORKSPACE="$2"; shift 2 ;;
        --apply)   APPLY=1; shift ;;
        --limit)   [ $# -ge 2 ] || die 2 "--limit requires a value"; LIMIT="$2";      shift 2 ;;
        --json-out) [ $# -ge 2 ] || die 2 "--json-out requires a value"; JSON_OUT="$2"; shift 2 ;;
        --plucks-json) [ $# -ge 2 ] || die 2 "--plucks-json requires a value"; PLUCKS_JSON_OVERRIDE="$2"; shift 2 ;;
        -h|--help) usage; exit 0 ;;
        *)         die 2 "unknown argument: $1 (see --help)" ;;
    esac
done

[ -n "$BEAD_ID" ] || { usage >&2; die 2 "--bead is required"; }
[ -n "$WORKSPACE" ] || WORKSPACE="$PWD"
[ -d "$WORKSPACE" ] || die 2 "workspace directory not found: $WORKSPACE"

# ---------------------------------------------------------------------------
# Backend detection — must succeed before a single bead command runs.
# ---------------------------------------------------------------------------
BEAD_CLI=""
BACKEND=""

ws_file() { # ws_file <relative-path>
    printf '%s/%s' "$WORKSPACE" "$1"
}

if [ -f "$(ws_file .beads/config.yaml)" ]; then
    BACKEND="bf"
elif [ -f "$(ws_file .beads/config.json)" ] && \
     grep -Eq '^[[:space:]]*backend:[[:space:]]*bead-rs[[:space:]]*$' "$(ws_file .needle.yaml)" 2>/dev/null; then
    BACKEND="bead-rs"
elif [ -f "$(ws_file .beads/config.json)" ] || [ -f "$(ws_file .needle.yaml)" ]; then
    BACKEND="ambiguous"
else
    BACKEND="unknown"
fi

case "$BACKEND" in
    bead-rs)
        BEAD_CLI="bead"
        echo "backend: bead-rs (.beads/config.json + .needle.yaml backend: bead-rs) -> '$BEAD_CLI'"
        ;;
    bf)
        die 3 "workspace $WORKSPACE uses the deprecated bf backend (.beads/config.yaml present). This script only drives bead-rs; running the wrong CLI silently corrupts the other tool's schema."
        ;;
    ambiguous)
        die 3 "cannot determine bead backend for $WORKSPACE: backend markers are incomplete or contradictory (need .beads/config.json AND '.needle.yaml: bead_cli: backend: bead-rs'; .beads/config.yaml means bf). Refusing to guess."
        ;;
    *)
        die 3 "no bead backend found in $WORKSPACE (no .beads/config.json, no .beads/config.yaml, no .needle.yaml)."
        ;;
esac

# ---------------------------------------------------------------------------
# Helpers. Every store read below goes through these; stdout only is parsed
# (the CLI can emit diagnostics lines on stderr).
# ---------------------------------------------------------------------------

# The CLI resolves the store from the process cwd — there is no --workspace
# flag — so every bead command must run with the target workspace as its cwd.
run_bead() {
    ( cd "$WORKSPACE" && "$BEAD_CLI" "$@" )
}

# list_json <bead list args...>  ->  NDJSON on stdout, one issue per line
list_json() {
    run_bead list "$@" --json --limit "$LIMIT" 2>/dev/null | grep -E '^\{' || true
}

json_get() { # json_get <field> <json-line>
    python3 -c '
import json, sys
try:
    obj = json.loads(sys.argv[2])
except ValueError:
    sys.exit(1)
v = obj.get(sys.argv[1])
if v is None:
    sys.exit(1)
if isinstance(v, (list, dict)):
    print(json.dumps(v))
else:
    print(v)
' "$1" "$2"
}

# ---------------------------------------------------------------------------
# Ground truth — explicit per-status queries only. NEVER a bare
# `bead list --json`: that returns a closed-only slice and hides open beads,
# which is exactly the behaviour that produced the original false
# "open beads exist" claims.
# ---------------------------------------------------------------------------

OPEN_RAW="$(list_json --status open)"
INPROG_RAW="$(list_json --status in_progress)"
READY_RAW="$(list_json --ready)"

# id title assignee per row, for reporting
summarize() { # summarize <raw-ndjson> <exclude-id>
    [ -n "$1" ] || return 0
    printf '%s\n' "$1" | python3 -c '
import json, sys
exclude = sys.argv[1]
for line in sys.stdin:
    line = line.strip()
    if not line:
        continue
    try:
        o = json.loads(line)
    except ValueError:
        continue
    if o.get("id") == exclude:
        continue
    print("%s\t%s\t%s\t%s" % (
        o.get("id", "?"),
        (o.get("title") or "").replace("\t", " ")[:90],
        o.get("assignee") or "-",
        "manual_blocked" if o.get("manual_blocked") else "",
    ))
' "$2"
}

count_excluding() { # count_excluding <raw-ndjson> <exclude-id>
    [ -n "$1" ] || { echo 0; return; }
    printf '%s\n' "$1" | python3 -c '
import json, sys
exclude = sys.argv[1]
n = 0
for line in sys.stdin:
    line = line.strip()
    if not line:
        continue
    try:
        if json.loads(line).get("id") != exclude:
            n += 1
    except ValueError:
        pass
print(n)
' "$2"
}

OPEN_EXCL_ALERT="$(count_excluding "$OPEN_RAW" "$BEAD_ID")"
INPROG_COUNT="$(count_excluding "$INPROG_RAW" "")"
READY_EXCL_ALERT="$(count_excluding "$READY_RAW" "$BEAD_ID")"

TRUNCATED=0
for raw in "$OPEN_RAW" "$INPROG_RAW" "$READY_RAW"; do
    n="$(count_excluding "$raw" "")"
    [ "$n" -lt "$LIMIT" ] || TRUNCATED=1
done

# ---------------------------------------------------------------------------
# Workspace health.
# ---------------------------------------------------------------------------

# `bead doctor` writes its human-readable report on stderr; capture both and
# parse the merged text for OK/WARN/FAIL verdict lines.
DOCTOR_OUT="$(run_bead doctor 2>&1 || true)"
DOCTOR_FAILS="$(printf '%s\n' "$DOCTOR_OUT" | grep -E '^(FAIL|ERROR)[[:space:]]' || true)"
DOCTOR_WARNS="$(printf '%s\n' "$DOCTOR_OUT" | grep -E '^WARN[[:space:]]' || true)"
DOCTOR_VERDICT="healthy"
[ -z "$DOCTOR_FAILS" ] || DOCTOR_VERDICT="unhealthy"

# The ready_frontier scope specifically — branch (b) closes on it, so its
# verdict is surfaced separately from the overall doctor verdict.
READY_FRONTIER_LINE="$(printf '%s\n' "$DOCTOR_OUT" | grep -E '^(OK|WARN|FAIL|ERROR)[[:space:]]+ready_frontier:' | head -n 1 || true)"
READY_FRONTIER_OK=0
[ -n "$READY_FRONTIER_LINE" ] && printf '%s\n' "$READY_FRONTIER_LINE" | grep -q '^OK' && READY_FRONTIER_OK=1

# ---------------------------------------------------------------------------
# Pluck evidence — what pluck sees NOW, from its own diagnostics artifact.
# Trusted only when fresh (<= 86400s, NEEDLE's fingerprint-suppression
# window); a stale or missing artifact means "no live evidence", and the
# decision falls through to the ground-truth-only branches.
# ---------------------------------------------------------------------------

PLUCK_FRESH_SECS=86400
PLUCK_SKEW_SECS=300
PLUCKS_FILE="${PLUCKS_JSON_OVERRIDE:-$(ws_file .beads/diagnostics/pluck-diagnostics.json)}"

eval "$(python3 - "$PLUCKS_FILE" "$PLUCK_FRESH_SECS" "$PLUCK_SKEW_SECS" <<'PYEOF'
import datetime, json, os, re, shlex, sys, time

path, fresh_secs, skew_secs = sys.argv[1], int(sys.argv[2]), int(sys.argv[3])
present = int(os.path.isfile(path))
fresh = age = candidates = total_open = -1
if present:
    try:
        with open(path) as f:
            d = json.load(f)
        candidates = int(d.get("final_candidate_count", -1))
        total_open = int(d.get("total_open_beads", -1))
        ts = str(d.get("timestamp") or "")
        # rfc3339 with nanosecond precision; normalize to what fromisoformat takes
        ts = re.sub(r"\.(\d+)", lambda m: "." + m.group(1)[:6].ljust(6, "0"), ts)
        ts = re.sub(r"([zZ])$", "+00:00", ts)
        then = datetime.datetime.fromisoformat(ts)
        if then.tzinfo is None:
            then = then.replace(tzinfo=datetime.timezone.utc)
        age = int(time.time() - then.timestamp())
        # tolerate modest clock skew: an artifact stamped slightly "in the
        # future" is still live evidence
        fresh = int(-skew_secs <= age <= fresh_secs and candidates >= 0)
    except (ValueError, TypeError, KeyError, OSError):
        fresh = age = candidates = total_open = -1
print("PLUCKS_PRESENT=%d" % present)
print("PLUCKS_FRESH=%d" % fresh)
print("PLUCKS_AGE=%d" % age)
print("PLUCKS_CANDIDATES=%d" % candidates)
print("PLUCKS_OPEN=%d" % total_open)
PYEOF
)"

# ---------------------------------------------------------------------------
# The alert bead itself.
# ---------------------------------------------------------------------------

SHOW_JSON="$(run_bead show "$BEAD_ID" --json 2>/dev/null)" \
    || die 2 "cannot show bead $BEAD_ID (does it exist in $WORKSPACE?)"

# Parse the alert bead in one python pass: status, revision, title, the
# embedded counts from its own body, and the starvation-shape markers. Doing
# this in python (not shell) keeps descriptions with backslashes or tabs from
# being mangled on the way through.
eval "$(printf '%s' "$SHOW_JSON" | python3 -c '
import json, re, shlex, sys
o = json.load(sys.stdin)[0]
desc = o.get("description") or ""
title = o.get("title") or ""
# The starvation-shape gate keys on the machine-generated diagnostic payload,
# NEVER on the title: every "[Unravel] Starvation alert: ..." *proposal* bead
# quotes the title too, and closing a proposal as a false-positive alert
# destroys real work. The alert template carries all three markers together:
m = re.search(r"^\*\*Open beads:\*\*[ \t]*([0-9]+)", desc, re.M)
w = re.search(r"^\*\*Workspace:\*\*([ \t]*(.*))$", desc, re.M)
is_starvation = (
    m is not None
    and w is not None
    and ("Pluck found no candidates" in desc)
)
prose = "pluck-claims-open-beads-exist" if "open beads exist" in desc else ""
print("ALERT_STATUS=%s" % shlex.quote(o.get("status") or o.get("effective_status") or "?"))
print("ALERT_REVISION=%s" % shlex.quote(str(o.get("revision", "?"))))
print("ALERT_TITLE=%s" % shlex.quote(title.replace("\n", " ")))
print("ALERT_EMBEDDED_OPEN=%s" % (m.group(1) if m else ""))
print("ALERT_WORKSPACE=%s" % shlex.quote((w.group(1).strip() if w else "")))
print("IS_STARVATION=%d" % (1 if is_starvation else 0))
print("ALERT_PROSE=%s" % shlex.quote(prose))
')"

# ---------------------------------------------------------------------------
# Decision.
# ---------------------------------------------------------------------------

CLASSIFICATION=""
ACTION="none"
EXTRA_EVIDENCE=""

if [ "$IS_STARVATION" -eq 0 ]; then
    CLASSIFICATION="NOT_STARVATION_ALERT"
elif [ -n "$DOCTOR_FAILS" ]; then
    CLASSIFICATION="DOCTOR_UNHEALTHY"
elif [ "$TRUNCATED" -eq 1 ]; then
    CLASSIFICATION="LIST_TRUNCATED"
    EXTRA_EVIDENCE="a 'bead list' query hit the --limit cap; counts may be incomplete"
elif [ "$ALERT_STATUS" = "closed" ]; then
    # Fixture / historical case: ground truth at file time is unrecoverable,
    # so classify from the alert's own embedded data and never act.
    if [ "$ALERT_EMBEDDED_OPEN" = "0" ]; then
        CLASSIFICATION="FALSE_POSITIVE_CLOSED"
    else
        CLASSIFICATION="CLOSED_NEEDS_REVIEW"
    fi
elif [ "$PLUCKS_FRESH" -eq 1 ] && [ "$PLUCKS_CANDIDATES" -gt 0 ] && \
     [ "$READY_FRONTIER_OK" -eq 1 ] && [ "$OPEN_EXCL_ALERT" -gt 0 ]; then
    # Branch (b): pluck is finding candidates despite open beads existing, and
    # the frontier is healthy — present-day evidence refutes the alert's
    # starvation claim, whatever it showed when a pre-fix build filed it.
    CLASSIFICATION="FALSE_POSITIVE_PLUCK_LIVE"
    ACTION="close"
elif [ "$PLUCKS_FRESH" -eq 1 ] && [ "$PLUCKS_CANDIDATES" -eq 0 ] && \
     [ "$INPROG_COUNT" -gt 0 ]; then
    # Branch (c): work is genuinely in progress and pluck still finds no
    # candidates — a real starvation; keep it open with the evidence attached
    # so the normal dispatch path acts on it.
    CLASSIFICATION="GENUINE_STARVATION_PLUCK_LIVE"
    ACTION="annotate"
elif [ "$OPEN_EXCL_ALERT" -eq 0 ] && [ "$READY_EXCL_ALERT" -eq 0 ]; then
    CLASSIFICATION="FALSE_POSITIVE"
    ACTION="close"
elif [ "$ALERT_EMBEDDED_OPEN" = "0" ]; then
    # The alert's embedded data is self-contradicting, but ground truth now
    # shows genuinely dispatchable work: the alert is stale, not dismissible.
    CLASSIFICATION="EMBEDDED_ZERO_BUT_WORK_EXISTS"
    ACTION="annotate"
else
    CLASSIFICATION="GENUINE_STARVATION"
    ACTION="annotate"
fi

READY_LIST="$(summarize "$READY_RAW" "$BEAD_ID")"
OPEN_LIST="$(summarize "$OPEN_RAW" "$BEAD_ID")"

if [ "$PLUCKS_PRESENT" -eq 0 ]; then
    PLUCK_EVIDENCE_LINE="no pluck diagnostics artifact at $PLUCKS_FILE"
elif [ "$PLUCKS_FRESH" -eq 1 ]; then
    PLUCK_EVIDENCE_LINE="pluck diagnostics (age ${PLUCKS_AGE}s, fresh): total_open_beads=$PLUCKS_OPEN, final_candidate_count=$PLUCKS_CANDIDATES"
else
    PLUCK_EVIDENCE_LINE="pluck diagnostics present but stale/unparseable (age ${PLUCKS_AGE}s, threshold ${PLUCK_FRESH_SECS}s) — not used"
fi

echo
echo "alert bead     : $BEAD_ID (status=$ALERT_STATUS revision=$ALERT_REVISION)"
echo "alert workspace: ${ALERT_WORKSPACE:-<empty>}"
echo "embedded counts: Open beads = ${ALERT_EMBEDDED_OPEN:-<unparseable>}$([ -n "$ALERT_PROSE" ] && printf ' (%s)' "$ALERT_PROSE")"
echo "ground truth   : open(excl. alert)=$OPEN_EXCL_ALERT in_progress(all)=$INPROG_COUNT ready(excl. alert)=$READY_EXCL_ALERT"
echo "pluck evidence : $PLUCK_EVIDENCE_LINE"
echo "ready_frontier : ${READY_FRONTIER_LINE:-<scope absent from doctor output>}"
echo "doctor         : $DOCTOR_VERDICT ($(printf '%s\n' "$DOCTOR_OUT" | grep -cE '^OK[[:space:]]' || true) ok, $(printf '%s\n' "$DOCTOR_WARNS" | grep -c . || true) warn, $(printf '%s\n' "$DOCTOR_FAILS" | grep -c . || true) fail)"
echo "classification : $CLASSIFICATION"
echo "action         : $ACTION ($([ "$APPLY" -eq 1 ] && echo apply || echo classify-only))"
echo
echo "ready beads (excluding the alert bead):"
if [ -n "$READY_LIST" ]; then printf '%s\n' "$READY_LIST"; else echo "  <none>"; fi
if [ -n "$OPEN_LIST" ] && [ "$OPEN_LIST" != "$READY_LIST" ]; then
    echo
    echo "open beads (excluding the alert bead, incl. assigned/blocked):"
    printf '%s\n' "$OPEN_LIST"
fi

CLOSE_REASON="False-positive starvation alert (auto-triaged by $PROGNAME). Ground truth via explicit per-status queries: open(excl. this alert)=$OPEN_EXCL_ALERT, in_progress=$INPROG_COUNT, ready(excl. this alert)=$READY_EXCL_ALERT. bead doctor: $DOCTOR_VERDICT (${READY_FRONTIER_LINE:-ready_frontier not reported}). $PLUCK_EVIDENCE_LINE. The alert's prose claims open beads exist while its own body reads '**Open beads:** ${ALERT_EMBEDDED_OPEN:-?}' — self-contradicting. Precedent: conedrat-217f1faa."

if [ "$CLASSIFICATION" = "GENUINE_STARVATION_PLUCK_LIVE" ]; then
    ANNOTATE_LEAD="kept open — pluck reports zero candidates while work is in progress ($INPROG_COUNT in flight): a real starvation; the dispatch path should act on this"
else
    ANNOTATE_LEAD="kept open — genuinely dispatchable beads exist (open excl. this alert=$OPEN_EXCL_ALERT, ready excl. this alert=$READY_EXCL_ALERT), so this alert is not dismissible as a false positive"
fi
ANNOTATE_NOTES="Auto-triage ($PROGNAME): $ANNOTATE_LEAD. Per-bead ready list:
$READY_LIST
Ground truth: in_progress=$INPROG_COUNT; bead doctor: $DOCTOR_VERDICT; ready_frontier: ${READY_FRONTIER_LINE:-not reported}; $PLUCK_EVIDENCE_LINE. Classification: $CLASSIFICATION."

# `bead close --reason` is preserved for audit but is not surfaced by
# `bead show`, so the same evidence also goes into notes — notes are visible
# in `show` and survive the close. Annotate first, re-read the revision, then
# close under a fresh revision guard.
apply_changes() {
    local newrev
    if [ "$ACTION" = "close" ]; then
        echo "-- annotating $BEAD_ID with the close evidence"
        run_bead update "$BEAD_ID" --notes "$CLOSE_REASON" --if-revision "$ALERT_REVISION" || return 1
        newrev="$(run_bead show "$BEAD_ID" --json 2>/dev/null | python3 -c 'import json,sys; print(json.load(sys.stdin)[0]["revision"])')" || return 1
        echo "-- closing $BEAD_ID"
        run_bead close "$BEAD_ID" --reason "$CLOSE_REASON" --if-revision "$newrev"
    elif [ "$ACTION" = "annotate" ]; then
        echo "-- annotating $BEAD_ID"
        run_bead update "$BEAD_ID" --notes "$ANNOTATE_NOTES" --if-revision "$ALERT_REVISION"
    fi
}

if [ "$APPLY" -eq 1 ]; then
    case "$ACTION" in
        close|annotate)
            if apply_changes; then
                echo "-- applied: $ACTION on $BEAD_ID"
            else
                rc=$?
                die 4 "apply failed (exit $rc); nothing was changed if the revision guard tripped — re-run to retry"
            fi
            ;;
        none)
            echo "-- nothing to apply for classification $CLASSIFICATION"
            ;;
    esac
fi

if [ -n "$JSON_OUT" ]; then
    python3 - "$JSON_OUT" <<PYEOF
import json, sys
result = {
    "bead": "$BEAD_ID",
    "workspace": "$WORKSPACE",
    "backend": "$BACKEND",
    "alert_status": "$ALERT_STATUS",
    "alert_revision": "$ALERT_REVISION",
    "embedded_open": ${ALERT_EMBEDDED_OPEN:-None},
    "ground_truth": {
        "open_excluding_alert": $OPEN_EXCL_ALERT,
        "in_progress": $INPROG_COUNT,
        "ready_excluding_alert": $READY_EXCL_ALERT,
    },
    "doctor": "$DOCTOR_VERDICT",
    "ready_frontier_ok": $([ "$READY_FRONTIER_OK" -eq 1 ] && echo True || echo False),
    "plucks_evidence": $(printf '%s' "$PLUCK_EVIDENCE_LINE" | python3 -c 'import json,sys; print(json.dumps(sys.stdin.read()))'),
    "truncated": $([ "$TRUNCATED" -eq 1 ] && echo True || echo False),
    "classification": "$CLASSIFICATION",
    "action": "$ACTION",
    "applied": $([ "$APPLY" -eq 1 ] && [ "$ACTION" != "none" ] && echo True || echo False),
}
with open(sys.argv[1], "w") as f:
    json.dump(result, f, indent=2)
    f.write("\n")
PYEOF
fi

exit 0
