"use client";

import Placeholder from "@tiptap/extension-placeholder";
import TaskItem from "@tiptap/extension-task-item";
import TaskList from "@tiptap/extension-task-list";
import { Markdown } from "@tiptap/markdown";
import { EditorContent, useEditor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import { useEffect, useState } from "react";

type MarkdownEditorProps = {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  ariaLabel?: string;
};

export default function MarkdownEditor({
  value,
  onChange,
  placeholder = "Start writing…",
  ariaLabel = "Document body",
}: MarkdownEditorProps) {
  const [rawMode, setRawMode] = useState(false);
  const editor = useEditor({
    immediatelyRender: false,
    extensions: [
      StarterKit,
      TaskList,
      TaskItem.configure({ nested: true }),
      Markdown,
      Placeholder.configure({ placeholder }),
    ],
    content: value,
    contentType: "markdown",
    editorProps: {
      attributes: {
        "aria-label": ariaLabel,
        class: "document-prose",
      },
    },
    onUpdate: ({ editor: currentEditor }) => onChange(currentEditor.getMarkdown()),
  });

  useEffect(() => {
    if (!editor || rawMode) return;
    const current = editor.getMarkdown();
    if (!editor.isFocused && current !== value) editor.commands.setContent(value, { contentType: "markdown", emitUpdate: false });
  }, [editor, rawMode, value]);

  const formatButton = (label: string, active: boolean, action: () => void, shortcut?: string) => (
    <button
      className={active ? "active" : ""}
      type="button"
      onClick={action}
      aria-pressed={active}
      title={shortcut ? `${label} (${shortcut})` : label}
    >
      {label}
    </button>
  );

  return (
    <section className="markdown-editor" data-testid="markdown-editor">
      <div className="editor-toolbar" role="toolbar" aria-label="Document formatting">
        <div>
          {formatButton("Text", Boolean(editor?.isActive("paragraph")), () => editor?.chain().focus().setParagraph().run())}
          {formatButton("H1", Boolean(editor?.isActive("heading", { level: 1 })), () => editor?.chain().focus().toggleHeading({ level: 1 }).run(), "Ctrl+Alt+1")}
          {formatButton("H2", Boolean(editor?.isActive("heading", { level: 2 })), () => editor?.chain().focus().toggleHeading({ level: 2 }).run(), "Ctrl+Alt+2")}
          {formatButton("H3", Boolean(editor?.isActive("heading", { level: 3 })), () => editor?.chain().focus().toggleHeading({ level: 3 }).run(), "Ctrl+Alt+3")}
          {formatButton("Bold", Boolean(editor?.isActive("bold")), () => editor?.chain().focus().toggleBold().run(), "Ctrl+B")}
          {formatButton("Italic", Boolean(editor?.isActive("italic")), () => editor?.chain().focus().toggleItalic().run(), "Ctrl+I")}
          {formatButton("Bullets", Boolean(editor?.isActive("bulletList")), () => editor?.chain().focus().toggleBulletList().run())}
          {formatButton("Numbered", Boolean(editor?.isActive("orderedList")), () => editor?.chain().focus().toggleOrderedList().run())}
          {formatButton("Checklist", Boolean(editor?.isActive("taskList")), () => editor?.chain().focus().toggleTaskList().run())}
          {formatButton("Quote", Boolean(editor?.isActive("blockquote")), () => editor?.chain().focus().toggleBlockquote().run())}
          {formatButton("Undo", false, () => editor?.chain().focus().undo().run(), "Ctrl+Z")}
          {formatButton("Redo", false, () => editor?.chain().focus().redo().run(), "Ctrl+Shift+Z")}
        </div>
        <button className="raw-mode-toggle" type="button" onClick={() => setRawMode((current) => !current)} aria-pressed={rawMode}>
          {rawMode ? "Rich text" : "Markdown"}
        </button>
      </div>

      {rawMode ? (
        <textarea
          className="raw-markdown-input"
          value={value}
          onChange={(event) => onChange(event.target.value)}
          placeholder={placeholder}
          aria-label={`${ariaLabel} in raw Markdown`}
          spellCheck
        />
      ) : (
        <EditorContent editor={editor} />
      )}
    </section>
  );
}
