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
          h1: ({ children }) => <h2 className="text-[21px] font-bold leading-tight sm:text-[24px] tracking-tight">{children}</h2>,
          h2: ({ children }) => <h3 className="mt-7 text-[17px] font-semibold leading-snug sm:mt-8 sm:text-[19px]">{children}</h3>,
          h3: ({ children }) => <h4 className="mt-5 text-[15px] font-semibold sm:text-[16px]">{children}</h4>,
          // The paragraph straight under the headline is the subhead.
          p: ({ children }) => <p className="mt-3.5 text-[15px] leading-relaxed sm:text-[16px] [h2+&]:mt-2.5 [h2+&]:text-[16px] sm:[h2+&]:text-[17px] [h2+&]:leading-snug [h2+&]:text-ink-soft">{children}</p>,
          ul: ({ children }) => <ul className="mt-3.5 list-disc space-y-1.5 pl-5 text-[15px] leading-relaxed sm:text-[16px] marker:text-ink-faint">{children}</ul>,
          ol: ({ children }) => <ol className="mt-3.5 list-decimal space-y-1.5 pl-5 text-[15px] leading-relaxed sm:text-[16px]">{children}</ol>,
          blockquote: ({ children }) => (
            <blockquote className="my-5 border-l-[3px] border-accent pl-3.5 sm:my-6 sm:pl-4 [&>p]:mt-1 [&>p]:text-[16px] sm:[&>p]:text-[18px] [&>p]:font-medium [&>p]:leading-snug [&>p:first-child]:mt-0 [&>p:last-child:not(:first-child)]:text-[13px] [&>p:last-child:not(:first-child)]:font-normal [&>p:last-child:not(:first-child)]:text-ink-soft">
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
