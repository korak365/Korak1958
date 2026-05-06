# ArXiv Research Synthesizer

Scrapes new AI papers listed on arXiv, downloads PDFs (optional), and extracts key findings into structured JSON for downstream analysis and training.

## Features

- Crawl arXiv listing pages (e.g., cs.AI, cs.LG recent submissions).
- Visit abstract pages, extract title, authors, abstract, and submission date.
- Download PDF and parse text (optional) to extract additional findings.
- Save PDFs to Key-Value store and metadata to the default Dataset.

## Installation

1. Create project folders and paste files into `.actor/` and `src/`.
2. Install dependencies:
```bash
npm install
```

## Usage

Run locally:
```bash
apify run
```

Input example (storage/key_value_stores/default/INPUT.json):
```json
{
  "startUrls": [
    { "url": "https://arxiv.org/list/cs.AI/recent" },
    { "url": "https://arxiv.org/list/cs.LG/recent" }
  ],
  "maxRequestsPerCrawl": 200,
  "downloadPdf": true,
  "minAbstractLength": 50,
  "maxPapers": 200,
  "includeCrossListings": true
}
```

## Important notes

- Respect arXiv's robots.txt and terms of use. For large-scale harvesting prefer using the official arXiv API where appropriate.
- Downloading many PDFs can use significant bandwidth and storage. Use `downloadPdf: false` to only collect metadata.
- PDF text extraction is best-effort; complex PDFs may yield noisy text. Consider integrating specialized PDF/NLP tools or human review for final datasets.

## Deploy

1. Login to Apify:
```bash
apify login
```

2. Push to Apify platform:
```bash
apify push
```

## Output format

Dataset items look like:
```json
{
  "arxivId": "2301.01234",
  "title": "Example Paper Title",
  "authors": ["Author A", "Author B"],
  "abstract": "The abstract text ...",
  "published": "Submitted on 1 Jan 2026",
  "pdfUrl": "https://arxiv.org/pdf/2301.01234.pdf",
  "pdfKey": "pdfs/2301.01234.pdf",
  "keyFindings": [
    "We propose a novel architecture that ...",
    "We achieve state-of-the-art results on ..."
  ],
  "pageUrl": "https://arxiv.org/abs/2301.01234",
  "timestamp": "2026-05-06T12:34:56Z"
}
```

## License

ISC