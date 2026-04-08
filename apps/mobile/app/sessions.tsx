import { useMemo } from "react";
import {
  View,
  Text,
  FlatList,
  TouchableOpacity,
  StyleSheet,
  ActivityIndicator,
} from "react-native";
import { router, Stack } from "expo-router";
import { useAppStore } from "../src/lib/appStore";
import { useConnectionStore } from "../src/lib/connectionStore";
import { StatusBadge } from "../src/components/StatusBadge";
import { colors, spacing, fontSize, borderRadius } from "../src/lib/theme";
import type { Thread, Project } from "../src/lib/types";

interface ThreadWithProject extends Thread {
  projectName: string;
}

function ThreadRow({ item }: { item: ThreadWithProject }) {
  const sessionStatus = item.session?.status ?? "closed";
  const lastMessage = item.messages.at(-1);
  const preview = lastMessage
    ? lastMessage.text.length > 100
      ? lastMessage.text.slice(0, 100) + "..."
      : lastMessage.text
    : "No messages yet";

  return (
    <TouchableOpacity
      style={styles.threadRow}
      onPress={() => router.push(`/chat/${item.id}`)}
      activeOpacity={0.7}
    >
      <View style={styles.threadHeader}>
        <View style={styles.threadTitleRow}>
          <Text style={styles.threadTitle} numberOfLines={1}>
            {item.title || "Untitled"}
          </Text>
          <StatusBadge status={sessionStatus} />
        </View>
        <Text style={styles.projectLabel} numberOfLines={1}>
          {item.projectName}
          {item.branch ? ` \u00b7 ${item.branch}` : ""}
        </Text>
      </View>
      <Text style={styles.threadPreview} numberOfLines={2}>
        {preview}
      </Text>
      <Text style={styles.threadTime}>{formatRelativeTime(item.updatedAt ?? item.createdAt)}</Text>
    </TouchableOpacity>
  );
}

function formatRelativeTime(isoDate: string): string {
  const now = Date.now();
  const then = Date.parse(isoDate);
  if (Number.isNaN(then)) return "";

  const diffMs = now - then;
  const minutes = Math.floor(diffMs / 60_000);
  if (minutes < 1) return "Just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

export default function SessionsScreen() {
  const { projects, threads, hydrated, transportState, disconnect } = useAppStore();
  const clearConnection = useConnectionStore((s) => s.clear);

  const projectMap = useMemo(() => {
    const map = new Map<string, Project>();
    for (const project of projects) {
      map.set(project.id, project);
    }
    return map;
  }, [projects]);

  const sortedThreads = useMemo((): ThreadWithProject[] => {
    return threads
      .filter((t) => t.archivedAt === null)
      .map((t): ThreadWithProject => {
        const result: ThreadWithProject = Object.assign({}, t, {
          projectName: projectMap.get(t.projectId)?.name ?? "Unknown Project",
        });
        return result;
      })
      .toSorted((a, b) => {
        const aTime = a.updatedAt ?? a.createdAt;
        const bTime = b.updatedAt ?? b.createdAt;
        return bTime.localeCompare(aTime);
      });
  }, [threads, projectMap]);

  const isConnected = transportState === "open";
  const isConnecting = transportState === "connecting" || transportState === "reconnecting";

  const handleDisconnect = async () => {
    disconnect();
    await clearConnection();
    router.replace("/connect");
  };

  return (
    <>
      <Stack.Screen
        options={{
          title: "Sessions",
          headerRight: () => (
            <View style={styles.headerRight}>
              <StatusBadge status={transportState} />
              <TouchableOpacity onPress={handleDisconnect} hitSlop={8}>
                <Text style={styles.disconnectText}>Disconnect</Text>
              </TouchableOpacity>
            </View>
          ),
        }}
      />
      <View style={styles.container}>
        {!hydrated && isConnecting ? (
          <View style={styles.centered}>
            <ActivityIndicator size="large" color={colors.accent} />
            <Text style={styles.loadingText}>Connecting to server...</Text>
          </View>
        ) : !hydrated && !isConnected ? (
          <View style={styles.centered}>
            <Text style={styles.errorText}>Unable to connect</Text>
            <TouchableOpacity style={styles.retryButton} onPress={handleDisconnect}>
              <Text style={styles.retryButtonText}>Change Server</Text>
            </TouchableOpacity>
          </View>
        ) : sortedThreads.length === 0 ? (
          <View style={styles.centered}>
            <Text style={styles.emptyText}>No active sessions</Text>
            <Text style={styles.emptySubtext}>Start a new conversation from the web interface</Text>
          </View>
        ) : (
          <FlatList
            data={sortedThreads}
            keyExtractor={(item) => item.id}
            renderItem={({ item }) => <ThreadRow item={item} />}
            contentContainerStyle={styles.list}
            ItemSeparatorComponent={() => <View style={styles.separator} />}
          />
        )}
      </View>
    </>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.bg,
  },
  headerRight: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.md,
  },
  disconnectText: {
    fontSize: fontSize.sm,
    color: colors.error,
    fontWeight: "500",
  },
  centered: {
    flex: 1,
    justifyContent: "center",
    alignItems: "center",
    paddingHorizontal: spacing.xl,
  },
  loadingText: {
    fontSize: fontSize.md,
    color: colors.textSecondary,
    marginTop: spacing.lg,
  },
  errorText: {
    fontSize: fontSize.lg,
    color: colors.error,
    fontWeight: "600",
    marginBottom: spacing.md,
  },
  retryButton: {
    backgroundColor: colors.bgTertiary,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: borderRadius.md,
    paddingHorizontal: spacing.xl,
    paddingVertical: spacing.md,
  },
  retryButtonText: {
    fontSize: fontSize.md,
    color: colors.accent,
    fontWeight: "500",
  },
  emptyText: {
    fontSize: fontSize.lg,
    color: colors.textSecondary,
    fontWeight: "600",
  },
  emptySubtext: {
    fontSize: fontSize.sm,
    color: colors.textTertiary,
    marginTop: spacing.sm,
    textAlign: "center",
  },
  list: {
    paddingTop: spacing.sm,
  },
  separator: {
    height: 1,
    backgroundColor: colors.border,
    marginHorizontal: spacing.lg,
  },
  threadRow: {
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
    gap: spacing.xs,
  },
  threadHeader: {
    gap: 2,
  },
  threadTitleRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: spacing.sm,
  },
  threadTitle: {
    fontSize: fontSize.md,
    fontWeight: "600",
    color: colors.text,
    flex: 1,
  },
  projectLabel: {
    fontSize: fontSize.xs,
    color: colors.textTertiary,
  },
  threadPreview: {
    fontSize: fontSize.sm,
    color: colors.textSecondary,
    lineHeight: 18,
  },
  threadTime: {
    fontSize: fontSize.xs,
    color: colors.textTertiary,
  },
});
