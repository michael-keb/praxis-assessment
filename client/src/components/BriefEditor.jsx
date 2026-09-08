import { useState } from "react";
import { EditorContent, useEditor, useEditorState } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import { Markdown } from "@tiptap/markdown";
import BriefContent from "./BriefContent.jsx";

export default function BriefEditor({ value, onChange }) {
  const [preview, setPreview] = useState(false);
  const editor = useEditor({
    extensions: [
      StarterKit.configure({
        // Only offer formats that can be saved as standard Markdown.
        underline: false,
        strike: false,
        link: { openOnClick: false, autolink: false },
      }),
      Markdown.configure({ markedOptions: { breaks: true } }),
    ],
    content: value,
    contentType: "markdown",
    editorProps: {
      attributes: {
        id: "a-brief",
        class: "brief-content brief-editor-input",
        role: "textbox",
        "aria-multiline": "true",
        "aria-labelledby": "a-brief-label",
        "aria-describedby": "a-brief-help",
      },
      handlePaste: (_view, event) => {
        const text = event.clipboardData?.getData("text/plain");
        // Let the editor's schema preserve supported formatting from Word,
        // Google Docs and web pages. Plain clipboard text may be Markdown.
        if (!text || event.clipboardData?.getData("text/html") || editor.isActive("codeBlock")) return false;
        event.preventDefault();
        return editor.commands.insertContent(text, { contentType: "markdown" });
      },
    },
    onUpdate: ({ editor }) => onChange(editor.isEmpty ? "" : editor.getMarkdown()),
  });

  const state = useEditorState({
    editor,
    selector: ({ editor }) => editor ? {
      heading: editor.isActive("heading") ? String(editor.getAttributes("heading").level) : "paragraph",
      bold: editor.isActive("bold"),
      italic: editor.isActive("italic"),
      bulletList: editor.isActive("bulletList"),
      orderedList: editor.isActive("orderedList"),
      undo: editor.can().undo(),
      redo: editor.can().redo(),
    } : null,
  });

  function formatButton(label, active, command, disabled = false) {
    return (
      <button
        type="button"
        aria-pressed={active}
        disabled={!editor || disabled}
        onMouseDown={(event) => event.preventDefault()}
        onClick={() => command(editor.chain().focus()).run()}
      >
        {label}
      </button>
    );
  }

  return (
    <>
      <div className="brief-editor">
        <div className="brief-editor-toolbar" role="group" aria-label="Brief formatting">
          {!preview && <>
            <select
              aria-label="Text style"
              value={state?.heading || "paragraph"}
              disabled={!editor}
              onChange={(event) => {
                const chain = editor.chain().focus();
                if (event.target.value === "paragraph") chain.setParagraph().run();
                else chain.setHeading({ level: Number(event.target.value) }).run();
              }}
            >
              <option value="paragraph">Paragraph</option>
              {[1, 2, 3, 4, 5, 6].map((level) => <option key={level} value={level}>Heading {level}</option>)}
            </select>
            {formatButton("Bold", state?.bold, (chain) => chain.toggleBold())}
            {formatButton("Italic", state?.italic, (chain) => chain.toggleItalic())}
            {formatButton("Bullets", state?.bulletList, (chain) => chain.toggleBulletList())}
            {formatButton("Numbered list", state?.orderedList, (chain) => chain.toggleOrderedList())}
            {formatButton("Undo", undefined, (chain) => chain.undo(), !state?.undo)}
            {formatButton("Redo", undefined, (chain) => chain.redo(), !state?.redo)}
          </>}
          <button type="button" className="brief-preview-toggle" aria-pressed={preview} onClick={() => setPreview(!preview)}>
            {preview ? "Back to editing" : "Preview"}
          </button>
        </div>
        <div hidden={preview}><EditorContent editor={editor} /></div>
        {preview && <BriefContent className="brief-editor-preview" text={value} />}
      </div>
      <p id="a-brief-help" className="brief-editor-help">
        Paste formatted text or Markdown. Headings, bold, italics, bullets and numbering are preserved.
        Use Preview to see the candidate’s brief.
      </p>
    </>
  );
}
