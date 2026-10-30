import type { EnvironmentId } from "@t3tools/contracts";
import { Atom } from "effect/reactivity";
import { appAtomRegistry } from "./rpc/atomRegistry";

export const projectFolderImportAtom = Atom.make<{
  environmentId?: EnvironmentId;
  parentPath?: string;
} | null>(null);

export function openProjectFolderImport(
  input: NonNullable<Atom.Type<typeof projectFolderImportAtom>> = {},
) {
  appAtomRegistry.set(projectFolderImportAtom, input);
}
