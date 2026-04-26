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
<title>${escapeHtml(title)}</title>
<style>
  body { -webkit-text-size-adjust:100%; }
  h1 { font-size:19px; font-weight:600; line-height:1.3; margin:0 0 16px; letter-spacing:-0.01em; }
  h2 { font-size:16px; font-weight:600; line-height:1.3; margin:22px 0 8px; }
  h3 { font-size:15px; font-weight:600; line-height:1.3; margin:18px 0 6px; }
  p { margin:0 0 12px; }
  ul, ol { margin:0 0 12px; padding-left:22px; }
  li { margin:0 0 4px; }
  hr { border:none; border-top:1px solid #d1d5db; margin:22px 0; }
  a { color:#2563eb; }
  blockquote { margin:0 0 12px; padding-left:12px; border-left:3px solid #d1d5db; color:#4b5563; }
  code { font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace; font-size:13.5px; }
</style>
</head>
<body style="margin:0; padding:0; font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif; color:#1a1a1a; line-height:1.55; font-size:16px;">
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
  const linkStyle = "color:#6b7280; text-decoration:underline;";
  const links: string[] = [];
  links.push(
    `<a href="${escapeHtml(input.hnUrl)}" style="${linkStyle}">HN thread</a>`
  );
  if (input.articleUrl) {
    links.push(
      `<a href="${escapeHtml(input.articleUrl)}" style="${linkStyle}">Original article</a>`
    );
  }
  const costLine =
    `${formatCost(input.cost.totalCostUsd)} ` +
    `(${input.usage.inputTokens.toLocaleString()} in / ${input.usage.outputTokens.toLocaleString()} out · ${escapeHtml(input.model)})`;
  return `<hr>
    <p style="font-size:12.5px; color:#6b7280; margin:0;">
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
