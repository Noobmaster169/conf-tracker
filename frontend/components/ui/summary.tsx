import ReactMarkdown from "react-markdown";

import { separateAttributions } from "@/lib/summary-markdown";

/**
 * A finished session as the article written about it. Only the handful of elements an article uses are styled: the
 * headline, the subhead under it, section headings, paragraphs, lists and pull-quotes, whose last line is the
 * attribution.
 */
export function Summary({ content }: { content: string }) {
  return (
    <div className="max-w-[72ch]">
      <ReactMarkdown
        components={{
          h1: ({ children }) => <h2 className="text-[26px] font-bold leading-tight tracking-tight">{children}</h2>,
          h2: ({ children }) => <h3 className="mt-9 text-xl font-semibold leading-snug">{children}</h3>,
          h3: ({ children }) => <h4 className="mt-6 font-semibold">{children}</h4>,
          // The paragraph straight under the headline is the subhead.
          p: ({ children }) => <p className="mt-4 text-[16px] leading-relaxed [h2+&]:mt-3 [h2+&]:text-[18px] [h2+&]:leading-snug [h2+&]:text-ink-soft">{children}</p>,
          ul: ({ children }) => <ul className="mt-4 list-disc space-y-1.5 pl-5 text-[16px] leading-relaxed marker:text-ink-faint">{children}</ul>,
          ol: ({ children }) => <ol className="mt-4 list-decimal space-y-1.5 pl-5 text-[16px] leading-relaxed">{children}</ol>,
          blockquote: ({ children }) => (
            <blockquote className="my-6 border-l-[3px] border-accent pl-4 [&>p]:mt-1 [&>p]:text-[19px] [&>p]:font-medium [&>p]:leading-snug [&>p:first-child]:mt-0 [&>p:last-child:not(:first-child)]:text-[13px] [&>p:last-child:not(:first-child)]:font-normal [&>p:last-child:not(:first-child)]:text-ink-soft">
              {children}
            </blockquote>
          ),
          a: ({ href, children }) => (
            <a href={href} className="text-accent underline">
              {children}
            </a>
          ),
          hr: () => <hr className="mt-8 border-line" />,
        }}
      >
        {separateAttributions(content)}
      </ReactMarkdown>
    </div>
  );
}
