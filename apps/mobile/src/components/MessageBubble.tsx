import { View, Text, StyleSheet } from "react-native";
import { colors, spacing, fontSize, borderRadius } from "../lib/theme";
import type { ChatMessage } from "../lib/types";

interface MessageBubbleProps {
  message: ChatMessage;
}

export function MessageBubble({ message }: MessageBubbleProps) {
  const isUser = message.role === "user";
  const isSystem = message.role === "system";

  return (
    <View style={[styles.container, isUser && styles.containerUser]}>
      <View style={[styles.bubble, isUser && styles.bubbleUser, isSystem && styles.bubbleSystem]}>
        {!isUser && <Text style={styles.roleLabel}>{isSystem ? "System" : "Assistant"}</Text>}
        <Text
          style={[styles.text, isUser && styles.textUser, isSystem && styles.textSystem]}
          selectable
        >
          {message.text}
        </Text>
        {message.streaming && (
          <View style={styles.streamingIndicator}>
            <Text style={styles.streamingDot}>{"\u25CF"}</Text>
          </View>
        )}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.xs,
    alignItems: "flex-start",
  },
  containerUser: {
    alignItems: "flex-end",
  },
  bubble: {
    maxWidth: "85%",
    backgroundColor: colors.bgTertiary,
    borderRadius: borderRadius.lg,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
    borderWidth: 1,
    borderColor: colors.border,
  },
  bubbleUser: {
    backgroundColor: colors.accentDim,
    borderColor: colors.accent,
  },
  bubbleSystem: {
    backgroundColor: colors.bgSecondary,
    borderColor: colors.border,
    borderStyle: "dashed",
  },
  roleLabel: {
    fontSize: fontSize.xs,
    fontWeight: "600",
    color: colors.textTertiary,
    marginBottom: spacing.xs,
    textTransform: "uppercase",
    letterSpacing: 0.5,
  },
  text: {
    fontSize: fontSize.md,
    color: colors.text,
    lineHeight: 22,
  },
  textUser: {
    color: "#fff",
  },
  textSystem: {
    color: colors.textSecondary,
    fontStyle: "italic",
  },
  streamingIndicator: {
    marginTop: spacing.xs,
  },
  streamingDot: {
    fontSize: 8,
    color: colors.accent,
  },
});
