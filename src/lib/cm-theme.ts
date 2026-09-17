import { EditorView } from "@codemirror/view";
import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { tags } from "@lezer/highlight";

/**
 * App dark theme for CodeMirror — mirrors the CSS token palette.
 * Kept as a theme (not CSS overrides) so per-editor theming stays possible.
 */
export const editorTheme = EditorView.theme(
  {
    "&": {
      backgroundColor: "var(--bg)",
      color: "var(--fg)",
      fontSize: "var(--code-font-size)",
      height: "100%",
    },
    ".cm-content": {
      fontFamily: "var(--font-mono)",
      padding: "8px 0",
      caretColor: "var(--accent)",
    },
    ".cm-cursor, .cm-cursor-primary": { borderLeftColor: "var(--accent)" },
    ".cm-gutters": {
      backgroundColor: "var(--bg)",
      color: "var(--fg-faint)",
      border: "none",
      fontFamily: "var(--font-mono)",
    },
    ".cm-activeLine": { backgroundColor: "var(--bg-hover)" },
    ".cm-activeLineGutter": { backgroundColor: "var(--bg-hover)", color: "var(--fg-dim)" },
    "&.cm-focused .cm-selectionBackground, .cm-selectionBackground": {
      backgroundColor: "var(--selection) !important",
    },
    ".cm-selectionMatch": { backgroundColor: "var(--selection)" },
    ".cm-searchMatch": {
      backgroundColor: "rgba(88,230,217,0.18)",
      outline: "1px solid rgba(88,230,217,0.35)",
    },
    ".cm-searchMatch-selected": { backgroundColor: "rgba(255,166,87,0.3)" },
    ".cm-panels": { backgroundColor: "var(--bg-panel)", color: "var(--fg)" },
    ".cm-tooltip": { backgroundColor: "var(--bg-elevated)", border: "1px solid var(--border)" },
  },
  { dark: true },
);

export const syntaxTheme = syntaxHighlighting(
  HighlightStyle.define([
    { tag: tags.keyword, color: "#ff7b72" },
    { tag: [tags.string, tags.special(tags.string), tags.regexp], color: "#a5d6ff" },
    { tag: [tags.number, tags.bool, tags.null, tags.atom], color: "#79c0ff" },
    { tag: [tags.comment, tags.blockComment], color: "#8b949e", fontStyle: "italic" },
    { tag: [tags.function(tags.variableName), tags.function(tags.propertyName)], color: "#d2a8ff" },
    { tag: [tags.typeName, tags.className, tags.tagName], color: "#ffa657" },
    { tag: tags.propertyName, color: "#79c0ff" },
    { tag: [tags.operator, tags.punctuation], color: "#c9d1d9" },
    { tag: [tags.variableName], color: "#e6edf3" },
    { tag: tags.definition(tags.variableName), color: "#ffa657" },
    { tag: tags.heading, color: "#79c0ff", fontWeight: "bold" },
    { tag: tags.link, color: "#a5d6ff", textDecoration: "underline" },
    { tag: tags.emphasis, fontStyle: "italic" },
    { tag: tags.strong, fontWeight: "bold" },
    { tag: tags.strikethrough, textDecoration: "line-through" },
  ]),
);
