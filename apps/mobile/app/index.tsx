import { useEffect } from "react";
import { Redirect } from "expo-router";
import { useConnectionStore } from "../src/lib/connectionStore";
import { useAppStore } from "../src/lib/appStore";

/**
 * Entry point: if we have a saved server URL, auto-connect and go to sessions.
 * Otherwise, show the connect screen.
 */
export default function Index() {
  const { serverUrl, loaded } = useConnectionStore();
  const { transportState, connect } = useAppStore();

  useEffect(() => {
    if (loaded && serverUrl.length > 0 && transportState === "closed") {
      connect(serverUrl);
    }
  }, [loaded, serverUrl, transportState, connect]);

  if (!loaded) return null;

  if (serverUrl.length === 0) {
    return <Redirect href="/connect" />;
  }

  return <Redirect href="/sessions" />;
}
