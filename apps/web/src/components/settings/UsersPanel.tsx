import { useState, type FormEvent } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { TrashIcon, PlusIcon } from "lucide-react";
import { authApi } from "../../lib/authApi";
import { useAuthStore } from "../../authStore";
import { Button } from "../ui/button";

export function UsersPanel() {
  const currentUser = useAuthStore((s) => s.user);
  const isAdmin = currentUser?.role === "admin";
  const queryClient = useQueryClient();

  const { data: usersData, isLoading } = useQuery({
    queryKey: ["auth", "users"],
    queryFn: () => authApi.listUsers(),
  });
  const users = usersData?.users ?? [];

  const deleteMutation = useMutation({
    mutationFn: (userId: string) => authApi.deleteUser(userId),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["auth", "users"] }),
  });

  const [showForm, setShowForm] = useState(false);
  const [username, setUsername] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [password, setPassword] = useState("");
  const [role, setRole] = useState<"admin" | "member">("member");
  const [formError, setFormError] = useState<string | null>(null);

  const handleCreate = async (e: FormEvent) => {
    e.preventDefault();
    setFormError(null);
    try {
      await authApi.createUser({ username, displayName, password, role });
      queryClient.invalidateQueries({ queryKey: ["auth", "users"] });
      setShowForm(false);
      setUsername("");
      setDisplayName("");
      setPassword("");
      setRole("member");
    } catch (err) {
      setFormError(err instanceof Error ? err.message : "Failed to create user");
    }
  };

  if (isLoading) {
    return <p className="text-sm text-muted-foreground">Loading users...</p>;
  }

  return (
    <div className="space-y-6">
      <div>
        <h3 className="text-lg font-medium">Users</h3>
        <p className="text-sm text-muted-foreground">
          {isAdmin ? "Manage user accounts" : "View team members"}
        </p>
      </div>

      <div className="divide-y divide-border rounded-md border">
        {users.map((user) => (
          <div key={user.id} className="flex items-center justify-between px-4 py-3">
            <div>
              <p className="text-sm font-medium">{user.displayName}</p>
              <p className="text-xs text-muted-foreground">
                @{user.username} &middot; {user.role}
              </p>
            </div>
            {isAdmin && user.id !== currentUser?.id && (
              <Button
                variant="ghost"
                size="sm"
                className="text-red-400 hover:text-red-300"
                onClick={() => {
                  if (confirm(`Delete user ${user.displayName}?`)) {
                    deleteMutation.mutate(user.id);
                  }
                }}
              >
                <TrashIcon className="size-3.5" />
              </Button>
            )}
          </div>
        ))}
      </div>

      {isAdmin && !showForm && (
        <Button variant="outline" size="sm" onClick={() => setShowForm(true)} className="gap-1.5">
          <PlusIcon className="size-3.5" />
          Add User
        </Button>
      )}

      {isAdmin && showForm && (
        <form onSubmit={handleCreate} className="space-y-3 rounded-md border p-4">
          {formError && (
            <div className="rounded-md border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm text-red-400">
              {formError}
            </div>
          )}
          <div className="grid grid-cols-2 gap-3">
            <input
              type="text"
              placeholder="Username"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              className="flex h-9 w-full rounded-md border border-border bg-background px-3 py-1 text-sm"
            />
            <input
              type="text"
              placeholder="Display Name"
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              className="flex h-9 w-full rounded-md border border-border bg-background px-3 py-1 text-sm"
            />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <input
              type="password"
              placeholder="Password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="flex h-9 w-full rounded-md border border-border bg-background px-3 py-1 text-sm"
            />
            <select
              value={role}
              onChange={(e) => setRole(e.target.value as "admin" | "member")}
              className="flex h-9 w-full rounded-md border border-border bg-background px-3 py-1 text-sm"
            >
              <option value="member">Member</option>
              <option value="admin">Admin</option>
            </select>
          </div>
          <div className="flex gap-2">
            <Button type="submit" size="sm" disabled={!username || !displayName || !password}>
              Create
            </Button>
            <Button type="button" variant="ghost" size="sm" onClick={() => setShowForm(false)}>
              Cancel
            </Button>
          </div>
        </form>
      )}
    </div>
  );
}
