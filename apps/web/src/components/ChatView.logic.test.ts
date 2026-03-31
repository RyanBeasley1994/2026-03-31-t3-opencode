import { ApprovalRequestId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vitest";

import {
  buildNextTextGenerationModelSelection,
  buildProviderModelOptionsWithRememberedSelections,
  buildNextProviderModelSelection,
  buildExpiredTerminalContextToastCopy,
  canAdvancePendingUserInput,
  derivePendingComposerPromptState,
  deriveComposerSendState,
  derivePendingPromptOwnershipTransition,
  resolveProviderForModelPickerChange,
  isComposerPromptDisabled,
  shouldRenderTextGenerationTraitsControl,
  reconcileRespondingUserInputRequestIds,
} from "./ChatView.logic";

describe("deriveComposerSendState", () => {
  it("treats expired terminal pills as non-sendable content", () => {
    const state = deriveComposerSendState({
      prompt: "\uFFFC",
      imageCount: 0,
      terminalContexts: [
        {
          id: "ctx-expired",
          threadId: ThreadId.makeUnsafe("thread-1"),
          terminalId: "default",
          terminalLabel: "Terminal 1",
          lineStart: 4,
          lineEnd: 4,
          text: "",
          createdAt: "2026-03-17T12:52:29.000Z",
        },
      ],
    });

    expect(state.trimmedPrompt).toBe("");
    expect(state.sendableTerminalContexts).toEqual([]);
    expect(state.expiredTerminalContextCount).toBe(1);
    expect(state.hasSendableContent).toBe(false);
  });

  it("keeps text sendable while excluding expired terminal pills", () => {
    const state = deriveComposerSendState({
      prompt: `yoo \uFFFC waddup`,
      imageCount: 0,
      terminalContexts: [
        {
          id: "ctx-expired",
          threadId: ThreadId.makeUnsafe("thread-1"),
          terminalId: "default",
          terminalLabel: "Terminal 1",
          lineStart: 4,
          lineEnd: 4,
          text: "",
          createdAt: "2026-03-17T12:52:29.000Z",
        },
      ],
    });

    expect(state.trimmedPrompt).toBe("yoo  waddup");
    expect(state.expiredTerminalContextCount).toBe(1);
    expect(state.hasSendableContent).toBe(true);
  });
});

describe("buildExpiredTerminalContextToastCopy", () => {
  it("formats clear empty-state guidance", () => {
    expect(buildExpiredTerminalContextToastCopy(1, "empty")).toEqual({
      title: "Expired terminal context won't be sent",
      description: "Remove it or re-add it to include terminal output.",
    });
  });

  it("formats omission guidance for sent messages", () => {
    expect(buildExpiredTerminalContextToastCopy(2, "omitted")).toEqual({
      title: "Expired terminal contexts omitted from message",
      description: "Re-add it if you want that terminal output included.",
    });
  });
});

describe("canAdvancePendingUserInput", () => {
  it("blocks advancement while a pending user-input response is in flight", () => {
    expect(
      canAdvancePendingUserInput({
        hasProgress: true,
        isResponding: true,
        canAdvance: true,
        isLastQuestion: false,
        hasResolvedAnswers: false,
      }),
    ).toBe(false);
  });

  it("blocks advancement when the current question is unanswered", () => {
    expect(
      canAdvancePendingUserInput({
        hasProgress: true,
        isResponding: false,
        canAdvance: false,
        isLastQuestion: false,
        hasResolvedAnswers: false,
      }),
    ).toBe(false);
  });

  it("blocks submit on the last question until all answers are resolved", () => {
    expect(
      canAdvancePendingUserInput({
        hasProgress: true,
        isResponding: false,
        canAdvance: true,
        isLastQuestion: true,
        hasResolvedAnswers: false,
      }),
    ).toBe(false);
  });

  it("allows advancement only when the pending user-input state is ready", () => {
    expect(
      canAdvancePendingUserInput({
        hasProgress: true,
        isResponding: false,
        canAdvance: true,
        isLastQuestion: false,
        hasResolvedAnswers: false,
      }),
    ).toBe(true);
    expect(
      canAdvancePendingUserInput({
        hasProgress: true,
        isResponding: false,
        canAdvance: true,
        isLastQuestion: true,
        hasResolvedAnswers: true,
      }),
    ).toBe(true);
  });
});

describe("reconcileRespondingUserInputRequestIds", () => {
  it("keeps responding request ids while they still appear in pending prompts", () => {
    expect(
      reconcileRespondingUserInputRequestIds(
        [ApprovalRequestId.makeUnsafe("request-1"), ApprovalRequestId.makeUnsafe("request-2")],
        [
          { requestId: ApprovalRequestId.makeUnsafe("request-1") },
          { requestId: ApprovalRequestId.makeUnsafe("request-3") },
        ],
      ),
    ).toEqual([ApprovalRequestId.makeUnsafe("request-1")]);
  });

  it("clears responding request ids once the pending prompt disappears", () => {
    expect(
      reconcileRespondingUserInputRequestIds(
        [ApprovalRequestId.makeUnsafe("request-1")],
        [{ requestId: ApprovalRequestId.makeUnsafe("request-2") }],
      ),
    ).toEqual([]);
  });

  it("clears responding request ids after retryable respond failures while the prompt stays pending", () => {
    expect(
      reconcileRespondingUserInputRequestIds(
        [ApprovalRequestId.makeUnsafe("request-1"), ApprovalRequestId.makeUnsafe("request-2")],
        [{ requestId: ApprovalRequestId.makeUnsafe("request-1") }],
        [ApprovalRequestId.makeUnsafe("request-1")],
      ),
    ).toEqual([]);
  });
});

describe("derivePendingComposerPromptState", () => {
  it("syncs the draft prompt to the active pending custom answer", () => {
    expect(
      derivePendingComposerPromptState({
        draftPrompt: "stale draft",
        promptRefValue: "stale ref",
        pendingPromptOwnership: "active",
        activePendingCustomAnswer: "fresh pending answer",
      }),
    ).toEqual({
      nextPrompt: "fresh pending answer",
      shouldSyncDraftPrompt: true,
      shouldSyncPromptRef: true,
    });
  });

  it("clears stale hidden prompt state when pending user-input flow ends", () => {
    expect(
      derivePendingComposerPromptState({
        draftPrompt: "stale draft",
        promptRefValue: "stale ref",
        pendingPromptOwnership: "released",
        activePendingCustomAnswer: null,
      }),
    ).toEqual({
      nextPrompt: "",
      shouldSyncDraftPrompt: true,
      shouldSyncPromptRef: true,
    });
  });

  it("does not clear the ordinary composer draft when pending input is inactive", () => {
    expect(
      derivePendingComposerPromptState({
        draftPrompt: "ordinary draft text",
        promptRefValue: "ordinary draft text",
        pendingPromptOwnership: "inactive",
        activePendingCustomAnswer: null,
      }),
    ).toEqual({
      nextPrompt: "ordinary draft text",
      shouldSyncDraftPrompt: false,
      shouldSyncPromptRef: false,
    });
  });
});

describe("derivePendingPromptOwnershipTransition", () => {
  it("returns to inactive after released pending-input cleanup completes", () => {
    expect(
      derivePendingPromptOwnershipTransition({
        hasActivePendingProgress: false,
        lastSyncedPendingInput: null,
      }),
    ).toEqual({
      ownership: "inactive",
      nextLastSyncedPendingInput: null,
    });
    expect(
      derivePendingPromptOwnershipTransition({
        hasActivePendingProgress: false,
        lastSyncedPendingInput: {
          requestId: null,
          questionId: null,
        },
      }),
    ).toEqual({
      ownership: "inactive",
      nextLastSyncedPendingInput: null,
    });
  });

  it("treats a real prior pending-input marker as released until cleanup runs", () => {
    expect(
      derivePendingPromptOwnershipTransition({
        hasActivePendingProgress: false,
        lastSyncedPendingInput: {
          requestId: "req-1",
          questionId: "question-1",
        },
      }),
    ).toEqual({
      ownership: "released",
      nextLastSyncedPendingInput: null,
    });
  });
});

describe("isComposerPromptDisabled", () => {
  it("disables the composer while a pending user-input response is in flight", () => {
    expect(
      isComposerPromptDisabled({
        isConnecting: false,
        isComposerApprovalState: false,
        activePendingIsResponding: true,
      }),
    ).toBe(true);
  });

  it("keeps the existing disabled conditions intact", () => {
    expect(
      isComposerPromptDisabled({
        isConnecting: true,
        isComposerApprovalState: false,
        activePendingIsResponding: false,
      }),
    ).toBe(true);
    expect(
      isComposerPromptDisabled({
        isConnecting: false,
        isComposerApprovalState: true,
        activePendingIsResponding: false,
      }),
    ).toBe(true);
    expect(
      isComposerPromptDisabled({
        isConnecting: false,
        isComposerApprovalState: false,
        activePendingIsResponding: false,
      }),
    ).toBe(false);
  });
});

describe("buildNextProviderModelSelection", () => {
  it("preserves same-provider options when switching models in the picker", () => {
    expect(
      buildNextProviderModelSelection({
        provider: "claudeAgent",
        model: "claude-sonnet-4-6",
        existingSelection: {
          provider: "claudeAgent",
          model: "claude-opus-4-6",
          options: { effort: "max" },
        },
      }),
    ).toEqual({
      provider: "claudeAgent",
      model: "claude-sonnet-4-6",
      options: { effort: "max" },
    });
  });

  it("does not copy options from a different provider", () => {
    expect(
      buildNextProviderModelSelection({
        provider: "opencode",
        model: "openai/gpt-5.4",
        existingSelection: {
          provider: "claudeAgent",
          model: "claude-opus-4-6",
          options: { effort: "max" },
        },
      }),
    ).toEqual({
      provider: "opencode",
      model: "openai/gpt-5.4",
    });
  });

  it("preserves options from the actual same-provider selection instead of a cross-provider effective selection", () => {
    expect(
      buildNextProviderModelSelection({
        provider: "claudeAgent",
        model: "claude-sonnet-4-6",
        existingSelection: {
          provider: "codex",
          model: "gpt-5-codex",
          options: { reasoningEffort: "high" },
        },
        sameProviderSelection: {
          provider: "claudeAgent",
          model: "claude-opus-4-6",
          options: { effort: "max" },
        },
      }),
    ).toEqual({
      provider: "claudeAgent",
      model: "claude-sonnet-4-6",
      options: { effort: "max" },
    });
  });
});

describe("resolveProviderForModelPickerChange", () => {
  it("keeps locked-provider changes on the locked provider even if it is currently unavailable", () => {
    expect(
      resolveProviderForModelPickerChange({
        requestedProvider: "claudeAgent",
        lockedProvider: "claudeAgent",
        selectableProvider: "codex",
      }),
    ).toBe("claudeAgent");
  });

  it("uses the selectable provider when the picker is unlocked", () => {
    expect(
      resolveProviderForModelPickerChange({
        requestedProvider: "claudeAgent",
        lockedProvider: null,
        selectableProvider: "codex",
      }),
    ).toBe("codex");
  });
});

describe("buildNextTextGenerationModelSelection", () => {
  it("preserves same-provider text-generation options on model-only changes", () => {
    expect(
      buildNextTextGenerationModelSelection({
        provider: "claudeAgent",
        model: "claude-sonnet-4-6",
        existingSelection: {
          provider: "claudeAgent",
          model: "claude-opus-4-6",
          options: { effort: "max" },
        },
      }),
    ).toEqual({
      provider: "claudeAgent",
      model: "claude-sonnet-4-6",
      options: { effort: "max" },
    });
  });

  it("drops text-generation options when switching providers", () => {
    expect(
      buildNextTextGenerationModelSelection({
        provider: "opencode",
        model: "openai/gpt-5.4",
        existingSelection: {
          provider: "claudeAgent",
          model: "claude-opus-4-6",
          options: { effort: "max" },
        },
      }),
    ).toEqual({
      provider: "opencode",
      model: "openai/gpt-5.4",
    });
  });
});

describe("buildProviderModelOptionsWithRememberedSelections", () => {
  it("includes remembered same-provider models for non-active providers", () => {
    expect(
      buildProviderModelOptionsWithRememberedSelections({
        baseOptionsByProvider: {
          codex: [{ slug: "gpt-5-codex", name: "GPT-5 Codex" }],
          claudeAgent: [{ slug: "claude-opus-4-6", name: "Claude Opus 4.6" }],
          opencode: [{ slug: "openai/gpt-5.4", name: "GPT-5.4" }],
        },
        rememberedSelectionsByProvider: {
          codex: { provider: "codex", model: "gpt-5.3-codex-spark" },
          claudeAgent: { provider: "claudeAgent", model: "claude-custom-unsaved" },
        },
      }).claudeAgent,
    ).toEqual([
      { slug: "claude-opus-4-6", name: "Claude Opus 4.6" },
      { slug: "claude-custom-unsaved", name: "claude-custom-unsaved" },
    ]);
  });
});

describe("shouldRenderTextGenerationTraitsControl", () => {
  it("hides the traits control for providers with no traits UI", () => {
    expect(shouldRenderTextGenerationTraitsControl("opencode")).toBe(false);
  });

  it("keeps the traits control for providers that support it", () => {
    expect(shouldRenderTextGenerationTraitsControl("codex")).toBe(true);
    expect(shouldRenderTextGenerationTraitsControl("claudeAgent")).toBe(true);
  });
});
