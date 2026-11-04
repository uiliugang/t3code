import type { EnvironmentId } from "@t3tools/contracts";
import type { ProjectFolderImportLocation } from "@t3tools/client-runtime/operations/projects";
import { Atom } from "effect/reactivity";
import { appAtomRegistry } from "./rpc/atomRegistry";

export const projectFolderImportAtom = Atom.make<{
  environmentId?: EnvironmentId;
  parentPath?: string;
  projectTitle?: string;
  locations?: ReadonlyArray<ProjectFolderImportLocation>;
} | null>(null);

export type ProjectFolderImportRequest = NonNullable<Atom.Type<typeof projectFolderImportAtom>>;

export function openProjectFolderImport(
  input: NonNullable<Atom.Type<typeof projectFolderImportAtom>> = {},
) {
  appAtomRegistry.set(projectFolderImportAtom, input);
}
