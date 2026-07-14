# LinkedIn Company Audience Builder

This Actor turns a list of **website domains** into a company list ready to upload in **LinkedIn Campaign Manager audience manager**.

## What does LinkedIn Audience Builder do?

Give it a list of company domains (`apify.com`, `linkedin.com`, `netflix.com`, …). It resolves each domain to the company's LinkedIn page, pulls the company's industries and locations from LinkedIn, and emits one row per **(company × industry × location)** combination. The dataset uses the exact field names that LinkedIn Campaign Manager expects, so the CSV export from the Apify Console can be uploaded as a **Company List audience** with no post-processing.

Under the hood, the Actor chains two Apify Store scrapers:

1. [`vdrmota/contact-info-scraper`](https://apify.com/vdrmota/contact-info-scraper) — crawls each domain and extracts the LinkedIn company URL from the site.
2. [`harvestapi/linkedin-company`](https://apify.com/harvestapi/linkedin-company) — enriches each LinkedIn page with company name, website, industries, and locations.


## Why use LinkedIn Audience Builder?

- **Skip manual CSV construction.** LinkedIn's audience template demands very specific column names — this Actor produces them for you.
- **Cover every industry × location.** LinkedIn's ad targeting matches against the audience row-by-row, so expanding one company into multiple rows widens the match surface.
- **Enrich data at scale.** This Actor does the heavy lifting for you. So you can quickly build audience lists for your ABM campaign.
  
## How to build a LinkedIn Company List audience

1. Open the Actor's **Input** tab.
2. Paste your list of domains into **Website domains** (bare domains like `apify.com` and full URLs both work).
3. (Optional) In **Advanced**, set **Max total charge** in USD to cap spend.
4. Click **Start**. Watch the two child Runs appear in your Apify Console.
5. When the Run finishes, open the **Storage → Dataset** tab and click **Download → CSV**.
6. Upload the CSV into LinkedIn Campaign Manager → Plan → Audiences → Create → Upload a list → Company list.

## Input

| Field | Type | Default | Description |
|---|---|---|---|
| `domains` | `array<string>` | *required* | Website domains to enrich. `["apify.com", "linkedin.com"]`. |
| `maxDepth` | integer | `1` | How deep the contact-info scraper crawls on each domain hunting for the LinkedIn footer link. |
| `maxRequestsPerStartUrl` | integer | `5` | Cap on pages the contact-info scraper visits per input domain. |

The cost cap is **not** an input field — set it when triggering the Run (Apify Console → Advanced → **Max total charge**, or `maxTotalChargeUsd` via the API/SDK).

## Output

The default dataset holds rows whose field names match LinkedIn's audience template exactly:

```json
{
    "companyname": "Netflix",
    "companywebsite": "https://www.netflix.com",
    "companyemaildomain": "netflix.com",
    "linkedincompanypageurl": "https://www.linkedin.com/company/netflix",
    "stocksymbol": "",
    "industry": "Entertainment Providers",
    "city": "Los Gatos",
    "state": "California",
    "companycountry": "US",
    "zipcode": "95032"
}
```

You can download the dataset in various formats such as JSON, HTML, CSV, or Excel — CSV is what LinkedIn Campaign Manager wants.

### Data table

| Field | Source |
|---|---|
| `companyname` | LinkedIn company page — `name` |
| `companywebsite` | LinkedIn company page — `website` |
| `companyemaildomain` | derived from `companywebsite` (host without `www.`) |
| `linkedincompanypageurl` | LinkedIn company page — canonical URL |
| `stocksymbol` | left blank (LinkedIn's audience match ignores it in most cases) |
| `industry` | one entry from LinkedIn's `industries` array — one row per industry |
| `city` / `state` / `companycountry` / `zipcode` | one entry from LinkedIn's `locations` array — one row per location |

## Pricing / Cost estimation

The Actor bills you for the two paid sub-Actors it calls; the orchestrator itself is compute-only.

- `vdrmota/contact-info-scraper` — from **$1.05 / 1,000 pages**.
- `harvestapi/linkedin-company` — from **$3.00 / 1,000 companies**.

For 500 domains with a homepage-only crawl (`maxDepth: 0`, `maxRequestsPerStartUrl: 1`), a rough estimate is `500 * $0.00105 + 500 * $0.003 ≈ $2.03`. Set **Max total charge** slightly above your worst-case estimate to bind spend.

## Tips / Advanced options

- Lower `maxDepth` and `maxRequestsPerStartUrl` when your domains reliably surface the LinkedIn URL in the footer — this typically halves cost.
- The output row count is `Σ (industries_i × locations_i)` across enriched companies. Expect 3–15 rows per US company; LinkedIn's smaller international pages often produce a single row.
- To resume a failed Run, click **Resurrect** in the Apify Console — the orchestrator persists progress in the key-value store and reattaches to already-completed sub-Actor runs.

## FAQ, disclaimers, and support

- **A domain didn't produce any row.** The contact-info scraper found no LinkedIn URL on that site. Look in the Run log for a `No LinkedIn company URL found for domain: …` warning. Add the LinkedIn URL manually to LinkedIn's audience upload, or raise `maxDepth`.
- **My CSV has empty `state` / `zipcode` cells.** LinkedIn doesn't always return complete location details. Empty cells are safe — LinkedIn Audience Manager treats them as "any".
- **Is scraping LinkedIn allowed?** This Actor uses [`harvestapi/linkedin-company`](https://apify.com/harvestapi/linkedin-company), whose author is responsible for scrape compliance. Review LinkedIn's Terms of Service and your local law before large-scale use.

Found a bug or want a feature? Open an issue on this Actor's **Issues** tab.
