import { useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import type { ProjectAvailability, VirtualProject } from "@/project-sidebar/contract.js";
import { projectKey } from "@/project-sidebar/view.js";
import { useProjectSidebarPreferences } from "@/project-sidebar/useProjectSidebarPreferences.js";

interface FixtureTree {
  projects: VirtualProject[];
  availability?: Array<[string, ProjectAvailability]>;
}

declare global {
  interface Window {
    projectOrderFixture: {
      publish(tree: FixtureTree): void;
    };
  }
}

function ProjectOrderFixture() {
  const [tree, setTree] = useState<FixtureTree>(() =>
    JSON.parse(sessionStorage.getItem("project-order-fixture-tree") ?? '{"projects":[]}'),
  );
  const availability = useMemo(() => new Map(tree.availability), [tree.availability]);
  const preferences = useProjectSidebarPreferences(tree.projects, false, availability);
  const ordered = preferences.sort(tree.projects);
  useEffect(() => {
    window.projectOrderFixture = {
      publish(next) {
        sessionStorage.setItem("project-order-fixture-tree", JSON.stringify(next));
        setTree(next);
      },
    };
  }, []);
  return (
    <main>
      <ol>
        {ordered.map((project) => (
          <li key={projectKey(project)} data-project-key={projectKey(project)}>
            {project.name}
            <button
              onClick={() =>
                preferences.reorder(ordered, projectKey(project), projectKey(ordered[0]!))
              }
            >
              Move to first
            </button>
          </li>
        ))}
      </ol>
    </main>
  );
}

createRoot(document.getElementById("root")!).render(<ProjectOrderFixture />);
