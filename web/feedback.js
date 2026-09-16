import { marked } from 'marked';
import DOMPurify from 'dompurify';

/** Render locally: model output may contain Markdown, but never active HTML. */
export function renderFeedbackMarkdown(text) {
  const fragment = DOMPurify.sanitize(marked.parse(String(text), { async: false, gfm: true }), {
    RETURN_DOM_FRAGMENT: true,
    ALLOWED_TAGS: ['p', 'br', 'hr', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'strong', 'em', 'del',
      'ul', 'ol', 'li', 'blockquote', 'pre', 'code', 'a', 'table', 'thead', 'tbody', 'tr', 'th', 'td'],
    ALLOWED_ATTR: ['href', 'title', 'start', 'align'],
    ALLOW_DATA_ATTR: false,
    ALLOW_ARIA_ATTR: false,
  });
  for (const link of fragment.querySelectorAll('a')) {
    if (!/^(https?:|mailto:)/i.test(link.getAttribute('href') ?? '')) link.removeAttribute('href');
    else {
      link.setAttribute('target', '_blank');
      link.setAttribute('rel', 'noopener noreferrer');
    }
  }
  return fragment;
}
