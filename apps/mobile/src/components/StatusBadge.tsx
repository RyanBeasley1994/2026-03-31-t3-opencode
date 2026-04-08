import { View, Text, StyleSheet } from "react-native";
import { colors, fontSize, spacing, borderRadius } from "../lib/theme";

interface StatusBadgeProps {
  status: string;
}

function statusColor(status: string): string {
  switch (status) {
    case "running":
      return colors.success;
    case "ready":
    case "open":
      return colors.accent;
    case "connecting":
    case "reconnecting":
    case "starting":
      return colors.warning;
    case "error":
      return colors.error;
    default:
      return colors.textTertiary;
  }
}

function statusLabel(status: string): string {
  switch (status) {
    case "running":
      return "Running";
    case "ready":
      return "Ready";
    case "open":
      return "Connected";
    case "connecting":
      return "Connecting";
    case "reconnecting":
      return "Reconnecting";
    case "starting":
      return "Starting";
    case "error":
      return "Error";
    case "closed":
      return "Closed";
    case "disposed":
      return "Disconnected";
    default:
      return status;
  }
}

export function StatusBadge({ status }: StatusBadgeProps) {
  const color = statusColor(status);

  return (
    <View style={styles.badge}>
      <View style={[styles.dot, { backgroundColor: color }]} />
      <Text style={[styles.label, { color }]}>{statusLabel(status)}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  badge: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.xs,
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.xs,
    backgroundColor: colors.bgTertiary,
    borderRadius: borderRadius.sm,
  },
  dot: {
    width: 6,
    height: 6,
    borderRadius: 3,
  },
  label: {
    fontSize: fontSize.xs,
    fontWeight: "500",
  },
});
