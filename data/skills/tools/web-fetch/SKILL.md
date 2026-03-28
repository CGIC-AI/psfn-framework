---
name: "web-fetch"
description: "Fetch web content using the crawl4ai service at purrsephone.local"
category: "tools"
created: "2026-02-27T05:10:01.689Z"
updated: "2026-02-27T05:10:01.689Z"
version: 1
---
# Web Fetch Skill

Prefer the top-level `web_fetch` tool for routine page reads.

Use `lane: "default"` for normal web pages.
Use `lane: "local_crawler"` only when you explicitly need the local crawler path.

The raw crawl4ai endpoint below is backend detail and fallback only.

## Service Location
Base URL: `http://purrsephone.local.vega.nyc:11235/`

## Methods

### Method 1: Get Markdown (Simple)
```
GET /md/{url_encoded}?f=fit
```
- URL must be URL-encoded
- `f=fit` extracts main content, removes headers/footers/nav/ads
- Returns clean markdown

Example:
- To fetch `https://example.com/article`
- Request: `GET /md/https%3A%2F%2Fexample.com%2Farticle?f=fit`

### Method 2: Batch Crawl (Advanced)
```
POST /crawl
Content-Type: application/json

{
  "urls": ["https://example.com"],
  "crawler_config": { "stream": false }
}
```
- Max 100 URLs per request
- Returns results after all processed

## Usage
When asked to read a URL or fetch web content:
1. Prefer the top-level `web_fetch` tool
2. Only fall back to the raw crawl4ai endpoint if the tool path is unavailable
3. Return the fetched content to the user

## Notes
- This service runs locally on Vega's network
- Use for reading articles, documentation, etc.
- The fit filter provides clean, readable content
