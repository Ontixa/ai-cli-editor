import { LanguageDescription } from "@codemirror/language";
import { languages } from "@codemirror/language-data";

/** Extension → CodeMirror language, via language-data's own tables. */
export function languageFor(path: string): LanguageDescription | undefined {
  const name = path.split("/").pop() ?? path;
  return LanguageDescription.matchFilename(languages, name) ?? undefined;
}

/** True for paths that look like source/text worth following in Follow Agent. */
export function isSourcePath(path: string): boolean {
  return (
    languageFor(path) !== undefined ||
    /\.(toml|yaml|yml|json|lock|ini|cfg|env|txt|sh|bash|zsh|ps1|bat|cmd|sql|graphql|proto|tf|hcl|rs|go|py|ts|tsx|js|jsx|css|scss|html|vue|svelte|java|kt|c|h|cpp|hpp|cs|rb|php|swift|lua|zig|md|markdown)$/i.test(
      path,
    )
  );
}
