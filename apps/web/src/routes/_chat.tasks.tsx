import { createFileRoute, redirect } from "@tanstack/react-router";

export const Route = createFileRoute("/_chat/tasks")({
  beforeLoad: () => {
    throw redirect({ to: "/requirements", search: { local: true }, replace: true });
  },
});
