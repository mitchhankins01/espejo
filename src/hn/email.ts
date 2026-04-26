import { marked } from "marked";
import { formatCost, type CostBreakdown, type TokenUsage } from "./pricing.js";

export interface ComposeEmailInput {
  title: string;
  markdown: string;
  hnUrl: string;
  articleUrl: string | null;
  model: string;
  usage: TokenUsage;
  cost: CostBreakdown;
}

export interface ComposedEmail {
  subject: string;
  text: string;
  html: string;
}

const HTML_SHELL = (title: string, body: string): string => `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<meta name="supported-color-schemes" content="light dark">
<title>${escapeHtml(title)}</title>
<style>
  :root { color-scheme: light dark; supported-color-schemes: light dark; }
  body { -webkit-text-size-adjust:100%; background:#ffffff; color:#1a1a1a; }
  h1 { font-size:19px; font-weight:600; line-height:1.3; margin:0 0 16px; letter-spacing:-0.01em; }
  h2 { font-size:16px; font-weight:600; line-height:1.3; margin:22px 0 8px; }
  h3 { font-size:15px; font-weight:600; line-height:1.3; margin:18px 0 6px; }
  p { margin:0 0 12px; }
  ul, ol { margin:0 0 12px; padding-left:22px; }
  li { margin:0 0 4px; }
  hr { border:none; border-top:1px solid #d1d5db; margin:22px 0; }
  a { color:#2563eb; }
  blockquote { margin:0 0 12px; padding-left:12px; border-left:3px solid #d1d5db; color:#4b5563; }
  code { font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace; font-size:13.5px; background:#f3f4f6; padding:1px 4px; border-radius:3px; }
  .footer { font-size:12.5px; color:#6b7280; margin:0; }
  .footer a { color:#6b7280; text-decoration:underline; }
  @media (prefers-color-scheme: dark) {
    body { background:#1c1c1e !important; color:#e5e7eb !important; }
    h1, h2, h3 { color:#f3f4f6 !important; }
    hr { border-top-color:#3f3f46 !important; }
    a { color:#7aa7ff !important; }
    blockquote { border-left-color:#3f3f46 !important; color:#9ca3af !important; }
    code { background:#27272a !important; color:#e5e7eb !important; }
    .footer { color:#9ca3af !important; }
    .footer a { color:#9ca3af !important; }
  }
</style>
</head>
<body style="margin:0; padding:0; font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif; line-height:1.55; font-size:16px;">
  <div style="max-width:640px; margin:0 auto; padding:14px 16px;">
    <h1>${escapeHtml(title)}</h1>
    ${body}
  </div>
</body>
</html>`;

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function buildFooterHtml(input: ComposeEmailInput): string {
  const links: string[] = [];
  links.push(`<a href="${escapeHtml(input.hnUrl)}">HN thread</a>`);
  if (input.articleUrl) {
    links.push(
      `<a href="${escapeHtml(input.articleUrl)}">Original article</a>`
    );
  }
  const costLine =
    `${formatCost(input.cost.totalCostUsd)} ` +
    `(${input.usage.inputTokens.toLocaleString()} in / ${input.usage.outputTokens.toLocaleString()} out · ${escapeHtml(input.model)})`;
  return `<hr>
    <p class="footer">
      ${links.join(" · ")}<br>
      <em>${escapeHtml(costLine)}</em>
    </p>`;
}

function buildFooterText(input: ComposeEmailInput): string {
  const lines: string[] = ["", "---"];
  lines.push(`HN thread: ${input.hnUrl}`);
  if (input.articleUrl) lines.push(`Original article: ${input.articleUrl}`);
  lines.push(
    `Cost: ${formatCost(input.cost.totalCostUsd)} ` +
      `(${input.usage.inputTokens} in / ${input.usage.outputTokens} out tokens · ${input.model})`
  );
  return lines.join("\n");
}

export function composeEmail(input: ComposeEmailInput): ComposedEmail {
  const subject = `HN Distill: ${input.title}`;

  const renderedBody = marked.parse(input.markdown, {
    async: false,
    gfm: true,
  }) as string;
  const html = HTML_SHELL(
    input.title,
    `${renderedBody}\n${buildFooterHtml(input)}`
  );

  const text = `${input.markdown}\n${buildFooterText(input)}`;

  return { subject, text, html };
}
