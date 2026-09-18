import { EditorView } from "@codemirror/view";
import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import type { Extension } from "@codemirror/state";
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

/**
 * Light variants — same CSS-var-driven editor chrome; only the syntax palette
 * and the `dark` flag differ.
 */
export const editorThemeLight = EditorView.theme(
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
      backgroundColor: "rgba(9,105,218,0.15)",
      outline: "1px solid rgba(9,105,218,0.4)",
    },
    ".cm-searchMatch-selected": { backgroundColor: "rgba(191,135,0,0.3)" },
    ".cm-panels": { backgroundColor: "var(--bg-panel)", color: "var(--fg)" },
    ".cm-tooltip": { backgroundColor: "var(--bg-elevated)", border: "1px solid var(--border)" },
  },
  { dark: false },
);

export const syntaxThemeLight = syntaxHighlighting(
  HighlightStyle.define([
    { tag: tags.keyword, color: "#cf222e" },
    { tag: [tags.string, tags.special(tags.string), tags.regexp], color: "#0a3069" },
    { tag: [tags.number, tags.bool, tags.null, tags.atom], color: "#0550ae" },
    { tag: [tags.comment, tags.blockComment], color: "#6e7781", fontStyle: "italic" },
    { tag: [tags.function(tags.variableName), tags.function(tags.propertyName)], color: "#8250df" },
    { tag: [tags.typeName, tags.className, tags.tagName], color: "#953800" },
    { tag: tags.propertyName, color: "#0550ae" },
    { tag: [tags.operator, tags.punctuation], color: "#57606a" },
    { tag: [tags.variableName], color: "#1f2328" },
    { tag: tags.definition(tags.variableName), color: "#953800" },
    { tag: tags.heading, color: "#0550ae", fontWeight: "bold" },
    { tag: tags.link, color: "#0969da", textDecoration: "underline" },
    { tag: tags.emphasis, fontStyle: "italic" },
    { tag: tags.strong, fontWeight: "bold" },
    { tag: tags.strikethrough, textDecoration: "line-through" },
  ]),
);

export type CmThemeName = "dark" | "light";

/** The theme extension pair for a given app theme. */
export function cmThemeFor(theme: CmThemeName): [Extension, Extension] {
  return theme === "light" ? [editorThemeLight, syntaxThemeLight] : [editorTheme, syntaxTheme];
}
