// ArXiv Research Synthesizer
// Scrapes arXiv listing pages, visits abstract pages, downloads PDFs (optional), and extracts key findings (heuristic).
//
// Note: This Actor uses CheerioCrawler (HTTP-based). It performs best-effort extraction of PDFs and text.
// For more advanced PDF NLP, consider adding an LLM step or a more robust PDF parsing/ML pipeline.

import { Actor } from 'apify';
import { CheerioCrawler, Dataset, KeyValueStore } from 'crawlee';
import pdfParse from 'pdf-parse';

await Actor.init();

const {
    startUrls = ['https://arxiv.org/list/cs.AI/recent'],
    maxRequestsPerCrawl = 200,
    downloadPdf = true,
    minAbstractLength = 50,
    maxPapers = 500,
    includeCrossListings = true
} = (await Actor.getInput()) ?? {};

const proxyConfiguration = await Actor.createProxyConfiguration();
let kvStore = null;
if (downloadPdf) {
    kvStore = await KeyValueStore.open(); // default store
}

let savedCount = 0;

const crawler = new CheerioCrawler({
    proxyConfiguration,
    maxRequestsPerCrawl,
    async requestHandler({ request, $, enqueueLinks, log, session }) {
        const url = request.loadedUrl;
        log.info('Processing', { url });

        try {
            // If listing page (e.g., /list/...), enqueue abstract pages
            if (/\/list\//.test(url) || /\/search\?/.test(url)) {
                // arXiv list: links to /abs/<id>
                await enqueueLinks({
                    selector: 'a[href*="/abs/"]',
                    globs: ['**/abs/*'],
                    transformRequestFunction: (r) => ({ ...r, userData: { type: 'abs-link' } })
                }).catch(() => {});
                // follow pagination
                await enqueueLinks({
                    selector: 'a[title="Next"]',
                    globs: ['**?skip=*', '**/list/**'],
                }).catch(() => {});
                return;
            }

            // Abstract page - contains /abs/<id>
            if (/\/abs\//.test(url)) {
                // Parse arXiv ID
                const m = url.match(/\/abs\/([^\/?#]+)/);
                if (!m) return;
                const arxivId = m[1];

                // Title
                let title = $('h1.title').text().replace(/^Title:\s*/i, '').trim();
                if (!title) title = $('meta[name="citation_title"]').attr('content') || '';

                // Authors
                const authors = [];
                $('div.authors a').each((i, el) => {
                    const a = $(el).text().trim();
                    if (a) authors.push(a);
                });
                if (authors.length === 0) {
                    // fallback to meta tags
                    const metaAuthors = $('meta[name="citation_author"]');
                    metaAuthors.each((i, el) => authors.push($(el).attr('content')));
                }

                // Abstract
                let abstract = $('blockquote.abstract').text().replace(/^Abstract:\s*/i, '').trim();
                if (!abstract) abstract = $('meta[name="description"]').attr('content') || '';

                if (!abstract || abstract.length < minAbstractLength) {
                    log.info('Skipping due to abstract length', { arxivId, length: abstract.length });
                    return;
                }

                // Published / submitted date
                let published = $('div.dateline').text().trim();
                if (!published) {
                    published = $('meta[name="citation_date"]').attr('content') || '';
                }

                // PDF URL
                let pdfUrl = '';
                const pdfLink = $('a[href$=".pdf"]').first();
                if (pdfLink && pdfLink.attr('href')) {
                    pdfUrl = new URL(pdfLink.attr('href'), 'https://arxiv.org').href;
                } else {
                    // fallback raw pattern
                    pdfUrl = `https://arxiv.org/pdf/${arxivId}.pdf`;
                }

                // Heuristic key findings extraction from abstract
                const keyFindings = extractKeyFindingsFromText(abstract);

                // Optionally fetch and parse PDF first page(s) for additional findings
                let pdfKey = null;
                if (downloadPdf && kvStore && pdfUrl) {
                    try {
                        const res = await fetch(pdfUrl, { redirect: 'follow' });
                        if (res.ok) {
                            const buff = Buffer.from(await res.arrayBuffer());
                            // Save PDF to Key-Value store
                            pdfKey = `pdfs/${arxivId}.pdf`;
                            await kvStore.setValue(pdfKey, buff, { contentType: 'application/pdf' });
                            log.info('Saved PDF to KVS', { pdfKey });

                            // Parse PDF text (best-effort)
                            try {
                                const data = await pdfParse(buff, { max: 5 * 1024 * 1024 }); // limit
                                const pdfText = data.text || '';
                                // Heuristic: extract more findings from PDF text
                                const moreFindings = extractKeyFindingsFromText(pdfText, 5);
                                // Merge unique findings, preserve order
                                for (const f of moreFindings) {
                                    if (!keyFindings.includes(f)) keyFindings.push(f);
                                }
                            } catch (e) {
                                log.warning('PDF parse failed', { arxivId, error: e.message });
                            }
                        } else {
                            log.warning('Failed to download PDF', { arxivId, status: res.status });
                        }
                    } catch (e) {
                        log.warning('Error fetching PDF', { arxivId, error: e.message });
                    }
                }

                // Save item
                await Dataset.pushData({
                    arxivId,
                    title,
                    authors,
                    abstract,
                    published,
                    pdfUrl,
                    pdfKey,
                    keyFindings,
                    pageUrl: url,
                    timestamp: new Date().toISOString()
                });

                savedCount++;
                log.info('Saved paper', { arxivId, savedCount });

                // Stop saving new items if maxPapers reached
                if (savedCount >= maxPapers) {
                    log.info('Reached maxPapers, aborting crawl', { maxPapers });
                    // signal runner to stop by throwing
                    throw new Error('MAX_PAPERS_REACHED');
                }
            }
        } catch (err) {
            if (err.message === 'MAX_PAPERS_REACHED') throw err;
            log.warning('Request handler error', { url, error: err.message });
        }
    },
    // keep default respectful settings; Crawlee respects robots.txt by default when configured
});

try {
    await crawler.run(startUrls);
} catch (err) {
    if (err.message === 'MAX_PAPERS_REACHED') {
        console.log('Stopped early after reaching max papers.');
    } else {
        console.error('Crawler failed', err);
    }
}

console.log('Actor finished.');
await Actor.exit();

/* ---------- Helpers ---------- */

function extractKeyFindingsFromText(text, maxFindings = 3) {
    if (!text || !text.trim()) return [];
    // Normalize whitespace
    const cleaned = text.replace(/\s+/g, ' ').trim();
    // Split into sentences (simple heuristic)
    const sentences = cleaned.split(/(?<=[.?!])\s+(?=[A-Z0-9"“‘'()])/g).map(s => s.trim()).filter(Boolean);

    const findings = [];

    // First: sentences containing common contribution phrases
    const contribPatterns = [
        /\bwe (propose|present|introduce|describe|develop|show|demonstrate)\b/i,
        /\bthis paper (presents|proposes|introduces|shows)\b/i,
        /\bour (contributions|contribution)\b/i,
        /\bwe (achieve|obtain|reach|report)\b/i,
        /\bexperiments (show|demonstrate|indicate)\b/i
    ];

    for (const s of sentences) {
        if (findings.length >= maxFindings) break;
        if (contribPatterns.some(p => p.test(s))) {
            findings.push(s);
        }
    }

    // Second: take the first N sentences as fallback
    for (const s of sentences) {
        if (findings.length >= maxFindings) break;
        if (!findings.includes(s)) findings.push(s);
    }

    // Trim to maxFindings and deduplicate
    return Array.from(new Set(findings)).slice(0, maxFindings);
}