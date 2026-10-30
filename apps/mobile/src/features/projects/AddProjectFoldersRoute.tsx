import type { StaticScreenProps } from "@react-navigation/native";
import { AddProjectFoldersScreen } from "./AddProjectScreen";

export function AddProjectFoldersRoute({
  route,
}: StaticScreenProps<{ environmentId?: string; parentPath?: string } | undefined>) {
  return <AddProjectFoldersScreen {...(route.params ?? {})} />;
}
