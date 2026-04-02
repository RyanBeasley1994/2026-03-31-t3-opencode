import { useEffect, type ReactNode } from "react";
import { useAuthStore } from "../../authStore";
import { LoginForm } from "./LoginForm";
import { SetupForm } from "./SetupForm";
import { APP_DISPLAY_NAME } from "../../branding";

export function AuthGuard({ children }: { children: ReactNode }) {
  const { phase, checkAuth } = useAuthStore();

  useEffect(() => {
    checkAuth();
  }, [checkAuth]);

  if (phase === "loading") {
    return (
      <div className="flex h-screen items-center justify-center bg-background text-foreground">
        <p className="text-sm text-muted-foreground">Loading {APP_DISPLAY_NAME}...</p>
      </div>
    );
  }

  if (phase === "setup-required") {
    return <SetupForm />;
  }

  if (phase === "login") {
    return <LoginForm />;
  }

  return <>{children}</>;
}
