import { createFileRoute } from "@tanstack/react-router";
import { WorkItemsPage } from "../components/work-items/WorkItemsPage";

export const Route = createFileRoute("/_chat/tasks")({ component: WorkItemsPage });
