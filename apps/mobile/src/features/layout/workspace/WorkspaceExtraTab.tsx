import { type NavigationTab } from "./navigation-tab-order";
import { NativeStackScreenOptions } from "../../../native/StackHeader";
import { RequirementsScreen } from "../../requirements/RequirementsScreen";
import { UsageRouteScreen } from "../../usage/UsageRouteScreen";

export function WorkspaceExtraTab(props: {
  tab: Exclude<NavigationTab, "threads" | "pullRequests">;
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
