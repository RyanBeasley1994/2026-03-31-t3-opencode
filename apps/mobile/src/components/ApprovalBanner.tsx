import { View, Text, TouchableOpacity, StyleSheet } from "react-native";
import { colors, spacing, fontSize, borderRadius } from "../lib/theme";

interface ApprovalBannerProps {
  requestId: string;
  detail?: string;
  requestKind: string;
  onApprove: (requestId: string) => void;
  onDeny: (requestId: string) => void;
}

export function ApprovalBanner({
  requestId,
  detail,
  requestKind,
  onApprove,
  onDeny,
}: ApprovalBannerProps) {
  const kindLabel =
    requestKind === "command"
      ? "Command execution"
      : requestKind === "file-change"
        ? "File modification"
        : requestKind === "file-read"
          ? "File access"
          : "Action";

  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <Text style={styles.title}>Approval Required</Text>
        <Text style={styles.kind}>{kindLabel}</Text>
      </View>
      {detail && (
        <Text style={styles.detail} numberOfLines={4}>
          {detail}
        </Text>
      )}
      <View style={styles.actions}>
        <TouchableOpacity
          style={[styles.button, styles.denyButton]}
          onPress={() => onDeny(requestId)}
          activeOpacity={0.7}
        >
          <Text style={styles.denyText}>Deny</Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={[styles.button, styles.approveButton]}
          onPress={() => onApprove(requestId)}
          activeOpacity={0.7}
        >
          <Text style={styles.approveText}>Approve</Text>
        </TouchableOpacity>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    marginHorizontal: spacing.lg,
    marginVertical: spacing.sm,
    backgroundColor: colors.bgElevated,
    borderRadius: borderRadius.md,
    borderWidth: 1,
    borderColor: colors.warning,
    padding: spacing.lg,
    gap: spacing.sm,
  },
  header: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
  },
  title: {
    fontSize: fontSize.sm,
    fontWeight: "700",
    color: colors.warning,
  },
  kind: {
    fontSize: fontSize.xs,
    color: colors.textTertiary,
  },
  detail: {
    fontSize: fontSize.sm,
    color: colors.textSecondary,
    fontFamily: "Menlo",
    lineHeight: 18,
  },
  actions: {
    flexDirection: "row",
    gap: spacing.sm,
    marginTop: spacing.xs,
  },
  button: {
    flex: 1,
    paddingVertical: spacing.sm,
    borderRadius: borderRadius.sm,
    alignItems: "center",
  },
  denyButton: {
    backgroundColor: colors.bgTertiary,
    borderWidth: 1,
    borderColor: colors.border,
  },
  approveButton: {
    backgroundColor: colors.success,
  },
  denyText: {
    fontSize: fontSize.sm,
    fontWeight: "600",
    color: colors.textSecondary,
  },
  approveText: {
    fontSize: fontSize.sm,
    fontWeight: "600",
    color: "#fff",
  },
});
