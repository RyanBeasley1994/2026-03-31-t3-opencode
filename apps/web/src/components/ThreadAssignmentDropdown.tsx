import { useQuery } from "@tanstack/react-query";
import { UserIcon } from "lucide-react";
import { authApi } from "../lib/authApi";
import { Menu, MenuPopup, MenuRadioGroup, MenuRadioItem, MenuTrigger } from "./ui/menu";
import { Button } from "./ui/button";

interface ThreadAssignmentDropdownProps {
  assignedUserId: string | null;
  onAssign: (userId: string | null) => void;
}

export function ThreadAssignmentDropdown({
  assignedUserId,
  onAssign,
}: ThreadAssignmentDropdownProps) {
  const { data: usersData } = useQuery({
    queryKey: ["auth", "users"],
    queryFn: () => authApi.listUsers(),
    staleTime: 60_000,
  });
  const users = usersData?.users ?? [];
  const assignedUser = users.find((u) => u.id === assignedUserId);

  return (
    <Menu>
      <MenuTrigger>
        <Button variant="ghost" size="sm" className="gap-1.5 text-xs text-muted-foreground">
          <UserIcon className="size-3" />
          {assignedUser?.displayName ?? "Unassigned"}
        </Button>
      </MenuTrigger>
      <MenuPopup>
        <MenuRadioGroup
          value={assignedUserId ?? "unassigned"}
          onValueChange={(v) => onAssign(v === "unassigned" ? null : v)}
        >
          <MenuRadioItem value="unassigned">Unassigned</MenuRadioItem>
          {users.map((user) => (
            <MenuRadioItem key={user.id} value={user.id}>
              {user.displayName}
            </MenuRadioItem>
          ))}
        </MenuRadioGroup>
      </MenuPopup>
    </Menu>
  );
}
