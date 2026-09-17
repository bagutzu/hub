import { createFileRoute } from "@tanstack/react-router";
import { handleProviderRequest } from "../../../../server/runtime.js";

export const Route = createFileRoute("/api/integrations/gitlab/events")({
  server: {
    handlers: { POST: ({ request }) => handleProviderRequest("gitlab.events", request) },
  },
});
