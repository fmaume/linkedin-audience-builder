import { Actor, log } from 'apify';
import { Orchestrator } from 'apify-orchestrator';

const STEPS = ['contactInfo', 'linkedinCompany'] as const;
type Step = (typeof STEPS)[number];

interface OrchestratorInput {
    domains: string[];
    maxDepth?: number;
    maxRequestsPerStartUrl?: number;
}

interface ContactInfoScraperInput {
    startUrls: { url: string }[];
    maxDepth: number;
    maxRequestsPerStartUrl: number;
    sameDomain: boolean;
}

interface LinkedInCompanyInput {
    companies: string[];
}

interface ContactInfoItem {
    originalStartUrl?: string;
    domain?: string;
    linkedIns?: string[];
}

interface LinkedInLocation {
    city?: string;
    state?: string;
    geographicArea?: string;
    country?: string | { code?: string; name?: string };
    countryCode?: string;
    postalCode?: string;
    line1?: string;
    headquarter?: boolean;
}

interface LinkedInCompanyItem {
    name?: string;
    website?: string;
    linkedinUrl?: string;
    industries?: string[];
    locations?: LinkedInLocation[];
}

function toHttpsUrl(input: string): string {
    const trimmed = input.trim();
    if (!trimmed) return trimmed;
    const withProto = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
    try {
        const u = new URL(withProto);
        return `${u.protocol}//${u.host}${u.pathname === '/' ? '' : u.pathname}`;
    } catch {
        return withProto;
    }
}

function parseHost(rawUrl: string): string | null {
    if (!rawUrl) return null;
    try {
        const u = new URL(rawUrl);
        let host = u.hostname.toLowerCase();
        if (host.startsWith('www.')) host = host.slice(4);
        return host || null;
    } catch {
        return null;
    }
}

function registrableDomain(host: string): string {
    const parts = host.split('.');
    if (parts.length <= 2) return host;
    return parts.slice(-2).join('.');
}

function extractCompanyLinkedInUrl(linkedIns: string[] | undefined): string | null {
    if (!linkedIns?.length) return null;
    for (const raw of linkedIns) {
        try {
            const u = new URL(raw);
            const host = u.hostname.toLowerCase();
            if (!host.endsWith('linkedin.com')) continue;
            if (!u.pathname.toLowerCase().startsWith('/company/')) continue;
            // Normalize: force https, drop query/hash, ensure trailing-slash-free.
            const path = u.pathname.replace(/\/+$/, '');
            return `https://www.linkedin.com${path}`;
        } catch {
            continue;
        }
    }
    return null;
}

function pickCountry(loc: LinkedInLocation): string {
    if (typeof loc.country === 'string') return loc.country;
    if (loc.country && typeof loc.country === 'object') {
        return loc.country.code ?? loc.country.name ?? '';
    }
    return loc.countryCode ?? '';
}

function fmtUsd(v: number): string {
    return Number.isFinite(v) ? `$${v.toFixed(4)}` : '∞';
}

await Actor.init();

const input = await Actor.getInput<OrchestratorInput>();
if (!input || !Array.isArray(input.domains) || input.domains.length === 0) {
    throw new Error('Missing required input: "domains" must be a non-empty array of website domains.');
}

const cleanDomains = [...new Set(input.domains.map((d) => d.trim()).filter(Boolean))];
if (cleanDomains.length === 0) {
    throw new Error('Input "domains" is empty after trimming.');
}
const maxDepth = input.maxDepth ?? 1;
const maxRequestsPerStartUrl = input.maxRequestsPerStartUrl ?? 5;

const orchestrator = new Orchestrator({
    enableLogs: true,
    persistenceSupport: 'kvs',
    persistencePrefix: 'ORCH-',
    abortAllRunsOnGracefulAbort: true,
});
const client = await orchestrator.apifyClient({ name: 'MAIN' });

// The total cost cap is a Run option (`maxTotalChargeUsd`) — set by the caller via
// Apify Console → Advanced → Max total charge, the API, or apify-client. We read
// it back from this Run's own options and split it evenly across STEPS. Local
// `apify run` uses a synthetic Run ID that doesn't exist on the platform, so we
// swallow that error and fall back to uncapped.
const env = Actor.getEnv();
let maxCostUsd = Number.POSITIVE_INFINITY;
if (env.actorRunId) {
    try {
        const selfRun = await client.run(env.actorRunId).get();
        const cap = selfRun?.options?.maxTotalChargeUsd;
        if (typeof cap === 'number' && cap > 0) maxCostUsd = cap;
    } catch (err) {
        log.debug(
            `Could not read self-Run options (${err instanceof Error ? err.message : String(err)}); running without cost cap.`,
        );
    }
}
const perStepCap = maxCostUsd / STEPS.length;
let spent = 0;
const remaining = (): number => maxCostUsd - spent;

function planStepCap(step: Step): number | undefined {
    const rem = remaining();
    if (rem <= 0) {
        throw new Error(
            `Cost cap ${fmtUsd(maxCostUsd)} reached before step "${step}" (already spent ${fmtUsd(spent)}).`,
        );
    }
    if (!Number.isFinite(perStepCap)) return undefined;
    return Math.min(perStepCap, rem);
}

function recordSpend(step: string, cost: number): void {
    spent += cost;
    log.info(
        `Step "${step}" spent ${fmtUsd(cost)}; cumulative ${fmtUsd(spent)} of ${fmtUsd(maxCostUsd)} (${fmtUsd(remaining())} remaining).`,
    );
}

log.info(
    `Cost cap for this run: ${fmtUsd(maxCostUsd)} (from Run options). Per-step cap (even split across ${STEPS.length} steps): ${fmtUsd(perStepCap)}.`,
);

// ---------- Step 1: vdrmota/contact-info-scraper ----------
// https://apify.com/vdrmota/contact-info-scraper
const startUrls = cleanDomains.map((d) => ({ url: toHttpsUrl(d) }));
const domainByHost = new Map<string, string>();
for (const raw of cleanDomains) {
    const host = parseHost(toHttpsUrl(raw));
    if (host) domainByHost.set(registrableDomain(host), raw);
}

const contactCap = planStepCap('contactInfo');
log.info(
    `Step 1: contact-info-scraper on ${startUrls.length} domain(s), maxDepth=${maxDepth}, maxRequestsPerStartUrl=${maxRequestsPerStartUrl}, cap ${contactCap != null ? fmtUsd(contactCap) : 'unlimited'}`,
);

const contactInput: ContactInfoScraperInput = {
    startUrls,
    maxDepth,
    maxRequestsPerStartUrl,
    sameDomain: true,
};
const contactRun = await client
    .actor('vdrmota/contact-info-scraper')
    .call('contact-info', contactInput, contactCap != null ? { maxTotalChargeUsd: contactCap } : undefined);
recordSpend('contactInfo', contactRun.usageTotalUsd ?? 0);
log.info(`contact-info-scraper finished: ${contactRun.id} (status: ${contactRun.status})`);

// ---------- Step 2 prep: pick one LinkedIn company URL per input domain ----------
const linkedinByDomain = new Map<string, string>();
for await (const item of client.dataset(contactRun.defaultDatasetId).iterate({ pageSize: 100 })) {
    const row = item as ContactInfoItem;
    const linkedInUrl = extractCompanyLinkedInUrl(row.linkedIns);
    if (!linkedInUrl) continue;

    const sourceUrl = row.originalStartUrl ?? '';
    const sourceHost = parseHost(sourceUrl);
    const domainKey = sourceHost ? registrableDomain(sourceHost) : row.domain ?? '';
    if (!domainKey) continue;
    if (linkedinByDomain.has(domainKey)) continue;
    linkedinByDomain.set(domainKey, linkedInUrl);
}

for (const originalDomain of cleanDomains) {
    const host = parseHost(toHttpsUrl(originalDomain));
    const key = host ? registrableDomain(host) : originalDomain;
    if (!linkedinByDomain.has(key)) {
        log.warning(`No LinkedIn company URL found for domain: ${originalDomain}`);
    }
}

const linkedInUrls = [...new Set(linkedinByDomain.values())];
if (linkedInUrls.length === 0) {
    log.warning('No LinkedIn company URLs were resolved from any input domain. Nothing to enrich.');
    await Actor.setValue('SUB_DATASETS', [
        {
            name: 'vdrmota/contact-info-scraper',
            resultUrl: `https://console.apify.com/storage/datasets/${contactRun.defaultDatasetId}`,
        },
    ]);
    await Actor.exit();
}

// ---------- Step 2: harvestapi/linkedin-company ----------
// https://apify.com/harvestapi/linkedin-company
const linkedinCap = planStepCap('linkedinCompany');
log.info(
    `Step 2: harvestapi/linkedin-company on ${linkedInUrls.length} LinkedIn company URL(s), cap ${linkedinCap != null ? fmtUsd(linkedinCap) : 'unlimited'}`,
);
const linkedInInput: LinkedInCompanyInput = { companies: linkedInUrls };
const linkedInRun = await client
    .actor('harvestapi/linkedin-company')
    .call(
        'linkedin-company',
        linkedInInput,
        linkedinCap != null ? { maxTotalChargeUsd: linkedinCap } : undefined,
    );
recordSpend('linkedinCompany', linkedInRun.usageTotalUsd ?? 0);
log.info(`harvestapi/linkedin-company finished: ${linkedInRun.id} (status: ${linkedInRun.status})`);

// ---------- Step 3: explode into CSV rows (industry × location) ----------
let companiesEmitted = 0;
let rowsEmitted = 0;
for await (const item of client.dataset(linkedInRun.defaultDatasetId).iterate({ pageSize: 100 })) {
    const company = item as LinkedInCompanyItem;
    const industries = company.industries && company.industries.length > 0 ? company.industries : [''];
    const locations = company.locations && company.locations.length > 0 ? company.locations : [{}];

    const companyname = company.name ?? '';
    const companywebsite = company.website ?? '';
    const companyemaildomain = parseHost(companywebsite) ?? '';
    const linkedincompanypageurl = company.linkedinUrl ?? '';

    companiesEmitted += 1;
    for (const industry of industries) {
        for (const loc of locations) {
            await Actor.pushData({
                companyname,
                companywebsite,
                companyemaildomain,
                linkedincompanypageurl,
                stocksymbol: '',
                industry: industry ?? '',
                city: loc.city ?? '',
                state: loc.state ?? loc.geographicArea ?? '',
                companycountry: pickCountry(loc),
                zipcode: loc.postalCode ?? '',
            });
            rowsEmitted += 1;
        }
    }
}
log.info(`Emitted ${rowsEmitted} audience row(s) across ${companiesEmitted} enriched compan(y|ies).`);

await Actor.setValue('SUB_DATASETS', [
    {
        name: 'vdrmota/contact-info-scraper',
        resultUrl: `https://console.apify.com/storage/datasets/${contactRun.defaultDatasetId}`,
    },
    {
        name: 'harvestapi/linkedin-company',
        resultUrl: `https://console.apify.com/storage/datasets/${linkedInRun.defaultDatasetId}`,
    },
]);

log.info(`Done. Total tracked child-Run cost: ${fmtUsd(spent)}.`);
await Actor.exit();
