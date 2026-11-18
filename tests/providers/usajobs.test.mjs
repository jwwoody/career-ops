// tests/providers/usajobs.test.mjs — USAJobs provider: field mapping, credential
// gating and pagination, against a fixture shaped like the documented Search API
// response. No network: ctx.fetchJson is a stub.
import { pass, fail, ROOT } from '../helpers.mjs';
import { join } from 'path';
import { pathToFileURL } from 'url';

console.log('\nProvider — usajobs');

const mod = await import(pathToFileURL(join(ROOT, 'providers/usajobs.mjs')).href);
const provider = mod.default;
const { mapItem, mapSalary, hiringPathAllowed } = mod;

const item = {
  MatchedObjectId: '123456',
  MatchedObjectDescriptor: {
    PositionID: 'DE-2026-0001',
    PositionTitle: 'Data Science Intern',
    PositionURI: 'https://www.usajobs.gov/job/123456',
    OrganizationName: 'Department of Example',
    PositionLocation: [{ LocationName: 'Washington, District of Columbia' }],
    PublicationStartDate: '2026-10-01',
    QualificationSummary: 'Currently enrolled in a degree program.',
  },
};

if (provider.id === 'usajobs') pass('usajobs.id is "usajobs"');
else fail(`usajobs.id is ${JSON.stringify(provider.id)}`);

if (provider.detect === undefined) pass('usajobs has no detect(): explicit-only, never claims a URL');
else fail('usajobs must not define detect()');

const job = mapItem(item);
if (job?.title === 'Data Science Intern' && job.url === 'https://www.usajobs.gov/job/123456'
  && job.company === 'Department of Example' && job.location === 'Washington, District of Columbia'
  && job.requisitionId === 'DE-2026-0001' && Number.isFinite(job.postedAt)) {
  pass('mapItem maps title, public URL, agency, location, posting date and requisition id');
} else {
  fail(`mapItem produced ${JSON.stringify(job)}`);
}


// The live API returns the default port in PositionURI; it must still map.
const withPort = mapItem({ MatchedObjectDescriptor: { PositionTitle: 'Software Engineer', PositionURI: 'https://www.usajobs.gov:443/job/883691200' } });
if (withPort?.url === 'https://www.usajobs.gov/job/883691200') pass('mapItem accepts the :443 port the live API returns and strips it');
else fail(`mapItem with :443 produced ${JSON.stringify(withPort)}`);
if (mapItem({ MatchedObjectDescriptor: { PositionTitle: 'X', PositionURI: 'http://evil.example/job/1' } }) === null) {
  pass('mapItem drops items whose URL is not a usajobs.gov https link');
} else {
  fail('mapItem accepted a non-usajobs URL');
}

// Credential gating: no key or email means no request and an empty result.
const savedKey = process.env.USAJOBS_API_KEY;
const savedEmail = process.env.USAJOBS_CONTACT_EMAIL;
let calls = 0;
const ctxStub = { fetchJson: async () => { calls++; return { SearchResult: { SearchResultItems: [], SearchResultCountAll: 0 } }; } };

delete process.env.USAJOBS_API_KEY;
delete process.env.USAJOBS_CONTACT_EMAIL;
const withoutCreds = await provider.fetch({ name: 'USAJobs' }, ctxStub);
if (withoutCreds.length === 0 && calls === 0) pass('usajobs makes no request without credentials');
else fail(`usajobs made ${calls} request(s) without credentials`);

// Pagination and dedup across terms, with credentials set.
process.env.USAJOBS_API_KEY = 'test-key';
process.env.USAJOBS_CONTACT_EMAIL = 'test@example.invalid';
const seenHeaders = [];
const pagedCtx = {
  fetchJson: async (url, opts) => {
    seenHeaders.push(opts?.headers);
    const page = Number(new URL(url).searchParams.get('Page'));
    if (page === 1) {
      const items = Array.from({ length: 500 }, (_, i) => ({
        MatchedObjectDescriptor: { PositionTitle: `Intern ${i}`, PositionURI: `https://www.usajobs.gov/job/${i}` },
      }));
      return { SearchResult: { SearchResultItems: items, SearchResultCountAll: 501 } };
    }
    return { SearchResult: { SearchResultItems: [item], SearchResultCountAll: 501 } };
  },
  sleep: async () => {},
};
const paged = await provider.fetch({ name: 'USAJobs', search_terms: ['data science intern'] }, pagedCtx);
if (paged.length === 501) pass('usajobs follows pages until the reported total is reached');
else fail(`usajobs returned ${paged.length} jobs, expected 501`);

if (seenHeaders.every((h) => h['Authorization-Key'] === 'test-key' && h['User-Agent'] === 'test@example.invalid')) {
  pass('usajobs sends the key in Authorization-Key and the contact email in User-Agent');
} else {
  fail(`usajobs headers were ${JSON.stringify(seenHeaders[0])}`);
}

// Salary: annual (PA) rows map to the scanner's salary shape; other intervals are left out.
const annual = mapSalary({ PositionRemuneration: [{ MinimumRange: '104349', MaximumRange: '161313', RateIntervalCode: 'PA' }] });
if (annual?.min === 104349 && annual.max === 161313 && annual.currency === 'USD') pass('mapSalary maps a per-year range to {min, max, currency: USD}');
else fail(`mapSalary produced ${JSON.stringify(annual)}`);
if (mapSalary({ PositionRemuneration: [{ MinimumRange: '25.10', MaximumRange: '32.63', RateIntervalCode: 'PH' }] }) === undefined) {
  pass('mapSalary leaves an hourly range out rather than converting it');
} else {
  fail('mapSalary converted an hourly range');
}
if (mapSalary({ PositionRemuneration: [{ MinimumRange: '0', MaximumRange: '', RateIntervalCode: 'PA' }] }) === undefined && mapSalary({}) === undefined) {
  pass('mapSalary returns nothing when the source gives no real figures');
} else {
  fail('mapSalary invented a salary from empty figures');
}
const withPay = mapItem({ MatchedObjectDescriptor: { ...item.MatchedObjectDescriptor, PositionRemuneration: [{ MinimumRange: '90000', MaximumRange: '120000', RateIntervalCode: 'PA' }] } });
if (withPay?.salary?.min === 90000 && withPay.salary.max === 120000) pass('mapItem attaches the annual salary');
else fail(`mapItem salary was ${JSON.stringify(withPay?.salary)}`);
if (mapItem(item)?.salary === undefined) pass('mapItem omits salary when the posting has none');
else fail('mapItem attached a salary to a posting without one');

// Hiring path: default keeps postings open to the public only.
const hp = (paths) => ({ MatchedObjectDescriptor: { ...item.MatchedObjectDescriptor, UserArea: { Details: { HiringPath: paths } } } });
if (hiringPathAllowed(hp(['fed-transition', 'public']), ['public']) && !hiringPathAllowed(hp(['fed-internal-search']), ['public'])) {
  pass('hiringPathAllowed keeps public postings and drops federal-internal ones');
} else {
  fail('hiringPathAllowed did not split public from internal postings');
}
if (hiringPathAllowed(hp(['vet']), ['public', 'vet']) && hiringPathAllowed(hp(['nguard']), [])) {
  pass('hiringPathAllowed honours a custom list, and an empty list keeps everything');
} else {
  fail('hiringPathAllowed ignored a custom or empty list');
}
if (hiringPathAllowed(item, ['public'])) pass('hiringPathAllowed keeps a posting that states no hiring path');
else fail('hiringPathAllowed dropped a posting with no hiring path');

const mixedCtx = {
  fetchJson: async () => ({ SearchResult: { SearchResultCountAll: 2, SearchResultItems: [
    { MatchedObjectDescriptor: { ...hp(['public']).MatchedObjectDescriptor, PositionURI: 'https://www.usajobs.gov/job/1' } },
    { MatchedObjectDescriptor: { ...hp(['fed-internal-search']).MatchedObjectDescriptor, PositionURI: 'https://www.usajobs.gov/job/2' } },
  ] } }),
};
const byDefault = await provider.fetch({ name: 'USAJobs', search_terms: ['x'] }, mixedCtx);
const allPaths = await provider.fetch({ name: 'USAJobs', search_terms: ['x'], hiring_paths: [] }, mixedCtx);
if (byDefault.length === 1 && byDefault[0].url.endsWith('/job/1') && allPaths.length === 2) {
  pass('usajobs fetch drops non-public postings by default; hiring_paths: [] keeps them');
} else {
  fail(`usajobs fetch returned ${byDefault.length} by default and ${allPaths.length} with hiring_paths: []`);
}

if (savedKey === undefined) delete process.env.USAJOBS_API_KEY; else process.env.USAJOBS_API_KEY = savedKey;
if (savedEmail === undefined) delete process.env.USAJOBS_CONTACT_EMAIL; else process.env.USAJOBS_CONTACT_EMAIL = savedEmail;
