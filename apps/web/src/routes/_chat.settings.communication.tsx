import { createFileRoute, redirect } from "@tanstack/react-router";

export const Route = createFileRoute("/_chat/settings/communication")({
  beforeLoad: ({ search }) => {
    throw redirect({ to: "/settings/access", search });
  },
});
