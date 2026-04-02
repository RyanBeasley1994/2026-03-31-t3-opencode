import { useState, type FormEvent } from "react";
import { useAuthStore } from "../../authStore";
import { Button } from "../ui/button";
import { APP_DISPLAY_NAME } from "../../branding";

export function SetupForm() {
  const [username, setUsername] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const { setup, error, clearError } = useAuthStore();
  const [submitting, setSubmitting] = useState(false);

  const passwordMismatch = confirmPassword.length > 0 && password !== confirmPassword;

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (!username.trim() || !displayName.trim() || !password || password !== confirmPassword) return;
    setSubmitting(true);
    await setup(username.trim(), displayName.trim(), password);
    setSubmitting(false);
  };

  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-4">
      <div className="w-full max-w-sm space-y-6">
        <div className="text-center">
          <h1 className="text-2xl font-semibold tracking-tight">{APP_DISPLAY_NAME}</h1>
          <p className="mt-1 text-sm text-muted-foreground">Create admin account to get started</p>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4">
          {error && (
            <div className="rounded-md border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm text-red-400">
              {error}
            </div>
          )}

          <div className="space-y-1.5">
            <label htmlFor="setup-username" className="text-sm font-medium text-foreground">Username</label>
            <input id="setup-username" type="text" autoComplete="username" autoFocus
              value={username} onChange={(e) => { setUsername(e.target.value); clearError(); }}
              className="flex h-9 w-full rounded-md border border-border bg-background px-3 py-1 text-sm text-foreground shadow-sm transition-colors placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
              placeholder="Choose a username" />
          </div>

          <div className="space-y-1.5">
            <label htmlFor="setup-displayName" className="text-sm font-medium text-foreground">Display Name</label>
            <input id="setup-displayName" type="text"
              value={displayName} onChange={(e) => { setDisplayName(e.target.value); clearError(); }}
              className="flex h-9 w-full rounded-md border border-border bg-background px-3 py-1 text-sm text-foreground shadow-sm transition-colors placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
              placeholder="Your name" />
          </div>

          <div className="space-y-1.5">
            <label htmlFor="setup-password" className="text-sm font-medium text-foreground">Password</label>
            <input id="setup-password" type="password" autoComplete="new-password"
              value={password} onChange={(e) => { setPassword(e.target.value); clearError(); }}
              className="flex h-9 w-full rounded-md border border-border bg-background px-3 py-1 text-sm text-foreground shadow-sm transition-colors placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
              placeholder="Choose a password" />
          </div>

          <div className="space-y-1.5">
            <label htmlFor="setup-confirmPassword" className="text-sm font-medium text-foreground">Confirm Password</label>
            <input id="setup-confirmPassword" type="password" autoComplete="new-password"
              value={confirmPassword} onChange={(e) => { setConfirmPassword(e.target.value); clearError(); }}
              className="flex h-9 w-full rounded-md border border-border bg-background px-3 py-1 text-sm text-foreground shadow-sm transition-colors placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
              placeholder="Confirm password" />
            {passwordMismatch && <p className="text-xs text-red-400">Passwords don&apos;t match</p>}
          </div>

          <Button type="submit" className="w-full"
            disabled={submitting || !username.trim() || !displayName.trim() || !password || passwordMismatch}>
            {submitting ? "Creating account..." : "Create admin account"}
          </Button>
        </form>
      </div>
    </div>
  );
}
