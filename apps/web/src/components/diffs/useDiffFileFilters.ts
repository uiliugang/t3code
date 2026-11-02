import { isTestChangedFile } from "@t3tools/shared/changedFileKind";
import * as Schema from "effect/Schema";

import { useLocalStorage } from "~/hooks/useLocalStorage";

export function useDiffFileFilters() {
  const [hideTestFiles, setHideTestFiles] = useLocalStorage(
    "t3code.diffHideTestFiles",
    false,
    Schema.Boolean,
  );
  const [hideMarkdownFiles, setHideMarkdownFiles] = useLocalStorage(
    "t3code.diffHideMarkdownFiles",
    false,
    Schema.Boolean,
  );
  return {
    hideTestFiles,
    setHideTestFiles,
    hideMarkdownFiles,
    setHideMarkdownFiles,
    isFileVisible: (path: string, requestedPath?: string | null) =>
      path === requestedPath ||
      ((!hideTestFiles || !isTestChangedFile(path)) &&
        (!hideMarkdownFiles || !path.toLowerCase().endsWith(".md"))),
    clear: () => {
      setHideTestFiles(false);
      setHideMarkdownFiles(false);
    },
  };
}
