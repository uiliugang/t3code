import { type NavigationTab } from "./navigation-tab-order";
import { NativeStackScreenOptions } from "../../../native/StackHeader";
import { RequirementsScreen } from "../../requirements/RequirementsScreen";
import { UsageRouteScreen } from "../../usage/UsageRouteScreen";

export function WorkspaceExtraTab(props: {
  tab: Extract<NavigationTab, "usage" | "requirements">;
}) {
  return (
    <>
      <NativeStackScreenOptions options={{ headerSearchBarOptions: undefined }} />
      {props.tab === "requirements" ? (
        <RequirementsScreen workspace />
      ) : (
        <UsageRouteScreen workspace />
      )}
    </>
  );
}
