import { createFileRoute } from "@tanstack/react-router";
import { MeituanSettings, type MeituanSection } from "../components/settings/MeituanSettings";

export const Route = createFileRoute("/_chat/settings/meituan")({
  validateSearch: (search: Record<string, unknown>): { section?: MeituanSection | undefined } => ({
    section:
      search.section === "code" ||
      search.section === "issues" ||
      search.section === "daxiang" ||
      search.section === "skills"
        ? search.section
        : undefined,
  }),
  component: MeituanPage,
});

function MeituanPage() {
  const { section } = Route.useSearch();
  const navigate = Route.useNavigate();
  return (
    <MeituanSettings
      section={section}
      onSectionChange={(next) =>
        void navigate({ search: (previous) => ({ ...previous, section: next }) })
      }
    />
  );
}
