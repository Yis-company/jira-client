import { useEditor, EditorContent } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import type { JsonRecord } from "../lib/adfEditor";

export function RichDescriptionEditor({
  initialDocument,
  onChange,
}: {
  initialDocument: JsonRecord;
  onChange: (document: JsonRecord) => void;
}) {
  const editor = useEditor({
    extensions: [StarterKit],
    content: initialDocument,
    immediatelyRender: false,
    onUpdate: ({ editor: updated }) =>
      onChange(updated.getJSON() as JsonRecord),
    editorProps: {
      attributes: {
        "aria-label": "Description editor",
        role: "textbox",
        "aria-multiline": "true",
        class: "issue-rich-editor-content",
      },
    },
  });

  return (
    <div className="issue-rich-editor">
      <div
        className="issue-rich-toolbar"
        role="toolbar"
        aria-label="Description formatting"
      >
        <button
          type="button"
          aria-label="Bold"
          aria-pressed={editor?.isActive("bold") ?? false}
          disabled={!editor}
          onClick={() => editor?.chain().focus().toggleBold().run()}
        >
          <strong>B</strong>
        </button>
        <button
          type="button"
          aria-label="Italic"
          aria-pressed={editor?.isActive("italic") ?? false}
          disabled={!editor}
          onClick={() => editor?.chain().focus().toggleItalic().run()}
        >
          <em>I</em>
        </button>
        <button
          type="button"
          aria-label="Bulleted list"
          aria-pressed={editor?.isActive("bulletList") ?? false}
          disabled={!editor}
          onClick={() => editor?.chain().focus().toggleBulletList().run()}
        >
          • List
        </button>
        <button
          type="button"
          aria-label="Numbered list"
          aria-pressed={editor?.isActive("orderedList") ?? false}
          disabled={!editor}
          onClick={() => editor?.chain().focus().toggleOrderedList().run()}
        >
          1. List
        </button>
      </div>
      <EditorContent editor={editor} />
    </div>
  );
}
