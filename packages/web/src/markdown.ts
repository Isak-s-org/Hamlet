// Markdown for Claude's replies and reports. Transcript text is untrusted: raw HTML stays text,
// links are checked by markdown-it and open in a new tab, and images become links so a transcript
// can never make the page fetch anything.
import MarkdownIt from "markdown-it";

const md = new MarkdownIt({ html: false, linkify: true, breaks: true });
const rules = md.renderer.rules;
const esc = md.utils.escapeHtml;

rules.link_open = (tokens, i, options, _env, self) => {
  tokens[i]!.attrSet("target", "_blank");
  tokens[i]!.attrSet("rel", "noopener noreferrer");
  return self.renderToken(tokens, i, options);
};
rules.image = (tokens, i) => {
  const t = tokens[i]!;
  const src = t.attrGet("src") ?? "";
  const alt = t.content || src;
  return md.validateLink(src) ? `<a href="${esc(src)}" target="_blank" rel="noopener noreferrer">${esc(alt)}</a>` : esc(alt);
};
rules.fence = (tokens, i) => {
  const t = tokens[i]!;
  const lang = t.info.trim().split(/\s+/)[0] ?? "";
  return `<pre class="code"${lang ? ` data-lang="${esc(lang)}"` : ""}>${esc(t.content.replace(/\n$/, ""))}</pre>`;
};
// Wide tables scroll inside their own box instead of widening the chat.
rules.table_open = () => `<div class="table"><table>`;
rules.table_close = () => `</table></div>`;

export const mdHtml = (text: string): string => md.render(text);
