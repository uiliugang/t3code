import { createFileRoute } from "@tanstack/react-router";
import { RequirementsSettings } from "../components/settings/RequirementsSettings";
export const Route = createFileRoute("/_chat/settings/requirements")({
  component: RequirementsSettings,
});
