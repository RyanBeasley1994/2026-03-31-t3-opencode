import { createFileRoute } from "@tanstack/react-router";
import { UsersPanel } from "../components/settings/UsersPanel";

export const Route = createFileRoute("/settings/users")({
  component: UsersPanel,
});
