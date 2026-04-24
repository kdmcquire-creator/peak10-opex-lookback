# Peak 10 OPEX Lookback — Dashboard Replication Guide

Target audience: an engineer or analyst building a second dashboard that needs to reproduce the **Summary cards**, the **Monthly Trends charts**, and the **Monthly LOS Table** from this dashboard against a separate data pipeline. This document walks through (1) the source-data ingest for the LOS Excel files, (2) how the data is conditioned (net → gross, ad-val normalization, exclusions, anomalies), and (3) every chart / table detail that must be reproduced, including formatting, interactivity, and edge cases.

Live reference: <https://peak10-opex-lookback.netlify.app> (password: `peak10` / `P3@k10-2026!`)

---

## 1. Source data

### 1.1 LOS files (one per asset)

Four Excel workbooks, one per cost-bearing asset:
- `THRU 260228 LOS BY WELL - HAWKEYE.xlsx`
- `THRU 260228 LOS BY WELL - STRAWN.xlsx`
- `THRU 260228 LOS BY WELL - REEVES.xlsx`
- `THRU 260228 LOS BY WELL - GENESIS.xlsx`

Each workbook has **one sheet per well**, plus a `Company_125` roll-up sheet which we ignore (we sum per-well data ourselves).

**Per-well sheet layout:**
- `A1`: Asset name (e.g. `PEAK 10 HAWKEYE`)
- `A5`: Well identifier formatted `(PROPCODE)  WELL NAME` — e.g. `(SCUR535284)  ALPHA 1H`
- `Row 5`: Column headers. Col A=`Acct`, Col B=`Description`, Cols C..AE=29 month headers (`Oct 2023` through `Feb 2026`), Col AF=`Year-to-Date`, Col AG=`Inception-to-Date`.
- `Row 7+`: Data rows — one per account. Col B carries the account description; Cols C..AE carry monthly dollar/volume values.

Total dataset: 29 months × ~177 wells × ~35 unique accounts ≈ 220k non-zero fact rows.

### 1.2 Reserves / scaling factors

One Excel: `Peak10 Total Oneline and CF - 3.16.26 Strip Pricing.xlsx`

Two sheets we care about:
- **`Oneline`** — one row per (asset, well, reserve category). Columns of interest: `LEASE`, `ASSET` (HAWKEYE/STRAWN/REEVES/BOCI_GENESIS), `RSV_CAT` (1PDP/3PDSI/4PUD/5PROB/6POSS/9P&A), `APO_WI`, `APO_NRI`, `BPO_WI`, `BPO_NRI`, `OPERATOR`, `API10`, `OIL_DIFF`, `GAS_DIFF`, etc. We use **APO** (after payout) factors.
- **`Cash_Flow_10yrs`** — forecast cash flows; used only for volume-basis verification (not required for runtime rendering).

### 1.3 Well selection

A spreadsheet (or simple CSV) listing which wells to include. Columns: `Asset`, `PropCode`, `PropName`, `Type` (`Well` or `Non-Well CC`), `Include` (TRUE/FALSE). Non-well cost centers (SWDs, frac ponds) default to `Include = FALSE`. 177 wells are currently flagged `Include = TRUE`.

### 1.4 Benchmark prices (optional — used for WTI / HH diff metrics)

Monthly WTI CMA settle and Henry Hub LD settle prices, Oct 2023 – Feb 2026. Source: Aegis Hedging OData API (`/odata/CombinedCurves.ForDateRange`, product codes `R` = WTI CMA, `H` = HH LD). Stored as:

```json
{
  "2025-04": { "wti": 62.962, "hh": 3.95 },
  "2025-05": { "wti": 60.935, "hh": 3.17 },
  ...
}
```

---

## 2. Data ingest workflow

### 2.1 Parse LOS into long-format fact table

For each asset workbook, for each well sheet:

1. Read A5 → regex `^\(([A-Z0-9]+)\)\s+(.+)` to extract `PropCode`, `PropName`.
2. Read row 5 for the month headers (e.g. `Oct 2023` → `(2023, 10)`).
3. For rows 7..end:
   - Col B = account description (e.g. `OIL - BBLS`, `NLOE CONTRACT LABOR`, `WORKOVER EXPENSES`)
   - For each month column, if the cell is numeric and non-zero, emit a fact row: `{Year, Month, Asset, PropCode, PropName, Account, Value}`

Store as a DataFrame or CSV called `facts_v2.csv` with ~90k rows.

### 2.2 Classify accounts into buckets

Every account description maps to a `(Bucket, SubCategory)` pair. The full mapping is ~80 entries; key ones:

| Account (description) | Bucket | SubCategory |
|---|---|---|
| `OIL - BBLS` / `GAS - MCF` / `NGL - BBLS` | `VOLUME` | Oil / Gas / NGL |
| `OIL SALES` / `GAS SALES` / `NGL SALES` | `REVENUE` | Oil / Gas / NGL |
| `MARKETING EXPENSE`, `GATHERING EXPENSE`, `PROCESSING EXPENSE`, `OTHER DEDUCTIONS`, `COMPRESSION EXPENSE` | `GAS_NETBACK` | (per account) |
| `SEVERANCE TAXES` | `SEVERANCE` | Severance |
| `NLOE AD VALOREM TAXES` | `ADVAL` | Ad Valorem |
| `NLOE POWER, FUEL AND WATER`, `NLOE UTILITIES - ELECTRICITY`, `NLOE CHEMICALS AND TREATING`, `NLOE TRANSPORTATION/TRUCKING`, `NLOE SALT WATER DISPOSAL`, `NLOE VACUUM TRUCK`, `NLOE WATER HAULING`, `NLOE HOT OIL`, `NLOE LEASE USE GAS` | `VAR_OPEX` | Power/Fuel/Water, Electricity, Chemicals, Trucking, SWD, Vacuum Truck, Water Hauling, Hot Oil, Lease Use Gas |
| `NLOE CONTRACT LABOR`, `NLOE COMPANY LABOR`, `NLOE FIELD OFFICE EXPENSE`, `NLOE PUMPER CHARGES`, `NLOE PRODUCTION SUPERVISOR`, `NLOE CONSULTANTS/SPEC SRVS` (these 6 comprise **"Field Personnel"**) | `FIX_OPEX` | Contract Labor, Company Labor, Field Office, Pumper, Prod Supervisor, Consultants |
| `NLOE OVERHEAD`, `NLOE ROADS & LOCATION`, `NLOE INSPECTION SERVICES`, `NLOE EQUIPMENT RENTAL`, `NLOE MATERIALS & SUPPLIES`, `NLOE AUTOMATION /SCADA SYSTEM`, `NLOE COMMUNICATIONS`, `NLOE METER PROVING/CALIBRATION`, `NLOE LAB ANALYSIS`, `NLOE VEHICLE EXPENSE`, `NLOE REGULATORY`, `NLOE PERMITS`, `NLOE LEGAL`, `NLOE INSURANCE`, `NLOE E H & S EXPENSES`, `NLOE MISCELLANEOUS`, `NLOE ROUSTABOUT`, `NLOE FACILITIES`, `NLOE COMPRESSION`, `NLOE COMPRESSION RENTAL`, `NLOE GAS MEASUREMENT`, `NLOE FIELD OFFICE EXPENSE`, `NLOE SURFACE EQUIPMENT`, `NLOE SPILL REMEDIATION`, `NLOE OUTSIDE OPERATED` | `FIX_OPEX` | Overhead (COPAS), Roads & Location, Inspection, Equipment Rental, Materials & Supplies, SCADA/Automation, Communications, Meter Proving, Lab Analysis, Vehicle, Regulatory, Permits, Legal, Insurance, EH&S, Miscellaneous, Roustabout, Facilities (NLOE), Compression (NLOE), Compression Rental, Gas Measurement, Surface Equipment, Spill Remediation, Outside Operated |
| `NLOE WELL SERVICING`, `NLOE REPAIR AND MAINTENANCE`, `NLOE TUBING & PIPE & RELATED`, `NLOE PUMPS/PUMPING UNITS`, `NLOE EQUIPMENT INSTALLATION` | `FIX_OPEX` | Well Servicing, R&M, Tubing & Pipe, Pumps, Equipment Install |
| `WORKOVER EXPENSES`, `P&A EXPENSES` | `WORKOVER` | Workover, P&A |
| `FACILITIES`, `LEASE & WELL EQUIPMENT`, `TCC`, `TDC` | `CAPEX_T` | Facilities, Lease & Well Equipment, TCC, TDC |
| `IDC`, `ICC` | `CAPEX_I` | IDC, ICC |
| `CAPITAL` | `CAPEX_U` | Capital (unsplit) |
| `TOTAL GROSS REVENUE`, `TOTAL REVENUE DEDUCTIONS`, `NET REVENUE`, `TOTAL LEASE OPERATING EXPENSES`, `NET OPERATING INCOME`, `NET INCOME`, `TOTAL CAPITAL`, `BARRELS OF OIL EQUIVALENTS (BOE)`, `LOE PER MCF ($/MCF)` | `SKIP` | (subtotals — discard; we recompute from line items) |

Decision precedents baked into this mapping:
- **Workover-adjacent NLOE lines** (Well Servicing, R&M, Tubing & Pipe, Pumps, Equipment Installation) are classified as `FIX_OPEX`, not `WORKOVER`. The `WORKOVER` bucket is reserved for the single `WORKOVER EXPENSES` line plus `P&A EXPENSES`.
- **Gas-stream deducts** (marketing, gathering, processing, other, compression) go to `GAS_NETBACK`, separate from the cost buckets.
- **Severance** and **ad valorem** each get their own bucket — they're taxes, not operating costs.

### 2.3 Sign conventions

Source data uses accounting sign convention: credits (revenue) are **negative**, debits (costs) are **positive**. Volumes appear negative too in many exports.

Apply this flip during ingest:

```
if Bucket in {"REVENUE", "VOLUME"}:
    ValueSigned = -Value   # display positive
else:
    ValueSigned = Value    # keep as-is (costs display positive)
```

After flipping, negative values do occur legitimately: gas price inversions (Waha negative-price events), revenue chargebacks, prior-period reversals. These are real and should be retained.

### 2.4 Compute derived row values

Create two parallel value columns:

- **Net** (= `ValueSigned`) — what Peak 10 booked
- **Val_Gross** — grossed-up version per §3.2 below

Persist as `facts_v2_scaled.csv` with columns: `Year, Month, Asset, PropCode, PropName, Account, Bucket, SubCategory, Value, ValueSigned, APO_WI_Used, APO_NRI_Used, Val_Gross`.

### 2.5 Volume basis verification

LOS files are labeled "INSIDE SHARE LEASE OPERATING STATEMENT". Verify the volume-basis assumption before grossing up: compare latest-month LOS net oil (signed-flipped) against `N OIL` from the `Cash_Flow_10yrs` forecast at the same period. Ratio ≈ 1.0 confirms NRI-basis volumes (expected and verified for this data set).

---

## 3. Data conditioning

### 3.1 Scaling factors from reserves file

For each (Asset, PropCode) in the well selection (Include=TRUE):
1. Match by `LEASE` name (case-insensitive, punctuation-normalized) to an Oneline `1PDP` or `3PDSI` entry with the same `ASSET`.
2. If no match: try token-based fuzzy matching, then a small manual override table for known edge cases (e.g. `WILLIE 1H` in LOS → `WILLIE 25 1H` in Oneline, `HAMMACK 1H` → `HAMMACK 1`).
3. Record `APO_WI`, `APO_NRI`.
4. If still no match OR Oneline row has WI=0 (ORRI-only): use the asset-average WI/NRI across matched wells as a fallback. Flag these wells.

Store per-well: `APO_WI_Used`, `APO_NRI_Used`, `Has_Scaling` (bool), `Scaling_Source` ("well-specific" | "asset-average").

### 3.2 Net → Gross conversion

Apply per-row (i.e. per fact, per well, per month):

| Bucket | Scaling | Resulting Gross quantity |
|---|---|---|
| `VOLUME` | `Value / APO_NRI` | Physical gross volume |
| `REVENUE` | `Value / APO_NRI` | Wellhead gross revenue (pre-royalty) |
| `SEVERANCE` | `Value / APO_NRI` | Severance at NRI (scales with revenue stream) |
| `GAS_NETBACK` | `Value / APO_WI` | Gross gas-stream deducts |
| `VAR_OPEX` / `FIX_OPEX` / `WORKOVER` | `Value / APO_WI` | 100% WI gross cost |
| `ADVAL` | `Value / APO_WI` | 100% WI ad val |
| `CAPEX_T` / `CAPEX_I` / `CAPEX_U` | `Value / APO_WI` | 100% WI gross capex |

**Why Net $/BOE > Gross $/BOE** (always, by the royalty factor):
```
Gross $/BOE = (Net_Cost / WI) / (Net_BOE / NRI) = Net $/BOE × (NRI / WI)
            = Net $/BOE × 8/8ths_NRI
```
Since NRI/WI = (1 − royalty − ORRIs) < 1, Gross is always lower than Net by the royalty factor. For Peak 10's portfolio this is ~20-27% reduction.

### 3.3 Ad valorem normalization

Ad val is posted in the source data as a single annual lump (often in one month). For trend analysis we spread it:

```
For each (Asset, Basis, Year):
  annual_adval = sum of ADVAL across all months of that year
  normalized_monthly_adval = annual_adval / 12

For each month:
  if ActiveWells > 0:
    ADVAL = normalized_monthly_adval
  else:
    ADVAL = 0
  ADVAL_Original = raw posted value  (preserved for reference)
```

For annual rollups where the asset has < 12 active months (e.g. Hawkeye 2025 with 4 active months Sep-Dec): `Adval_displayed = (annual / 12) × active_months`. This avoids attributing a full-year ad val to an asset that only ran part of the year.

### 3.4 Active-well and active-month definitions

- **Active well in a month** = the well has non-zero volume OR non-zero LOE in that month.
- **ActiveWells (asset, month)** = count of wells active in that month.
- **Active months (asset, year)** = count of months where ActiveWells > 0.
- **Well-months (asset, year)** = sum of ActiveWells across months in that year.

These are the denominators for per-well and per-BOE metrics.

### 3.5 Stub month filter

A "stub month" has ActiveWells = 0 AND BOE = 0, but occurs AFTER the asset had active production. These are reporting-lag stubs (invoices for prior month's production posted against the current month).

```
mask[i] = !active[i] AND has_seen_activity_before[i]
```

Stub months are excluded from anomaly detection and from trailing-12-month (TTM) windows. They still appear in sparklines (as gaps).

### 3.6 Exceptions / edge cases

| Case | Handling |
|---|---|
| Non-well cost centers (SWDs, frac ponds) | Excluded from well-level totals (Include=FALSE). Reported separately as "Infra" if needed. |
| Joint wells held by multiple entities (23 Strawn+Hawkeye, 1 Genesis+Reeves) | Per-entity views are independently correct. At consolidated Gross basis, these wells are **double-counted** (each entity grosses its share independently). Flag in UI. |
| Wells with WI=0 in Oneline (ORRI-only) | No meaningful gross scaling possible. Use asset-average fallback with flag. |
| Pre-acquisition zero months (Hawkeye Oct-23 through Aug-25) | Not stubs — never had activity. Excluded from TTM and anomaly detection cleanly. |
| Hawkeye revenue restatement artifacts from old LOS files | Fully resolved in current data set (OLD file 1-month production-date shift + missing Nov/Dec; NEW file is clean). See project history. |
| Strawn 2024 WI restatement on 23 joint wells | Old LOS files showed 2× the Strawn WI on these 23 wells. Current LOS is correct. Verified via per-well cross-check. |

---

## 4. Activity filter (applies to Fixed $/Well-Mo and Workover $/Well-Mo only)

User-selectable threshold excludes wells below a minimum **Gross avg BOE/d** while producing. Defaults to 1.0 BOE/d. Options: Off (0), 0.5, 1.0, 2.0, 5.0.

For each (Asset, Year):
```
Gross_AvgBOEd = (sum gross BOE in year) / (producing_months × 30.4375)
```

A well **qualifies** if `Gross_AvgBOEd >= threshold`. For Fixed $/Well-Mo and Workover $/Well-Mo calcs, exclude non-qualifying wells from BOTH numerator (their cost) AND denominator (their well-months). All other metrics (Var $/BOE, Revenue, BOE totals) are unaffected.

At default 1.0 BOE/d threshold, 11 of 140 wells are excluded in 2025 (contributing <1% of BOE but dragging the per-well cost denominator).

---

## 5. Summary tab — stats boxes

Two sections, two tiers of boxes each.

### 5.1 TTM section (top)

**Heading:** "Trailing 12 Months (complete LOS data) — Net vs Gross"

**Subtitle:** "Last 12 months with active production per asset (stub/accrual-only months excluded). Per-asset TTM windows may differ if an asset has less history."

**TTM window:** for each asset, find the last 12 months where ActiveWells > 0 OR BOE > 0. Sum across those months. Label the window (e.g. "Feb-25 through Jan-26"). For assets with <12 months of history (Hawkeye), label "Last N active months".

#### TTM Consolidated cards — 2 panels (Net / Gross)

Each panel contains a basis badge, subtitle "Consolidated TTM ({range label})", and 8 KPI tiles in a 2×4 grid:

1. **Revenue** — Gross_Revenue (oil + gas + NGL sales before deducts); format `$X.XM`
2. **BOE/d (avg)** — `BOE / (12 × 30.4375)`; format `#,###`
3. **Realized $/BOE** — `Revenue / BOE`; format `$X.XX`
4. **Total Cash LOE $/BOE** — `(Var + Fix + Workover) / BOE`; format `$X.XX`
5. **Opex + WO + Capex** — `Var + Fix + Workover + Capex`; format `$X.XM`
6. **Operating Income** — `Net_Revenue − (Var + Fix + Workover)` where `Net_Revenue = Gross_Revenue − Gas_Netback − Severance − Adval`; format `$X.XM`
7. **Free Cash Flow** — `Operating Income − Total_Capex`; format `$X.XM`
8. **EBITDA Margin** — `Operating Income / Gross_Revenue`; format `X.X%`

#### TTM by Asset — 4 panels (Net basis only)

**Heading:** "TTM by Asset — Net"

Each asset panel: asset name in its theme color (Hawkeye `#D97706`, Strawn `#0369A1`, Reeves `#7C3AED`, Genesis `#059669`), range label subtitle, 6 KPI tiles in a 2×3 grid:

1. **Wells (avg)** — `(sum ActiveWells across TTM months) / active_months`; format `X.X`
2. **BOE/d (avg)**
3. **Revenue**
4. **Cash LOE $/BOE**
5. **Var $/BOE**
6. **EBITDA Margin**

### 5.2 2025 Headline section (below TTM)

**Heading:** "2025 Headline - Net vs Gross"

**Subtitle:** "Same LOS data viewed two ways: what Peak 10 received/paid (Net), and the full Gross LOS - costs scaled by 1/WI, volumes and revenue by 1/NRI (per-well). Ad val is normalized to active-months basis in all views."

Structure identical to TTM section (2 consolidated panels + 4 asset panels, same KPIs each) but computed over calendar-year 2025 instead of TTM window.

### 5.3 Summary charts (below KPI boxes)

1. **"Total Cash LOE $/BOE - by Basis (2025)"** — grouped bar chart. X-axis: 5 assets (Hawkeye/Strawn/Reeves/Genesis/Consolidated). Two side-by-side bars per asset: Net (dark navy), Gross (emerald green).

2. **"2025 Opex Breakdown by Asset (Net basis, side-by-side)"** — grouped bar chart. X-axis: 5 assets. Four side-by-side bars per asset: Variable Opex (amber), Fixed Opex (dark orange), Workover (violet), Capex (slate blue).

---

## 6. Monthly Trends tab — charts

### 6.1 Controls (sticky at top of tab)

- **Asset multi-select** (5 checkboxes): Hawkeye, Strawn, Reeves, Genesis, Consolidated. Default: 4 individual assets checked, Consolidated unchecked.
- **Basis selector** (dropdown): Net (Peak 10), Gross LOS. Default: Net.

When Consolidated is in the selected list, the Revenue+Cost stack chart uses ONLY Consolidated data (avoids double-count with individual asset bars). Other charts render each selected item as a separate series/bar.

Tip displayed below the controls: "click legend items to toggle; double-click to isolate a single series."

### 6.2 Chart 1 — Daily Production (line)

**Heading:** "Daily Production — Monthly Trend [Oil/Gas/BOE toggle]"

Three-button toggle in the heading:
- **BOE/d** (default) — uses `BOE / 30.4375`
- **Oil bbl/d** — uses `Oil_bbl / 30.4375`
- **Gas Mcf/d** — uses `Gas_mcf / 30.4375`

**Line chart.** X-axis = 29 periods (Oct-23 → Feb-26). One line per selected asset using asset colors. Border width 2, `pointRadius: 0`, `pointHoverRadius: 4`, `tension: 0.25`. Y-axis: `beginAtZero: true`, grid `#E2E5E9`, ticks formatted as numbers. Tooltip on hover shows series label + `{value} {unit}` where unit = `bbl/d` / `Mcf/d` / `BOE/d`.

### 6.3 Chart 2 — Revenue + Cost Stack (line + stacked bar)

**Heading:** "Revenue + Cost Stack — Monthly (Net basis)"

Mixed chart. X-axis = periods. Data = sum across selected assets at Net basis (or just Consolidated if that's selected).
- **Line** (order 0, emerald `#059669`, width 2): Revenue
- **Stacked bars** (order 1, `stack: "costs"`):
  - Fixed Opex (`#D97706cc`)
  - Variable Opex (`#F59E0Bcc`)
  - Workover (`#7C3AEDcc`)
  - Gas Netback (`#0369A1aa`)
  - Sev + AdVal combined (`#4E5E6Ecc`)

Y-axis stacked, ticks in money format.

### 6.4 Chart 3 — EBITDA Margin Quarterly (grouped bars)

**Heading:** "EBITDA Margin — Quarterly by Asset"

Quarterly bar chart. Quarters computed as `Math.ceil(Month / 3)`, labels `Q1-24`, `Q2-24`, etc. Per quarter: sum all months across selected assets (and Consolidated as a separate series if selected).

For each quarter, per selected asset:
```
Revenue      = sum(Gross_Revenue)
CashOpex     = sum(Var + Fix + Workover)
NetRev       = Revenue − Gas_Netback − Severance − Adval
EBITDA       = NetRev − CashOpex
EBITDA Margin = EBITDA / Revenue  (display as %)
```

Grouped bars (one bar per selected asset within each quarter). Y-axis: percent format. Tooltip shows `{asset}: {pct}`.

### 6.5 Chart 4 — FCF Margin Quarterly (grouped bars)

**Heading:** "FCF Margin — Quarterly by Asset"

Same structure as Chart 3 but metric:
```
FCF = EBITDA − Capex
FCF Margin = FCF / Revenue
```

### 6.6 Chart 5 — Total Cash Cost $/BOE Quarterly

**Heading:** "Total Cash Cost $/BOE — Quarterly by Asset"

Same structure. Metric: `CashOpex / BOE`. Y-axis: money2 format ($X.XX).

### 6.7 Chart 6 — Capex Quarterly

**Heading:** "Capex — Quarterly by Asset"

Same structure. Metric: `sum(Total_Capex)`. Y-axis: money format.

### 6.8 Chart 7 — Opex Intensity Quarterly

**Heading:** "Opex Intensity (Cash Opex / Revenue) — Quarterly by Asset"

Same structure. Metric: `CashOpex / Revenue`. Y-axis: percent format.

### 6.9 Chart 8 — Opex per Unit Quarterly (with $/BOE vs $/bbl toggle)

**Heading:** "Opex per Unit — Quarterly by Asset [BOE/BBL toggle]"

Two-button toggle in the heading: `$/BOE` (default), `$/bbl (oil)`.

**Note below the heading:** "Opex = Variable Opex + Fixed Opex (excludes workover and capex). $/bbl uses oil volume only; $/BOE uses total BOE."

Metric:
```
OpexNoWO = sum(Var + Fix)  (no workover, no capex)
When toggle = $/BOE: OpexNoWO / sum(BOE)
When toggle = $/bbl: OpexNoWO / sum(Oil_bbl)
```

Y-axis: money2 format.

### 6.10 Shared chart behavior

- All charts: `interaction: { mode: 'index', intersect: false }` — hover anywhere in the column shows tooltips for all series at that X.
- Tooltip style: navy background `rgba(0,24,48,0.95)`, white text, `Montserrat 700` title font, `JetBrains Mono` body font, navy 1px border, 10px padding, 4px corner radius.
- Legend: `position: top`, box width 12.
- Default Chart.js click behavior on legend (multi-select toggle). Custom double-click handler isolates a single series; double-click same item again restores all.

---

## 7. Monthly LOS Table tab

This is the primary tabular view and is the highest-fidelity replica target.

### 7.1 Sticky top (page-scroll-sticky container)

Wraps:
- Heading: "Monthly LOS Table"
- Subtitle: "Month-by-month P&L matching the source LOS format. Select one or more assets; data shown is the SUM of selected assets. Click the expand carets to drill into cost bucket sub-categories."
- Control row (see below)

CSS: `position: sticky; top: 0; z-index: 30; background: var(--bg); border-bottom: 1px solid var(--border);`

### 7.2 Control row

Horizontal flex layout with these controls (in order, labeled):
1. **Assets:** 4 checkboxes (Hawkeye / Strawn / Reeves / Genesis), all checked by default.
2. **Basis:** Net (Peak 10) / Gross LOS dropdown. Default Net.
3. **Years:** dropdown `All / 2023 / 2024 / 2025 / 2026`. Default All.
4. **Period:** dropdown `Monthly / Quarterly / Yearly`. Default Monthly.
5. **Activity filter:** dropdown `Off / ≥ 0.5 / ≥ 1.0 / ≥ 2.0 / ≥ 5.0 BOE/d`. Default ≥ 1.0. Widget text: "(N of 140 wells excluded in 2025)".

### 7.3 Panel / scroll container

```css
#mlos-panel {
  overflow: auto;         /* both horizontal AND vertical scrollbars */
  max-height: calc(100vh - 260px);
  background: var(--panel); border: 1px solid var(--border); border-radius: 6px;
  /* Styled webkit scrollbars visible, 12px, neutral tones */
}
```

### 7.4 Table structure

#### Column headers (`thead`)
- Column 1: `Line Item` (sticky left)
- Columns 2..N: period labels from the selected granularity (e.g. `Jan-25`, `Feb-25`, ... or `Q1-25`, ... or `2025`)
- Final column: `Total`

CSS: thead th `position: sticky; top: 0; background: var(--panel2); z-index: 20; box-shadow: 0 1px 0 var(--border)`. First-col header additionally `left: 0; z-index: 25`.

#### Body rows grouped into sections

Each section has a header row followed by its data rows. Sections (in display order):

1. **VOLUMES**
   - Oil (bbl), Gas (mcf), NGL (bbl), BOE

2. **GROSS REVENUE**
   - Oil Sales, Gas Sales, NGL Sales, **Total Gross Revenue** (bold)

3. **REVENUE DEDUCTIONS**
   - Gas Netback (gathering/processing/etc.), Severance Tax, Ad Valorem (normalized)

4. **NET REVENUE**
   - Net Revenue (bold)

5. **OPERATING EXPENSES**
   - **Variable Opex** — expandable (bucket: VAR_OPEX)
   - **Fixed Opex** — expandable (bucket: FIX_OPEX)
   - **Workover** — expandable (bucket: WORKOVER)
   - **Total Cash Opex** (bold)

6. **CAPITAL**
   - **Capex - Tangible** — expandable (bucket: CAPEX_T)
   - **Capex - Intangible** — expandable (bucket: CAPEX_I)
   - **Capex - Unsplit** — expandable (bucket: CAPEX_U)
   - **Total Capex** (bold)

7. **EBITDA / FCF**
   - EBITDA (Net Rev − Cash Opex) (bold)
   - FCF (EBITDA − Capex) (bold)

8. **METRICS** (derived per-unit lines; Total column recomputed from aggregated numerator/denominator)
   - Active Wells (count)
   - Realized $/BOE
   - Oil realized $/bbl
   - Gas realized $/Mcf
   - NGL realized $/bbl
   - WTI CMA settle $/bbl
   - Henry Hub LD settle $/MMBtu
   - Oil diff to WTI $/bbl
   - Gas diff to HH (sales $/Mcf − HH $/MMBtu)
   - NGL % of WTI
   - Gas Exp $/Mcf
   - Var Opex $/BOE
   - Fixed Opex $/Well (**filtered** if activity filter on)
   - Workover $/Well (**filtered** if activity filter on)
   - Lifting Cost $/BOE (var + fixed, excludes workover)
   - Total Cash Cost $/BOE
   - Opex Intensity (Cash Opex / Rev)
   - EBITDA Margin (% Gross Rev)
   - FCF Margin (% Gross Rev)
   - Capex / EBITDA

### 7.5 Sticky section headers — IMPORTANT

Each section header row (VOLUMES / GROSS REVENUE / etc.) is rendered with:
- 1 label cell (the title, class `first-col`)
- N filler cells (one per period + one for Total)

All cells in the row use `position: sticky; top: var(--mlos-section-top, 34px)` so the whole row stays visible when scrolling vertically. The label cell additionally has `left: 0; z-index: 18` so it stays in the left column when scrolling horizontally.

`--mlos-section-top` is measured at render time via `thead.offsetHeight` so the section header docks right below the dates row.

### 7.6 First column sticky + opaque

All body cells with class `first-col` use `position: sticky; left: 0; background: var(--panel) !important; z-index: 10; box-shadow: 1px 0 0 var(--border)`. No gap between the panel edge and the first-col — panel has no padding. This prevents cell bleed-through on horizontal scroll.

### 7.7 Expandable cost buckets

The 6 expandable rows (Variable Opex, Fixed Opex, Workover, Capex Tangible, Capex Intangible, Capex Unsplit) render a caret `▶` prepended to their label. Default state collapsed. On click: caret rotates to `▼`, child rows (one per sub-category in the bucket) appear beneath:

- Child row label: 4-space indented sub-category name
- Child row values: monthly values from `subs[bucket][subCategory]`
- Total column: sum across periods

Child row CSS: `background: rgba(0, 50, 100, 0.02); color: var(--text-dim); font-size: 11px`. Label cell still sticky left.

### 7.8 Period aggregation (Monthly/Quarterly/Yearly)

Monthly: show 29 or fewer period columns (filtered by year if Year != All).

Quarterly: group months by quarter. Quarter label `Q1-24`, etc. Sum all $ / volume fields across the 3 months. For derived ratios, recompute from aggregated numerator/denominator.

Yearly: one column per year (`2024`, `2025`, `2026`). Same aggregation logic.

The sub-bucket `subs` maps are deep-merged during aggregation so expansion still works.

### 7.9 Total column

For each row, compute a rightmost "Total" cell:
- **$ or volume rows:** plain sum across visible periods
- **Derived ratios:** recompute from aggregated numerator/denominator (e.g. Total Realized $/BOE = `sum(Gross_Revenue) / sum(BOE)`; Total EBITDA Margin = `sum(EBITDA) / sum(Gross_Revenue)`)
- **Benchmark settle prices** (WTI, HH): simple average across the periods that have a value

Background tint: `var(--panel2)` (slightly off-panel) with bold weight.

### 7.10 Activity filter integration in the table

When `ACTIVITY_THRESHOLD > 0`, Fixed $/Well and Workover $/Well rows source from the **filtered** series (`Fixed_Filt`, `WO_Filt`, `Wells_Filt`) instead of raw. Total column derives from summed filtered values. Quarterly/Yearly aggregation iterates all months in the bucket when looking up filtered monthly values.

---

## 8. Theme / formatting

### 8.1 Color palette (Peak 10 Energy)

```
--bg:         #F2F5F8   page background
--panel:      #FFFFFF   card background
--panel2:     #F2F5F8   subtle accent background
--border:     #E2E5E9   1px borders
--text:       #1A2332   primary text
--text-dim:   #4E5E6E   secondary / labels
--text-faint: #B1B5BB   tertiary
--accent:     #003264   Peak 10 primary navy
--navy:       #001830   header bar
--red:        #EF4444
--amber:      #F59E0B
--green:      #22C55E
```

Asset colors (for light-bg contrast):
```
Hawkeye:  #D97706  (amber-orange)
Strawn:   #0369A1  (slate blue)
Reeves:   #7C3AED  (violet)
Genesis:  #059669  (emerald)
Consolidated: #1A2332  (dark ink)
```

### 8.2 Typography

- UI sans: **Montserrat** (400, 500, 600, 700, 800) via Google Fonts
- Data mono: **JetBrains Mono** (400, 600, 700)
- `.num`, `.kpi-value`, table cells use JetBrains Mono with `font-variant-numeric: tabular-nums`
- `h1` 24px/700, `h2` 16px/700, `h3` 12px/700 uppercase 0.08em tracking

### 8.3 Branded header

Full-width navy bar at top of page:
```html
<div class="p10-header">
  <div class="p10-header-title">Peak 10 Energy — OPEX Lookback</div>
  <div class="p10-header-logo-wrap"><img src="peak10-logo.jpg" alt="Peak 10 Energy"></div>
</div>
```

Style:
- Background: `var(--navy)` = `#001830`
- Padding: 14px 32px
- Title: white, 18px, weight 700
- Logo: 34px height, white rounded box around it

### 8.4 Panels / cards

```css
.panel {
  background: var(--panel);
  border: 1px solid var(--border);
  border-radius: 6px;
  padding: 18px;
  margin-bottom: 16px;
  box-shadow: 0 1px 2px rgba(0,0,0,0.04);
}
```

### 8.5 Tables

```css
th {
  background: var(--panel2);
  color: var(--text-dim);
  font-weight: 700; font-size: 11px;
  text-transform: uppercase; letter-spacing: 0.05em;
  padding: 10px 12px;
  border-bottom: 1px solid var(--border);
}
td { padding: 9px 12px; border-bottom: 1px solid var(--border); }
tr:hover td { background: rgba(0, 50, 100, 0.04); }
```

### 8.6 Number formatting helpers

```js
fmtMoney(n)     // "$1.2M", "$850k", "$0"
fmtMoneyFull(n) // "$1,234,567"
fmtMoney2(n)    // "$12.34" (always 2 decimals)
fmtNum(n)       // "1,234" (integer with thousands sep)
fmtPct(n)       // "12.3%" (1 decimal by default)
```

---

## 9. Implementation checklist (replication)

- [ ] LOS Excel ingest: parse per-well sheets into long-format facts
- [ ] Account → (Bucket, SubCategory) mapping table
- [ ] Sign-flip on VOLUME + REVENUE buckets
- [ ] Oneline matching: exact → loose → manual overrides → asset-avg fallback
- [ ] Net → Gross scaling per bucket (§3.2)
- [ ] Ad val normalization: annual / 12 × active_months (§3.3)
- [ ] Active well + active month denominators (§3.4)
- [ ] Stub month mask (§3.5)
- [ ] Activity filter precomputed at 5 thresholds (§4)
- [ ] Benchmark data (WTI CMA + HH LD) monthly series embedded for oil/gas diff metrics
- [ ] TTM helper: find last N complete months per asset, aggregate
- [ ] 8 Summary KPI functions
- [ ] 8 Monthly Trends charts with asset + basis controls
- [ ] Monthly LOS Table with all controls, sticky behaviors, expandable buckets, period aggregation
- [ ] Peak 10 theme CSS + branded header + Montserrat/JetBrains Mono fonts
- [ ] Chart.js defaults: index-mode hover, navy tooltip

---

## 10. Reference links

- Live dashboard: <https://peak10-opex-lookback.netlify.app>
- GitHub repo: <https://github.com/kdmcquire-creator/peak10-opex-lookback>
- Peak 10 base-template repo (brand source): `C:\Projects\Peak-10-dashboard-template\`
- Source data folder: `C:\Users\kdmcq\Downloads\RE_ 12_25 LOS Reports\`
- Build pipeline: `C:\Projects\LOS_Lookback\` (Python scripts + generated HTML artifact)

Questions or gaps? See the dashboard's `Methodology` and `Exceptions` tabs for the authoritative running ledger of decisions.
