import { createFileRoute, redirect } from "@tanstack/react-router";

import { issuesSearchFromUrl } from "../components/issue/issuesSearch.logic";
import { requirementsSearchFromIssuesSearch } from "../components/requirements/requirementPanelSearch";

export const Route = createFileRoute("/_chat/issues")({
  validateSearch: issuesSearchFromUrl,
  beforeLoad: ({ search }) => {
    throw redirect({
      to: "/requirements",
      search: requirementsSearchFromIssuesSearch(search),
      replace: true,
    });
  },
});
