import Markdown from "react-markdown";
import remarkBreaks from "remark-breaks";

export const DEFAULT_BRIEF =
  "Create something from nothing. Use this time however you need — " +
  "build, research, draft, prototype. Speak out loud as you go so we can follow how you think.";

// Keep preview and candidate rendering identical. Raw HTML is displayed as text,
// never executed; react-markdown also rejects unsafe link protocols.
export default function BriefContent({ text, className = "" }) {
  return (
    <div className={`brief-content ${className}`}>
      <Markdown
        remarkPlugins={[remarkBreaks]}
        components={{
          a: ({ children, href }) => <a href={href} target="_blank" rel="noopener noreferrer">{children}</a>,
          img: ({ alt }) => <span>{alt}</span>,
        }}
      >
        {text?.trim() || DEFAULT_BRIEF}
      </Markdown>
    </div>
  );
}
