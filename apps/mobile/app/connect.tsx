import { useState } from "react";
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  StyleSheet,
  KeyboardAvoidingView,
  Platform,
  Alert,
} from "react-native";
import { router } from "expo-router";
import { useConnectionStore } from "../src/lib/connectionStore";
import { useAppStore } from "../src/lib/appStore";
import { colors, spacing, fontSize, borderRadius } from "../src/lib/theme";

export default function ConnectScreen() {
  const { serverUrl: savedUrl, authToken: savedToken, save } = useConnectionStore();
  const { connect } = useAppStore();

  const [url, setUrl] = useState(savedUrl || "http://");
  const [token, setToken] = useState(savedToken);
  const [connecting, setConnecting] = useState(false);

  const handleConnect = async () => {
    const trimmedUrl = url.trim();
    if (trimmedUrl.length === 0) {
      Alert.alert("Error", "Please enter a server URL");
      return;
    }

    // Derive WebSocket URL from HTTP URL
    let wsUrl: string;
    try {
      const parsed = new URL(trimmedUrl);
      const wsProtocol = parsed.protocol === "https:" ? "wss:" : "ws:";
      wsUrl = `${wsProtocol}//${parsed.host}`;
      if (token.trim().length > 0) {
        wsUrl += `?token=${encodeURIComponent(token.trim())}`;
      }
    } catch {
      Alert.alert("Error", "Invalid URL format");
      return;
    }

    setConnecting(true);
    try {
      await save({ serverUrl: wsUrl, authToken: token.trim() });
      connect(wsUrl);
      router.replace("/sessions");
    } catch {
      Alert.alert("Error", "Failed to save connection settings");
    } finally {
      setConnecting(false);
    }
  };

  return (
    <KeyboardAvoidingView
      style={styles.container}
      behavior={Platform.OS === "ios" ? "padding" : "height"}
    >
      <View style={styles.content}>
        <View style={styles.header}>
          <Text style={styles.title}>T3 Code</Text>
          <Text style={styles.subtitle}>Connect to your remote server</Text>
        </View>

        <View style={styles.form}>
          <View style={styles.field}>
            <Text style={styles.label}>Server URL</Text>
            <TextInput
              style={styles.input}
              value={url}
              onChangeText={setUrl}
              placeholder="http://192.168.1.42:3773"
              placeholderTextColor={colors.textTertiary}
              autoCapitalize="none"
              autoCorrect={false}
              keyboardType="url"
              returnKeyType="next"
            />
            <Text style={styles.hint}>Your T3 Code server address (IP or hostname with port)</Text>
          </View>

          <View style={styles.field}>
            <Text style={styles.label}>Auth Token (optional)</Text>
            <TextInput
              style={styles.input}
              value={token}
              onChangeText={setToken}
              placeholder="Token from --auth-token flag"
              placeholderTextColor={colors.textTertiary}
              autoCapitalize="none"
              autoCorrect={false}
              secureTextEntry
              returnKeyType="go"
              onSubmitEditing={handleConnect}
            />
            <Text style={styles.hint}>Required if the server was started with --auth-token</Text>
          </View>

          <TouchableOpacity
            style={[styles.button, connecting && styles.buttonDisabled]}
            onPress={handleConnect}
            disabled={connecting}
            activeOpacity={0.7}
          >
            <Text style={styles.buttonText}>{connecting ? "Connecting..." : "Connect"}</Text>
          </TouchableOpacity>
        </View>
      </View>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.bg,
  },
  content: {
    flex: 1,
    justifyContent: "center",
    paddingHorizontal: spacing.xl,
  },
  header: {
    alignItems: "center",
    marginBottom: spacing.xxl,
  },
  title: {
    fontSize: fontSize.xxl,
    fontWeight: "700",
    color: colors.text,
    marginBottom: spacing.sm,
  },
  subtitle: {
    fontSize: fontSize.md,
    color: colors.textSecondary,
  },
  form: {
    gap: spacing.lg,
  },
  field: {
    gap: spacing.xs,
  },
  label: {
    fontSize: fontSize.sm,
    fontWeight: "600",
    color: colors.text,
    marginBottom: spacing.xs,
  },
  input: {
    backgroundColor: colors.bgTertiary,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: borderRadius.md,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
    fontSize: fontSize.md,
    color: colors.text,
  },
  hint: {
    fontSize: fontSize.xs,
    color: colors.textTertiary,
    marginTop: spacing.xs,
  },
  button: {
    backgroundColor: colors.accent,
    borderRadius: borderRadius.md,
    paddingVertical: spacing.md + 2,
    alignItems: "center",
    marginTop: spacing.sm,
  },
  buttonDisabled: {
    opacity: 0.6,
  },
  buttonText: {
    fontSize: fontSize.md,
    fontWeight: "600",
    color: "#fff",
  },
});
