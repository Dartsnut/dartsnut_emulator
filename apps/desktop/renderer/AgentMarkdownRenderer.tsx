import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

export default function AgentMarkdownRenderer({ source }: { source: string }) {
  return (
    <div className="agent-markdown">
      <ReactMarkdown remarkPlugins={[remarkGfm]}>{source}</ReactMarkdown>
    </div>
  );
}
