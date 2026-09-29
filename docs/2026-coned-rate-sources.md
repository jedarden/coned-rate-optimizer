# 2026 Con Edison SC1 rate sources and canonical inputs

Research date: 2026-09-29. This document records the authoritative 2026
inputs for the calculator. It does not change calculator behavior. Monetary
energy values below are in dollars per kWh (`$/kWh`), not cents per kWh.

## Authoritative publications

The primary source is Con Edison’s filed **Schedule for Electricity Service,
P.S.C. No. 10 – Electricity**, February 2026 tariff:

<https://www.coned.com/-/media/files/coned/documents/rates/electric/historical/psc-10/tariff/sc-202602.pdf>

The filing states an initial effective date of **2026-02-01** and was issued
under the PSC order in Case 25-E-0072 dated 2026-01-22. The relevant leaves are:

- **Leaf 388, Revision 23 — SC1 Rate I, Residential and Religious:** standard
  delivery charges.
- **Leaf 389.1, Revision 19 — SC1 Rate III, Residential and Religious,
  Voluntary Time-of-Day:** residential TOU delivery charges and the $21
  customer charge.

Con Edison’s customer-facing TOU table repeats the Rate III values and period
labels here:

<https://www.coned.com/en/accounts-billing/your-bill/time-of-use>

Con Edison’s rate schedule index is useful for finding the current tariff and
later revisions:

<https://www.coned.com/en/rates-tariffs/rates/electric-rates-schedule/electric-psc-10>

## Canonical 2026 values

These values apply on and after **2026-02-01**, until a later PSC-10 tariff
revision supersedes the February 2026 leaves.

### SC1 Rate I — standard residential delivery

| Effective period | Usage band | Canonical value | Unit |
| --- | --- | ---: | --- |
| June 1–September 30 | First 250 kWh in the billing period | 0.16402 | $/kWh |
| June 1–September 30 | Usage over 250 kWh in the billing period | 0.18858 | $/kWh |
| October 1–May 31 | All kWh | 0.16402 | $/kWh |
| All periods | Customer charge | 21.00 | $/month |

The tariff’s wording is “first 250 kWhr” and “over 250 kWhr”; the threshold is
therefore a billing-period usage threshold, not a per-hour or annual threshold.
The table is delivery only. Additional Delivery Charges and Adjustments under
General Rule 26, supply, taxes, and other applicable charges are separate.

Implementation mapping:

```json
{
  "effectiveFrom": "2026-02-01",
  "summerMonths": [6, 7, 8, 9],
  "standardDelivery": {
    "summerFirst250": 0.16402,
    "summerOver250": 0.18858,
    "otherMonths": 0.16402,
    "customer": 21.00,
    "unit": "USD/kWh; customer USD/month"
  }
}
```

The existing scalar `standard.delivery` field cannot represent this tariff
without losing the summer threshold. The existing `0.183233` value is a
published 2025 NYC SC1 historical average, not the 2026 Rate I delivery
schedule, and must not be described as the 2026 delivery rate.

### SC1 Rate III — residential voluntary TOU schedule

| Effective period | Period | Canonical value | Unit |
| --- | --- | ---: | --- |
| June 1–September 30 | On-peak, 8:00 a.m.–midnight, all days including holidays | 0.2786 | $/kWh |
| June 1–September 30 | Off-peak, all other hours of the week | 0.0522 | $/kWh |
| October 1–May 31 | On-peak, 8:00 a.m.–midnight, all days including holidays | 0.1711 | $/kWh |
| October 1–May 31 | Off-peak, all other hours of the week | 0.0522 | $/kWh |
| All periods | Customer charge | 21.00 | $/month |

The direct mapping to the existing TOU field names is:

```json
{
  "effectiveFrom": "2026-02-01",
  "offPeak": 0.0522,
  "peakSummer": 0.2786,
  "peakWinter": 0.1711,
  "customer": 21.00,
  "unit": "USD/kWh; customer USD/month"
}
```

## Supply-versus-delivery boundary

The 2026 PSC-10 tariff labels the Rate III values above **Energy Delivery
Charges**. Con Edison’s public TOU page presents the same numbers in its
residential “Peak Rates” and “Off-Peak Rates” table, but it does not turn them
into a fixed annual supply price.

For a full-service customer, Con Edison says supply consists of the Market
Supply Charge (MSC) plus MSC adjustments and other supply charges. The MSC is
calculated for the customer’s service classification, zone, and billing
period; the lookup identifies Rate III as `001VTO`:

- [Market Supply Charge calculator](https://www.coned.com/en/accounts-billing/your-bill/rate-calculators/market-supply-charge)
- [MSC rate-description/reference-code file](https://edge-e-dcxprod-web-bechbkdqagefb9ge.a03.azurefd.net/-/media/files/coned/documents/accountandbilling/your-bill/market-supply-charge/electric-rate-description-supply-charge-and-type.pdf?hash=4E9A6EE5AF5AAAB9A2AA8D291B1DCF27&rev=6e754e57c08e4b8e90b613d3698e6b1c)
- [Con Edison supply-charge FAQ](https://www.coned.com/en/rates-tariffs/rates/electric-rates-schedule/faqs)

The calculator/implementation must therefore preserve this distinction:

1. `0.2786`, `0.1711`, and `0.0522` are authoritative 2026 **Rate III
   delivery** values. They are not an estimated or fixed TOU supply rate.
2. A customer’s actual Con Edison supply value must come from the MSC lookup or
   calculator for the bill’s dates and zone (and from the ESCO contract for an
   ESCO customer). No unsupported annual 2026 supply number should be added to
   `public/calc.js` or `public/rates.json`.
3. If the existing `tou.peakSummer`, `tou.peakWinter`, and `tou.offPeak`
   fields continue to hold these three published numbers, their documentation
   and calculation label must say **Rate III delivery**. Treating them as
   supply would be a behavior/model decision for the implementation child, not
   a fact supported by the tariff.

The tariff also says that summer super-peak pricing applies Monday–Friday from
2:00–6:00 p.m. for full-service customers. That is an additional supply-side
condition and is not a replacement for the Rate III delivery table above.

## Do not conflate the historical-average PDF

The existing historical-average source remains valid for its own purpose:

<https://www.coned.com/-/media/files/coned/documents/save-energy-money/using-private-generation/historical-average-full-service-electric-rates.pdf>

It publishes annual NYC SC1 full-service averages (including the model’s
historical commodity/delivery components) and is not the February 2026 PSC-10
Rate I/Rate III tariff schedule. In particular, the current `standard` values
`delivery: 0.183233`, `commodity: 0.137533`, and `allIn: 0.338267` describe the
2025 historical average used for projected 2026 bill reconstruction; they do
not replace the effective-period delivery values in this document.
