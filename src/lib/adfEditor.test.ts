import { describe, expect, it } from "vitest";
import { adfToEditorDocument, editorDocumentToAdf } from "./adfEditor";

describe("ADF description editing adapter", () => {
  it("round-trips supported nested nodes, marks, links, and ordered list start", () => {
    const source = {
      type: "doc",
      version: 1,
      content: [
        {
          type: "heading",
          attrs: { level: 2 },
          content: [
            { type: "text", text: "Plan", marks: [{ type: "strong" }] },
          ],
        },
        {
          type: "orderedList",
          attrs: { order: 3 },
          content: [
            {
              type: "listItem",
              content: [
                {
                  type: "paragraph",
                  content: [
                    {
                      type: "text",
                      text: "Jira docs",
                      marks: [
                        { type: "em" },
                        {
                          type: "link",
                          attrs: { href: "https://jira.example" },
                        },
                      ],
                    },
                    { type: "hardBreak" },
                    {
                      type: "text",
                      text: "next line",
                      marks: [{ type: "code" }],
                    },
                  ],
                },
              ],
            },
          ],
        },
        { type: "rule" },
      ],
    };

    const editable = adfToEditorDocument(source);
    expect(editable.safe).toBe(true);
    if (!editable.safe) return;
    expect(editorDocumentToAdf(editable.document)).toEqual(source);
  });

  it.each([
    ["mention", { type: "mention", attrs: { id: "account-1" } }],
    ["media", { type: "media", attrs: { id: "file-1", type: "file" } }],
    ["table", { type: "table", content: [] }],
    [
      "unknown mark",
      {
        type: "text",
        text: "keep",
        marks: [{ type: "textColor", attrs: { color: "#fff" } }],
      },
    ],
    [
      "malformed mark attributes",
      { type: "text", text: "keep", marks: [{ type: "strong", attrs: [] }] },
    ],
    [
      "unknown attributes",
      { type: "paragraph", attrs: { localId: "keep-me" }, content: [] },
    ],
    [
      "ordered list attributes",
      {
        type: "orderedList",
        attrs: { order: 2 },
        localId: "keep-me",
        content: [],
      },
    ],
    [
      "code block attributes",
      {
        type: "codeBlock",
        attrs: { language: null },
        localId: "keep-me",
        content: [],
      },
    ],
  ])("refuses unsafe %s content instead of stripping it", (_name, child) => {
    const result = adfToEditorDocument({
      type: "doc",
      version: 1,
      content: [{ type: "paragraph", content: [child] }],
    });
    expect(result.safe).toBe(false);
    if (!result.safe)
      expect(result.reason).toMatch(/cannot preserve|read-only|metadata/);
  });

  it("wraps plain legacy text as a safe editable paragraph", () => {
    const result = adfToEditorDocument("hello");
    expect(result).toEqual({
      safe: true,
      document: {
        type: "doc",
        content: [
          { type: "paragraph", content: [{ type: "text", text: "hello" }] },
        ],
      },
    });
  });
});
