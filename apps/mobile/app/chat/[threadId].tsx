import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  FlatList,
  StyleSheet,
  KeyboardAvoidingView,
  Platform,
  ActivityIndicator,
} from "react-native";
import { useLocalSearchParams, Stack } from "expo-router";
import * as Haptics from "expo-haptics";
import { useAppStore } from "../../src/lib/appStore";
import { MessageBubble } from "../../src/components/MessageBubble";
import { WorkLogItem } from "../../src/components/WorkLogItem";
import { ApprovalBanner } from "../../src/components/ApprovalBanner";
import { StatusBadge } from "../../src/components/StatusBadge";
import { colors, spacing, fontSize, borderRadius } from "../../src/lib/theme";
import type { ChatMessage, ThreadActivity } from "../../src/lib/types";

type TimelineItem =
  | { kind: "message"; id: string; createdAt: string; message: ChatMessage }
  | { kind: "activity"; id: string; createdAt: string; activity: ThreadActivity };

/**
 * Derive pending approval requests from thread activities,
 * mirroring the logic in apps/web/src/session-logic.ts.
 */
function derivePendingApprovals(
  activities: ReadonlyArray<ThreadActivity>,
): Array<{ requestId: string; requestKind: string; detail?: string }> {
  const open = new Map<string, { requestId: string; requestKind: string; detail?: string }>();

  for (const activity of activities) {
    const payload = activity.payload ?? null;
    const requestId = payload && typeof payload.requestId === "string" ? payload.requestId : null;

    if (activity.kind === "approval.requested" && requestId) {
      const requestKind =
        payload && typeof payload.requestKind === "string" ? payload.requestKind : "command";
      const detail = payload && typeof payload.detail === "string" ? payload.detail : undefined;
      open.set(requestId, { requestId, requestKind, detail });
    } else if (activity.kind === "approval.resolved" && requestId) {
      open.delete(requestId);
    }
  }

  return [...open.values()];
}

export default function ChatScreen() {
  const { threadId } = useLocalSearchParams<{ threadId: string }>();
  const { threads, projects, api } = useAppStore();
  const [inputText, setInputText] = useState("");
  const [sending, setSending] = useState(false);
  const flatListRef = useRef<FlatList>(null);

  const thread = useMemo(() => threads.find((t) => t.id === threadId), [threads, threadId]);
  const project = useMemo(
    () => (thread ? projects.find((p) => p.id === thread.projectId) : null),
    [projects, thread],
  );

  const sessionStatus = thread?.session?.status ?? "closed";
  const isRunning = sessionStatus === "running";

  // Build timeline: interleave messages and relevant activities for the latest turn
  const timeline = useMemo((): TimelineItem[] => {
    if (!thread) return [];

    const items: TimelineItem[] = [];

    for (const message of thread.messages) {
      items.push({ kind: "message", id: message.id, createdAt: message.createdAt, message });
    }

    // Show tool activities for the current/latest turn
    const latestTurnId = thread.latestTurn?.turnId ?? thread.session?.activeTurnId;
    if (latestTurnId) {
      for (const activity of thread.activities) {
        if (activity.turnId !== latestTurnId) continue;
        if (activity.kind === "approval.requested" || activity.kind === "approval.resolved")
          continue;
        if (activity.tone === "tool" || activity.tone === "thinking" || activity.tone === "error") {
          items.push({
            kind: "activity",
            id: activity.id,
            createdAt: activity.createdAt,
            activity,
          });
        }
      }
    }

    return items.toSorted((a, b) => a.createdAt.localeCompare(b.createdAt));
  }, [thread]);

  const pendingApprovals = useMemo(
    () => (thread ? derivePendingApprovals(thread.activities) : []),
    [thread],
  );

  // Auto-scroll to bottom when new items arrive
  useEffect(() => {
    if (timeline.length > 0) {
      setTimeout(() => {
        flatListRef.current?.scrollToEnd({ animated: true });
      }, 100);
    }
  }, [timeline.length]);

  const handleSend = useCallback(async () => {
    const text = inputText.trim();
    if (!text || !api || !threadId) return;

    setSending(true);
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    setInputText("");

    try {
      await api.dispatchCommand({
        _tag: "SendMessage",
        threadId,
        text,
      });
    } catch {
      // Restore input on failure
      setInputText(text);
    } finally {
      setSending(false);
    }
  }, [inputText, api, threadId]);

  const handleCancel = useCallback(async () => {
    if (!api || !threadId) return;
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    try {
      await api.dispatchCommand({ _tag: "CancelTurn", threadId });
    } catch {
      // ignore
    }
  }, [api, threadId]);

  const handleApprove = useCallback(
    async (requestId: string) => {
      if (!api || !threadId) return;
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
      try {
        await api.dispatchCommand({
          _tag: "RespondToApproval",
          threadId,
          requestId,
          approved: true,
        });
      } catch {
        // ignore
      }
    },
    [api, threadId],
  );

  const handleDeny = useCallback(
    async (requestId: string) => {
      if (!api || !threadId) return;
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
      try {
        await api.dispatchCommand({
          _tag: "RespondToApproval",
          threadId,
          requestId,
          approved: false,
        });
      } catch {
        // ignore
      }
    },
    [api, threadId],
  );

  const renderItem = useCallback(({ item }: { item: TimelineItem }) => {
    if (item.kind === "message") {
      return <MessageBubble message={item.message} />;
    }
    return <WorkLogItem activity={item.activity} />;
  }, []);

  if (!thread) {
    return (
      <View style={styles.centered}>
        <Text style={styles.errorText}>Thread not found</Text>
      </View>
    );
  }

  return (
    <>
      <Stack.Screen
        options={{
          title: thread.title || "Chat",
          headerRight: () => <StatusBadge status={sessionStatus} />,
        }}
      />
      <KeyboardAvoidingView
        style={styles.container}
        behavior={Platform.OS === "ios" ? "padding" : "height"}
        keyboardVerticalOffset={Platform.OS === "ios" ? 96 : 0}
      >
        {/* Project info bar */}
        <View style={styles.infoBar}>
          <Text style={styles.infoText} numberOfLines={1}>
            {project?.name ?? "Unknown Project"}
            {thread.branch ? ` \u00b7 ${thread.branch}` : ""}
            {` \u00b7 ${thread.modelSelection.model}`}
          </Text>
        </View>

        {/* Messages timeline */}
        <FlatList
          ref={flatListRef}
          data={timeline}
          keyExtractor={(item) => item.id}
          renderItem={renderItem}
          contentContainerStyle={styles.messageList}
          keyboardDismissMode="interactive"
          keyboardShouldPersistTaps="handled"
        />

        {/* Pending approvals */}
        {pendingApprovals.map((approval) => (
          <ApprovalBanner
            key={approval.requestId}
            requestId={approval.requestId}
            detail={approval.detail}
            requestKind={approval.requestKind}
            onApprove={handleApprove}
            onDeny={handleDeny}
          />
        ))}

        {/* Running indicator */}
        {isRunning && pendingApprovals.length === 0 && (
          <View style={styles.runningBar}>
            <ActivityIndicator size="small" color={colors.accent} />
            <Text style={styles.runningText}>Agent is working...</Text>
            <TouchableOpacity
              onPress={handleCancel}
              style={styles.cancelButton}
              activeOpacity={0.7}
            >
              <Text style={styles.cancelText}>Cancel</Text>
            </TouchableOpacity>
          </View>
        )}

        {/* Composer */}
        <View style={styles.composer}>
          <TextInput
            style={styles.input}
            value={inputText}
            onChangeText={setInputText}
            placeholder={isRunning ? "Agent is working..." : "Send a message..."}
            placeholderTextColor={colors.textTertiary}
            multiline
            maxLength={32_000}
            editable={!isRunning}
            returnKeyType="default"
          />
          <TouchableOpacity
            style={[
              styles.sendButton,
              (!inputText.trim() || sending || isRunning) && styles.sendButtonDisabled,
            ]}
            onPress={handleSend}
            disabled={!inputText.trim() || sending || isRunning}
            activeOpacity={0.7}
          >
            <Text style={styles.sendIcon}>{"\u2191"}</Text>
          </TouchableOpacity>
        </View>
      </KeyboardAvoidingView>
    </>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.bg,
  },
  centered: {
    flex: 1,
    justifyContent: "center",
    alignItems: "center",
  },
  errorText: {
    fontSize: fontSize.md,
    color: colors.error,
  },
  infoBar: {
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
    backgroundColor: colors.bgSecondary,
  },
  infoText: {
    fontSize: fontSize.xs,
    color: colors.textTertiary,
  },
  messageList: {
    paddingVertical: spacing.sm,
    flexGrow: 1,
  },
  runningBar: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm,
    backgroundColor: colors.bgSecondary,
    borderTopWidth: 1,
    borderTopColor: colors.border,
  },
  runningText: {
    flex: 1,
    fontSize: fontSize.sm,
    color: colors.textSecondary,
  },
  cancelButton: {
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.xs,
    backgroundColor: colors.bgTertiary,
    borderRadius: borderRadius.sm,
    borderWidth: 1,
    borderColor: colors.border,
  },
  cancelText: {
    fontSize: fontSize.xs,
    color: colors.error,
    fontWeight: "600",
  },
  composer: {
    flexDirection: "row",
    alignItems: "flex-end",
    gap: spacing.sm,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
    borderTopWidth: 1,
    borderTopColor: colors.border,
    backgroundColor: colors.bgSecondary,
  },
  input: {
    flex: 1,
    backgroundColor: colors.bgTertiary,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: borderRadius.lg,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
    fontSize: fontSize.md,
    color: colors.text,
    maxHeight: 120,
    minHeight: 40,
  },
  sendButton: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: colors.accent,
    alignItems: "center",
    justifyContent: "center",
  },
  sendButtonDisabled: {
    backgroundColor: colors.bgTertiary,
  },
  sendIcon: {
    fontSize: fontSize.lg,
    fontWeight: "700",
    color: "#fff",
  },
});
