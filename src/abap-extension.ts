import type { IExtensionManifest } from "@codingame/monaco-vscode-api/extensions";
import {
  ExtensionHostKind,
  registerExtension,
} from "@codingame/monaco-vscode-api/extensions";
import manifest from "abap-language-basics/package.json";
import languageConfigurationUrl from "abap-language-basics/language-configuration.json?url";
import snippetsUrl from "abap-language-basics/snippets/abap.json?url";
import grammarUrl from "abap-language-basics/syntaxes/abap.tmLanguage.json?url";

export async function registerAbapLanguageBasics(): Promise<void> {
  const extension = registerExtension(
    manifest as unknown as IExtensionManifest,
    ExtensionHostKind.LocalProcess,
  );
  extension.registerFileUrl("/language-configuration.json", languageConfigurationUrl);
  extension.registerFileUrl("/snippets/abap.json", snippetsUrl);
  extension.registerFileUrl("/syntaxes/abap.tmLanguage.json", grammarUrl);
  await extension.whenReady();
}
