import { useEffect } from "react";
import { Stack } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { useConnectionStore } from "../src/lib/connectionStore";
import { colors } from "../src/lib/theme";

export default function RootLayout() {
  const loadConnection = useConnectionStore((s) => s.load);

  useEffect(() => {
    loadConnection();
  }, [loadConnection]);

  return (
    <>
      {/* eslint-disable-next-line react/style-prop-object -- expo-status-bar style prop is a string */}
      <StatusBar style="light" />
      <Stack
        screenOptions={{
          headerStyle: { backgroundColor: colors.bg },
          headerTintColor: colors.text,
          headerTitleStyle: { fontWeight: "600" },
          contentStyle: { backgroundColor: colors.bg },
          animation: "slide_from_right",
        }}
      />
    </>
  );
}
