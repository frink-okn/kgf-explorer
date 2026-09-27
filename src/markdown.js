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
 * Turns table ids the reply cites — "(t4)", "t12" — into links that open that table, but only
 * ids of tables that exist, and never inside code or an existing link.
 */
export function linkTables(root, isTable, open) {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode: node => (node.parentElement?.closest('a, code, pre') ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT),
  });
  const nodes = [];
  while (walker.nextNode()) {
    nodes.push(walker.currentNode);
  }
  for (const node of nodes) {
    const parts = node.textContent.split(/\b(t\d+)\b/u);
    if (parts.length === 1 || !parts.some((p, i) => i % 2 === 1 && isTable(p))) {
      continue;
    }
    const fragment = document.createDocumentFragment();
    parts.forEach((part, i) => {
      if (i % 2 === 1 && isTable(part)) {
        const a = document.createElement('a');
        a.href = '#';
        a.className = 'tref';
        a.textContent = part;
        a.addEventListener('click', event => {
          event.preventDefault();
          open(part);
        });
        fragment.append(a);
      } else if (part) {
        fragment.append(part);
      }
    });
    node.replaceWith(fragment);
  }
}
