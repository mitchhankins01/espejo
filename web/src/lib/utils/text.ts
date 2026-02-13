/**
 * Extract plain text from a Tiptap JSON document.
 */
export function tiptapToPlainText(
  doc: Record<string, unknown> | null | undefined
): string {
  if (!doc) return "";
  return extractText(doc);
}

function extractText(node: Record<string, unknown>): string {
  if (node.type === "text") {
    return (node.text as string) ?? "";
  }

  const content = node.content as Record<string, unknown>[] | undefined;
  if (!content || !Array.isArray(content)) return "";

  const parts = content.map((child) => extractText(child));

  // Add newlines between block-level nodes
  const blockTypes = [
    "paragraph",
    "heading",
    "bulletList",
    "orderedList",
    "blockquote",
    "codeBlock",
    "horizontalRule",
  ];
  if (blockTypes.includes(node.type as string)) {
    return parts.join("") + "\n";
  }

  if (node.type === "listItem") {
    return parts.join("");
  }

  return parts.join("");
}

/**
 * Strip markdown syntax from text for clean previews.
 */
export function stripMarkdown(text: string): string {
  return (
    text
      // Headers
      .replace(/^#{1,6}\s+/gm, "")
      // Bold/italic
      .replace(/\*{1,3}(.*?)\*{1,3}/g, "$1")
      .replace(/_{1,3}(.*?)_{1,3}/g, "$1")
      // Strikethrough
      .replace(/~~(.*?)~~/g, "$1")
      // Links [text](url)
      .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
      // Images ![alt](url)
      .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
      // Inline code
      .replace(/`([^`]+)`/g, "$1")
      // Horizontal rules
      .replace(/^[-*_]{3,}\s*$/gm, "")
      // List markers
      .replace(/^[\s]*[-*+]\s+/gm, "")
      .replace(/^[\s]*\d+\.\s+/gm, "")
      // Blockquotes
      .replace(/^>\s+/gm, "")
      // Collapse multiple newlines
      .replace(/\n{3,}/g, "\n\n")
      .trim()
  );
}

/**
 * Convert markdown text to HTML for rendering.
 */
export function markdownToHtml(text: string): string {
  let html = escapeHtml(text);

  // Code blocks (``` ... ```) — must be before inline processing
  html = html.replace(
    /```(\w*)\n([\s\S]*?)```/g,
    "<pre><code>$2</code></pre>"
  );

  // Headers
  html = html.replace(/^######\s+(.+)$/gm, "<h6>$1</h6>");
  html = html.replace(/^#####\s+(.+)$/gm, "<h5>$1</h5>");
  html = html.replace(/^####\s+(.+)$/gm, "<h4>$1</h4>");
  html = html.replace(/^###\s+(.+)$/gm, "<h3>$1</h3>");
  html = html.replace(/^##\s+(.+)$/gm, "<h2>$1</h2>");
  html = html.replace(/^#\s+(.+)$/gm, "<h1>$1</h1>");

  // Bold + italic
  html = html.replace(/\*\*\*(.+?)\*\*\*/g, "<strong><em>$1</em></strong>");
  html = html.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
  html = html.replace(/\*(.+?)\*/g, "<em>$1</em>");

  // Strikethrough
  html = html.replace(/~~(.+?)~~/g, "<del>$1</del>");

  // Inline code
  html = html.replace(/`([^`]+)`/g, "<code>$1</code>");

  // Horizontal rules
  html = html.replace(/^[-*_]{3,}\s*$/gm, "<hr>");

  // Links
  html = html.replace(
    /\[([^\]]*)\]\(([^)]*)\)/g,
    '<a href="$2" target="_blank" rel="noopener">$1</a>'
  );

  // Paragraphs: split by double newlines
  html = html
    .split(/\n{2,}/)
    .map((block) => {
      const trimmed = block.trim();
      if (!trimmed) return "";
      // Don't wrap already-wrapped block elements
      if (/^<(h[1-6]|pre|hr|ul|ol|blockquote)/.test(trimmed)) {
        return trimmed;
      }
      // Convert single newlines to <br> within paragraphs
      return `<p>${trimmed.replace(/\n/g, "<br>")}</p>`;
    })
    .join("\n");

  return html;
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/**
 * Truncate text to a maximum length, adding ellipsis if needed.
 */
export function truncateText(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;
  return text.slice(0, maxLength).trimEnd() + "...";
}
