// The model's replies as light Markdown. Raw HTML is off in the parser and the result is
// sanitized anyway: a reply can quote graph content, and this page holds an API key, so
// nothing a reply contains may become markup the parser did not write.

import DOMPurify from 'dompurify';
import MarkdownIt from 'markdown-it';

const md = new MarkdownIt({ html: false, linkify: true, typographer: false });
// No images: the browser loads one without a click, so a reply steered by graph text could
// carry a table off in its URL. `![x](url)` renders as a link instead.
md.disable('image');

// Links leave the page in a new tab; the chat and its tables stay where they are.
const renderLink = md.renderer.rules.link_open ?? ((tokens, i, options, env, self) => self.renderToken(tokens, i, options));
md.renderer.rules.link_open = (tokens, i, options, env, self) => {
  tokens[i].attrSet('target', '_blank');
  tokens[i].attrSet('rel', 'noopener noreferrer');
  return renderLink(tokens, i, options, env, self);
};

export function renderMarkdown(text) {
  return DOMPurify.sanitize(md.render(text), { ADD_ATTR: [ 'target' ] });
}

/**
 * Turns the ids a reply cites — tables "(t4)", or guided handles "s1", "e2" — into links that
 * open their table, but only ids `resolve` maps to a table, and never inside code or a link.
 */
export function linkTables(root, resolve, open) {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode: node => (node.parentElement?.closest('a, code, pre') ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT),
  });
  const nodes = [];
  while (walker.nextNode()) {
    nodes.push(walker.currentNode);
  }
  for (const node of nodes) {
    const parts = node.textContent.split(/\b([tesc]\d+)\b/u);
    if (parts.length === 1 || !parts.some((p, i) => i % 2 === 1 && resolve(p))) {
      continue;
    }
    const fragment = document.createDocumentFragment();
    parts.forEach((part, i) => {
      if (i % 2 === 1 && resolve(part)) {
        const a = document.createElement('a');
        a.href = '#';
        a.className = 'tref';
        a.textContent = part;
        a.addEventListener('click', event => {
          event.preventDefault();
          open(resolve(part));
        });
        fragment.append(a);
      } else if (part) {
        fragment.append(part);
      }
    });
    node.replaceWith(fragment);
  }
}
