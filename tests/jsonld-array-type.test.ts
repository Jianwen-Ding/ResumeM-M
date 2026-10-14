import { describe, expect, it } from 'vitest';
import { classifyPage } from '../src/jobs/extract.js';

/*
 * JSON-LD may give "@type" as a list. A short posting page whose only sign is
 * its structured data was read as no posting at all when the list form was
 * used, so JobHelper showed no card for it.
 */
const page = (type: string) => `<!doctype html><html><head><title>Data Analyst</title>
<script type="application/ld+json">{"@context":"https://schema.org","@type":${type},"title":"Data Analyst","hiringOrganization":{"name":"Example Co"}}</script>
</head><body><h1>Data Analyst</h1><p>Example Co.</p></body></html>`;

describe('a JobPosting declared in a list', () => {
  it('is a posting whether "@type" is a string or a list', () => {
    expect(classifyPage(page('"JobPosting"')).kind).toBe('posting');
    expect(classifyPage(page('["JobPosting"]')).kind).toBe('posting');
    expect(classifyPage(page('["Thing", "JobPosting"]')).kind).toBe('posting');
  });

  it('is not a posting when the list names something else', () => {
    expect(classifyPage(page('["Organization"]')).kind).not.toBe('posting');
  });
});
