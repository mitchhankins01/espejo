import Markdown from "react-markdown";
import rehypeSanitize from "rehype-sanitize";

interface MarkdownPreviewProps {
  content: string;
  maxLength?: number;
}

export function MarkdownPreview({ content, maxLength }: MarkdownPreviewProps) {
  const text = maxLength && content.length > maxLength
    ? content.slice(0, maxLength) + "..."
    : content;

  return (
    <div className="markdown-preview">
      <Markdown rehypePlugins={[rehypeSanitize]}>{text}</Markdown>
    </div>
  );
}
