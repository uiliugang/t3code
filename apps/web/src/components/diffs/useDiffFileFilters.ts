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
  const isVisibleIgnoringTestFilter = (path: string, requestedPath?: string | null) =>
    path === requestedPath || !hideMarkdownFiles || !path.toLowerCase().endsWith(".md");
  return {
    hideTestFiles,
    setHideTestFiles,
    hideMarkdownFiles,
    setHideMarkdownFiles,
    isVisibleIgnoringTestFilter,
    isFileVisible: (path: string, requestedPath?: string | null) =>
      isVisibleIgnoringTestFilter(path, requestedPath) &&
      (path === requestedPath || !hideTestFiles || !isTestChangedFile(path)),
    clear: () => {
      setHideTestFiles(false);
      setHideMarkdownFiles(false);
    },
  };
}
