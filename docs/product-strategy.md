# ConEd rate optimizer product strategy

Prepared: 2026-08-21

## Decision

Advance the existing prototype to a tightly scoped paid validation. This is an
unusually strong consumer offer because the product can calculate a dollar value
before asking for payment. The customer does not need to believe in an abstract
benefit: either a cheaper eligible rate exists for their observed usage or it
does not.

The current prototype is a useful calculation and privacy proof, not yet a
chargeable rate audit. It compares Standard and residential Time-of-Use using
partly simplified and outdated assumptions. A paid product must reproduce actual
historical bills closely, cover every relevant residential rate, enforce
eligibility/lock-in rules, and update when tariffs change.

## Validated market shape

RateMate currently offers nearly this product for Con Edison customers:

- free Green Button-connected analysis;
- replay of observed usage across available rates;
- assistance making the switch;
- ongoing monitoring; and
- a fee equal to 30% of verified first-year savings.

It says roughly one third of analyses find that the current plan is already
best. Astute Energy Advisors also offers a personalized smart-meter rate analysis
and charges only after finding a meaningful saving. These are competitor claims,
not independently audited unit economics, but they validate the customer job,
data source, and value-based pricing shape.

Sources:

- <https://ratemate.energy/>
- <https://astuteenergyadvisors.com/>
- <https://www.coned.com/en/accounts-billing/share-energy-usage-data/share-my-data>
- <https://www.coned.com/en/accounts-billing/your-bill/time-of-use>
- <https://www.coned.com/en/accounts-billing/your-bill/rate-calculators>

## Product promise

> Connect your Con Edison account and see whether another eligible rate would
> have lowered your real bill. The analysis is free. Pay only if we find a
> meaningful saving.

Do not promise that most customers are overpaying until first-party data supports
that statement. Do not call a projection guaranteed savings. Separate observed
historical counterfactual savings from future estimates.

## Customer journey

```text
Meta ad
  -> location/account eligibility check
  -> Green Button Connect authorization or local CSV upload
  -> import billing + interval history
  -> validate data quality and reconstruct actual bills
  -> replay usage across every eligible rate
  -> free verdict
       ├─ current rate is best -> explanation + optional annual recheck
       └─ cheaper rate found -> savings preview + paid action
  -> switching instructions or concierge authorization
  -> verify each new bill against the counterfactual
  -> alert when tariffs or usage change the recommendation
```

### Free result

The customer should receive enough information to trust the analysis:

- whether the current rate appears best;
- the estimated annual opportunity, as a range;
- calculation confidence and missing-data warnings;
- months in which the alternative wins or loses; and
- the largest driver of the difference.

Do not hide a “no savings” result behind payment. That result is part of the
promise and a useful trust signal.

### Paid result

- complete plan-by-plan comparison;
- exact rate name and eligibility notes;
- month-by-month counterfactual charges;
- switching timing and lock-in warning;
- step-by-step enrollment instructions; and
- optional concierge switching and first-year verification.

## Month-over-month experience

The persistent dashboard should answer four questions:

1. What did I pay this billing period?
2. Why did it change?
3. Am I still on the best eligible rate?
4. How much has the switch actually saved?

| Period | Actual charge | Best-plan charge | Difference | Primary explanation |
| --- | ---: | ---: | ---: | --- |
| June | $286 | $241 | $45 | Overnight load favors TOU |
| July | $412 | $398 | $14 | Summer super-peak reduces the advantage |
| August | $375 | $329 | $46 | Lower weekday-afternoon usage |

The explanation should decompose a month-over-month change into:

- consumption change;
- timing/load-shape change;
- delivery-rate change;
- supply-rate change;
- tax/surcharge change;
- ESCO effect; and
- correction, estimated read, or partial-period effect.

Bill periods must remain bill periods rather than being silently converted to
calendar months.

## Pricing

### Recommended launch model

- Analysis: free.
- Self-service report: $29 only when projected first-year savings exceed $150.
- Concierge: the larger of $99 or 20% of verified first-year savings, with a
  clearly stated cap.
- Continued monitoring after the first year: $29/year.

The percentage fee should be charged against realized, documented savings only
if the product actually verifies subsequent bills. If operational complexity is
too high, launch the $29 report first but do not assume it can profitably acquire
cold Meta traffic.

### Why not monthly

The dashboard can create monthly engagement, but plan-changing decisions occur
infrequently. Annual monitoring better matches tariff changes and household
load-shape changes. A monthly subscription becomes defensible only if the
service also handles ongoing bill-error disputes, ESCO monitoring, demand-response
rewards, rebates, or other frequent interventions.

## Meta acquisition assumptions

Published benchmarks vary materially by campaign objective and methodology:

- a 2026 cross-industry report places traffic-campaign CPC around $0.70 and
  lead-generation CPC around $1.92;
- home-service reports place CPC around $1.20--$2.80, with one reporting a $2.23
  average; and
- finance/insurance reports commonly place CPC above $2 and sometimes near $4.

This product is geographically constrained, involves household finances, and
asks for a high-friction utility-data connection. Plan with:

| Scenario | Link CPC |
| --- | ---: |
| Optimistic | $1.00 |
| Base | $2.00 |
| Pessimistic | $3.50 |

Sources:

- <https://silverbackmarketing.com/assets/downloads/Silverback_2026_Paid_Media_Benchmark_Report.pdf>
- <https://www.j9systems.com/blog/meta-ads-for-contractors>
- <https://watsonco.marketing/blog/2026/07/facebook-ads-cost-home-services/>
- <https://www.wordstream.com/blog/facebook-ads-benchmarks-2025>

These are planning inputs, not expected results. Optimize campaigns toward a
valid completed analysis and ultimately a paid/verified saving—not landing-page
clicks. Cheap traffic can be economically worthless.

## Unit economics

### Break-even click-to-purchase conversion

Ignoring payment fees, support, and compute, a $29 report requires:

| CPC | Required click-to-paid conversion |
| ---: | ---: |
| $1.00 | 3.45% |
| $2.00 | 6.90% |
| $3.50 | 12.07% |

The real requirement is higher after fees, refunds, support, and the fact that
some connected accounts have no saving to sell. A $29 report alone is therefore
a difficult cold-traffic business.

### Illustrative 100-click cohort

This is a model, not evidence:

```text
100 clicks at $2.00                         = $200 ad spend
20 complete a valid account connection     = 20 analyses
13 show savings above the threshold        = 13 qualified opportunities
4 purchase or authorize paid help          = 4 customers
```

- Four $29 reports produce $116 before costs: unprofitable.
- Four customers worth $125 each produce $500 before costs: potentially viable.
- Four customers worth $150 each produce $600 before costs: meaningful room for
  support and acquisition.

The experiment must measure each transition rather than optimizing CPC in
isolation.

## Meta creative portfolio

### Direct bill pain

- “Your ConEd bill may be using the wrong pricing formula.”
- “Same electricity and meter; check whether another rate costs less.”
- Show an actual anonymized bill replay with both plan totals.

### Equipment/lifestyle change

- Electric heat or heat pump.
- EV charging.
- Work-from-home schedule.
- Window or central air-conditioning usage.
- Battery or solar installation.

### No-risk offer

- “Connect free. If your current rate is best, we tell you.”
- “Pay only when the analysis finds meaningful projected savings.”

Avoid fake warning notices, Con Edison branding that implies affiliation,
unsupported “most customers overpay” claims, and guaranteed future savings.

## Technical gaps before charging

1. **Current tariffs:** replace 2025 approximations with versioned effective-date
   rate data for 2026--2028.
2. **Complete plan inventory:** model all relevant residential plans and variants,
   not only Standard and TOU.
3. **Eligibility engine:** rate zone, service class, EV, solar, heat pump,
   storage, ESCO, meter/data completeness, and program enrollment constraints.
4. **Bill reconstruction:** customer charges, delivery, supply, adjustments,
   surcharges, taxes, partial periods, corrections, and estimated reads.
5. **Historical backtest:** reproduce the customer's actual bill closely before
   trusting alternate-rate counterfactuals.
6. **Confidence system:** refuse or qualify recommendations when data or tariff
   coverage is inadequate.
7. **Rate provenance:** every calculation line links to the tariff/rate statement
   and effective date used.
8. **Monitoring:** ingest new billing and interval records, preserve revisions,
   and rerun the recommendation after rate or load changes.

### Accuracy gate

Do not charge until at least 20 diverse real accounts have been backtested and
the modeled bill is within 2% of the actual bill for at least 95% of complete,
supported billing periods. Investigate every miss rather than averaging it away.

## Data architecture

### Phase 1: local upload

Keep the current browser-only Green Button CSV path. It minimizes authorization,
security, and third-party onboarding work and is sufficient to validate whether
customers will complete the flow and pay for a correct result.

### Phase 2: Green Button Connect

Use Con Edison's OAuth 2.0 Green Button Connect flow. Never collect or proxy the
customer's Con Edison password. Request only the billing, interval, and retail
customer scopes required. Complete Con Edison's third-party onboarding and data
security agreement before storing customer data.

Green Button Connect supports persistent month-over-month monitoring; a download
alone does not.

## Experiment plan

No ad spend is authorized by this document.

### Stage 1: calculation audit

- Recruit 20 Con Edison customers across apartment/home, city/Westchester,
  ordinary/high load, EV, electric heat, and ESCO cases.
- Obtain explicit permission and minimize retained data.
- Reproduce bills and manually compare all eligible rates.
- Record calculation errors and actual savings distribution.

Kill if the full tariff model cannot meet the accuracy gate without manual
consultant judgment.

### Stage 2: unpaid funnel test

- Offer the analysis to NYC/Westchester communities.
- Measure landing -> instructions -> valid upload -> useful result -> paid intent.
- Use a real $29 checkout or clearly labeled no-charge reservation.

Advance only if users can complete the data flow without live assistance and at
least 10% of savings-qualified users demonstrate paid intent.

### Stage 3: capped Meta test

- Three materially different creative concepts, not cosmetic variants.
- Optimize to completed valid analysis once event volume permits.
- Base planning assumption: $2 link CPC.
- Judge cost per valid connection, savings-qualified account, and paid customer.

Kill the flat-fee model if projected contribution margin cannot recover CAC on
the first transaction. Test concierge/value pricing before declaring the demand
invalid.

## Product positioning

This is not an ESCO, power supplier, home energy audit, or Con Edison product.
It is an independent tariff and bill-analysis service. State that clearly on the
ad, authorization screen, result, and checkout.

The product's defensibility is not the Green Button parser. It is the maintained
tariff engine, accurate bill reconstruction, eligibility logic, verified savings
history, and operational ability to make or guide a correct switch.
