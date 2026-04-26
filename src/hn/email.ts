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
</head>
<body style="margin:0; padding:24px; background:#f6f7f9; font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif; color:#1a1a1a; -webkit-text-size-adjust:100%;">
  <div style="max-width:680px; margin:0 auto; background:#ffffff; padding:32px 36px; border-radius:10px; box-shadow:0 1px 3px rgba(0,0,0,0.06); line-height:1.6; font-size:16px;">
    <h1 style="margin:0 0 24px; font-size:22px; line-height:1.3; font-weight:600; letter-spacing:-0.01em;">${escapeHtml(title)}</h1>
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
  return `<hr style="border:none; border-top:1px solid #e5e7eb; margin:32px 0 16px;">
    <p style="font-size:13px; color:#6b7280; margin:0;">
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
