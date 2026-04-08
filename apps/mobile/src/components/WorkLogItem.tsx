import { View, Text, StyleSheet, Platform } from "react-native";
import { colors, spacing, fontSize } from "../lib/theme";
import type { ThreadActivity } from "../lib/types";

interface WorkLogItemProps {
  activity: ThreadActivity;
}

function toneColor(tone: string): string {
  switch (tone) {
    case "thinking":
      return colors.thinking;
    case "tool":
      return colors.tool;
    case "error":
      return colors.error;
    default:
      return colors.textTertiary;
  }
}

function toneIcon(tone: string): string {
  switch (tone) {
    case "thinking":
      return "\u{1F4AD}";
    case "tool":
      return "\u{1F527}";
    case "error":
      return "\u26A0\uFE0F";
    case "approval":
      return "\u{1F512}";
    default:
      return "\u2022";
  }
}

export function WorkLogItem({ activity }: WorkLogItemProps) {
  const payload =
    activity.payload && typeof activity.payload === "object" ? activity.payload : null;
  const detail = payload && typeof payload.detail === "string" ? payload.detail : null;

  return (
    <View style={styles.container}>
      <Text style={styles.icon}>{toneIcon(activity.tone)}</Text>
      <View style={styles.content}>
        <Text style={[styles.summary, { color: toneColor(activity.tone) }]} numberOfLines={1}>
          {activity.summary}
        </Text>
        {detail && (
          <Text style={styles.detail} numberOfLines={3}>
            {detail.length > 200 ? detail.slice(0, 200) + "..." : detail}
          </Text>
        )}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: spacing.sm,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.xs,
  },
  icon: {
    fontSize: fontSize.xs,
    marginTop: 2,
  },
  content: {
    flex: 1,
    gap: 2,
  },
  summary: {
    fontSize: fontSize.xs,
    fontWeight: "500",
  },
  detail: {
    fontSize: fontSize.xs,
    color: colors.textTertiary,
    fontFamily: Platform.OS === "ios" ? "Menlo" : "monospace",
    lineHeight: 16,
  },
});
